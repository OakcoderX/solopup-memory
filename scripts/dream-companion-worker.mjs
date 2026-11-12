/** Opt-in child plugin. The parent launches a fresh, network-denied DSH process for one batch. */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, linkSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { encodeFrame, readFrames } from './dream-companion-wire.mjs'

export const name = 'solopup-dream-companion-worker'
export const inject = ['agents', 'llm', 'systemPrompt', 'workingDirectory', 'tools', 'sessionPersistence']
const PROVIDER = 'solopup-dream-pipe'
const digest = text => createHash('sha256').update(text).digest('hex')

async function checkIsolation(root) {
  const base = dirname(root)
  const input = join(base, 'boundary', 'allowed.txt')
  const outside = join(base, 'outside', 'blocked.txt')
  const denied = action => {
    try { action() } catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return; throw error }
    throw Error('dream-companion-worker-isolation-failed')
  }
  if (lstatSync(input).nlink !== 1 || readFileSync(input, 'utf8') !== 'solopup-companion-read-canary') throw Error('dream-companion-bad-canary')
  denied(() => readFileSync(outside))
  const dataVolumeAlias = join('/System/Volumes/Data', outside)
  denied(() => readFileSync(dataVolumeAlias))
  denied(() => readFileSync(join(base, 'boundary', 'outside-link')))
  denied(() => linkSync(outside, join(root, 'hardlink-canary')))
  denied(() => writeFileSync(input, 'write-canary'))
  await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 1 })
    socket.once('connect', () => { socket.destroy(); reject(Error('dream-companion-network-available')) })
    socket.once('error', error => ['EPERM', 'EACCES'].includes(error.code) ? resolve() : reject(error))
  })
}

async function runWorker(ctx, root, bundle, envelope, pipe, signal) {
  const { Store, Engine, DshExecutor, Sessions } = await import(pathToFileURL(bundle).href)
  const store = new Store(join(root, 'engine.sqlite'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const effectsQueue = [], handlers = new Map(), handles = []
  let engine, executor, sessions, candidate, worker, ticketId, invocation = false
  const effects = {
    handle: (kind, handler) => handlers.set(kind, handler),
    enqueue: (kind, _id, payload) => effectsQueue.push({ kind, payload }),
    pending: () => false,
    idle: async () => {},
  }
  const syntheticRoute = { provider: PROVIDER, model: 'bound-review' }
  const evidence = JSON.stringify(envelope.messages)
  const provider = {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    listModels: async () => [], resolveModel: async (providerId, model) => ({ provider: providerId, id: model, name: model }),
    async prepareCall(providerId, model) { return { model: await this.resolveModel(providerId, model), stream: options => this.stream(options) } },
    async *stream(options) {
      signal.throwIfAborted()
      if (invocation || options.sessionId !== `worker-${ticketId}` || !store.tickets.get(ticketId) ||
          !JSON.stringify([options.system, options.messages]).includes(JSON.stringify(evidence).slice(1, -1))) {
        throw Error('dream-companion-worker-model-binding')
      }
      invocation = true
      const output = await pipe.model({ ticketId, workerSessionId: options.sessionId })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: output }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  ctx.llm.registerAdapter([PROVIDER], provider)
  const overrides = {
    sessionController: {
      resolveAgent: async id => ctx.agents.get(id) ? { agent: ctx.agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => {
        signal.throwIfAborted()
        if (sessionId !== `worker-${ticketId}`) throw Error('dream-companion-worker-session-binding')
        const handle = await ctx.agents.create({ sessionId, meta: { cwd: workspace }, agentOptions: syntheticRoute,
          setup: async scoped => {
            scoped.on('agent/pre-step', async (payload, next) => {
              if (signal.aborted || payload.agent.session.id !== sessionId || !store.tickets.get(ticketId)) return { kind: 'reject' }
              await checkIsolation(root)
              return next()
            })
            scoped.systemPrompt.context({ name: 'dream-companion-evidence', order: 40, required: true, interpolate: false, text: () => evidence })
            scoped.tools.restrict({ allow: [] })
          } })
        worker = handle.agent
        handles.push(handle)
      },
      rename: async () => {},
    },
    workspaceRegistry: { create: async path => {
      if (path !== workspace) throw Error('dream-companion-worker-workspace')
      return { id: 'dream-companion-workspace' }
    } },
    // This child is already OS-isolated. Do not switch the native DSH Agent to a broad preset.
    permissionPresets: { set: () => {} },
  }
  const context = new Proxy(ctx, { get(target, key) {
    if (Object.hasOwn(overrides, key)) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  try {
    const health = { get: () => ({ state: 'ready' }), set: () => {} }
    sessions = new Sessions({ context, store, prompts: { current: () => ({ revision: 1, config: { skills: {} } }),
      compose: () => 'Complete one local project memory review from the supplied evidence.', skills: () => [] }, effects, health,
    masterId: 'dream-companion-router', lifetime: signal, closing: () => signal.aborted, environment: () => [], tools: () => [] })
    const prompt = sessions.prompt.bind(sessions)
    sessions.prompt = async (...args) => { await prompt(...args); await worker.whenIdle() }
    const allowed = trigger => trigger.id === envelope.trigger.id && trigger.source === 'solopup-dream' && trigger.actor.id === 'solopup-runtime'
    engine = new Engine({ repo: store, scope: { scope: trigger => ({ listened: allowed(trigger), observed: true }) },
      policy: () => ({ version: 'dream-companion-v1', paused: signal.aborted, evalTimeoutMs: 60_000, revalidate: () => !signal.aborted,
        admitsInferred: () => true, gate: trigger => allowed(trigger)
          ? { admissible: true, strength: 'inferred', basis: { via: 'bound-local-dream' } }
          : { admissible: false, reason: 'unknown-source' } }),
      assessor: { request(value) { candidate = value }, release() {} },
      executor: { start: (...args) => executor.start(...args), deliver() {}, stop: (...args) => executor.stop(...args) },
      prepareTicket: ticket => ({ ...ticket, execution: { directory: workspace, name: 'dream-companion', assignment: 'Review the prepared evidence.' } }),
      outbox: { send() {}, status() {}, withdraw() {} },
    })
    executor = new DshExecutor({ context, store, engine, effects, health, machine: { stateDir: root }, lifetime: signal,
      sessions, closing: () => signal.aborted, paused: () => signal.aborted, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined })
    if (engine.receive(envelope.trigger) !== 'stored') throw Error('dream-companion-source-rejected')
    engine.evaluateDue()
    if (!candidate) throw Error('dream-companion-source-no-candidate')
    const decision = engine.decide(envelope.trigger.id, { kind: 'accept', title: 'Review project memory', scope: 'one approved project',
      reason: 'bounded local dream request', acknowledgement: '', ruleIds: [], evalId: candidate.evalId })
    ticketId = decision.ticketId
    pipe.send({ type: 'ticket', ticketId })
    const launch = effectsQueue.find(effect => effect.kind === 'launch')
    if (!launch) throw Error('dream-companion-no-launch')
    await handlers.get('launch')(launch.payload)
    signal.throwIfAborted()
    const event = worker?.session.snapshotEvents().find(row => row.type === 'assistant/message')
    const output = event?.data?.message?.content?.find(block => block.type === 'text')?.text
    if (!invocation || typeof output !== 'string') throw Error('dream-companion-worker-no-output')
    return { type: 'result', ticketId, workerSessionId: worker.session.id, outputHash: digest(output) }
  } finally {
    executor?.dispose()
    sessions?.dispose()
    for (const handle of handles) await handle.dispose()
    store.close()
  }
}

export function apply(ctx) {
  const { SOLOPUP_COMPANION_ROOT: root, SOLOPUP_COMPANION_BUNDLE: bundle, SOLOPUP_COMPANION_NONCE: nonce } = process.env
  if (!root || !bundle || !/^[a-f0-9]{64}$/.test(nonce ?? '') || process.env.DSH_HOME !== join(root, 'home')) {
    throw Error('dream-companion-child-profile-required')
  }
  const input = createReadStream(null, { fd: 3, autoClose: false })
  const output = createWriteStream(null, { fd: 4, autoClose: false })
  const lifetime = new AbortController()
  let envelope, pendingModel, runStarted = false
  const stop = () => {
    lifetime.abort()
    pendingModel?.reject(Error('dream-companion-parent-gone'))
  }
  const parentGone = () => {
    stop()
    setTimeout(() => process.exit(0), 100).unref()
  }
  output.on('error', parentGone)
  const send = frame => output.write(encodeFrame({ ...frame, nonce }))
  const pipe = {
    send,
    model(receipt) {
      return new Promise((resolve, reject) => { pendingModel = { resolve, reject }; send({ type: 'model', ...receipt }) })
    },
  }
  readFrames(input, frame => {
    if (frame?.nonce !== nonce) throw Error('dream-companion-child-invalid-binding')
    if (frame.type === 'run' && !envelope && !runStarted && Array.isArray(frame.envelope?.messages)) {
      envelope = frame.envelope
      runStarted = true
      void runWorker(ctx, root, bundle, envelope, pipe, lifetime.signal).then(send, () => send({ type: 'failed' }))
      return
    }
    if (frame.type === 'answer' && pendingModel && typeof frame.output === 'string') {
      const model = pendingModel; pendingModel = undefined; model.resolve(frame.output); return
    }
    throw Error('dream-companion-child-unexpected-frame')
  }, parentGone, parentGone)
  void checkIsolation(root).then(() => { if (!lifetime.signal.aborted) send({ type: 'ready' }) }, () => send({ type: 'failed' }))
  ctx.effect(() => stop)
}
