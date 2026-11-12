// Opt-in lab fixture. Runs actual pinned prototype Engine/DshExecutor/Sessions and
// a DSH Agent in a disposable DSH_HOME. Controlled intake, controller and provider
// replace production services. This is not the production isolation verifier.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createSuperAgentDreamExecutor, SUPER_AGENT_DREAM_PROTOCOL, SUPER_AGENT_DREAM_PROTOTYPE } from '../../dream-superagent.mjs'

export const name = 'solopup-dream-superagent-dsh-smoke'
export const inject = ['agents', 'llm', 'systemPrompt', 'workingDirectory', 'tools', 'sessionPersistence']
const answer = JSON.stringify({ items: [{ id: 'm1', verdict: 'keep', sourceIds: ['s1'], reason: 'The source supports the memory.' }] })
const syntheticQuote = 'DREAM_SMOKE_794: the product label is teal.'
const bindingProof = { protocol: SUPER_AGENT_DREAM_PROTOCOL, source: 'solopup-dream', prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE,
  runtimeId: 'dsh-lab', isolationId: 'disposable-test-home-only' }

async function runHost(ctx, root, bundle) {
  const { Store, Engine, DshExecutor, Sessions } = await import(pathToFileURL(bundle).href)
  const store = new Store(join(root, 'engine.sqlite'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const requests = [], effectsQueue = [], handlers = new Map(), handles = []
  let engine, nativeExecutor, sessions, candidate, dispatched, worker, expectedTicket, dispatchFailure
  const lifecycle = new AbortController()
  const effects = { handle: (kind, fn) => handlers.set(kind, fn), enqueue: (kind, _id, payload) => effectsQueue.push({ kind, payload }),
    pending: () => false, idle: async () => {} }
  const provider = {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    listModels: async () => [], resolveModel: async (providerId, model) => ({ provider: providerId, id: model, name: model }),
    async prepareCall(providerId, model) { return { model: await this.resolveModel(providerId, model), stream: options => this.stream(options) } },
    async *stream(options) {
      requests.push({ sessionId: options.sessionId, evidencePresent: JSON.stringify([options.system, options.messages]).includes(syntheticQuote) })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  ctx.llm.registerAdapter(['solopup-dream-fixture'], provider)
  const overrides = {
    sessionController: {
      resolveAgent: async id => ctx.agents.get(id) ? { agent: ctx.agents.get(id) } : { error: { code: 'session/not-found' } },
      create: async ({ sessionId }) => {
        if (!dispatched || sessionId !== `worker-${expectedTicket}`) throw Error('fixture-worker-binding-rejected')
        const handle = await ctx.agents.create({ sessionId, meta: { cwd: workspace }, agentOptions: dispatched.route,
          setup: async scoped => {
            scoped.on('agent/pre-step', (payload, next) => payload.agent.session.id === `worker-${expectedTicket}` &&
              !lifecycle.signal.aborted && store.tickets.get(expectedTicket) ? next() : { kind: 'reject' })
            scoped.systemPrompt.context({ name: 'dream-lab-evidence', order: 40, required: true, interpolate: false,
              text: () => JSON.stringify(dispatched.messages) })
            scoped.tools.restrict({ allow: [] })
          } })
        worker = handle.agent
        handles.push(handle)
      },
      rename: async () => {},
    },
    workspaceRegistry: { create: async path => { assert.equal(path, workspace); return { id: 'solopup-dream-fixture' } } },
    permissionPresets: { set: () => {} },
  }
  const context = new Proxy(ctx, { get(target, key) {
    if (key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  try {
    const health = { get: () => ({ state: 'ready' }), set: () => {} }
    sessions = new Sessions({ context, store, prompts: { current: () => ({ revision: 1, config: { skills: {} } }),
      compose: () => 'A synthetic evidence review only.', skills: () => [] }, effects, health,
    masterId: 'dream-router-fixture', lifetime: lifecycle.signal, closing: () => false, environment: () => [], tools: () => [] })
    const prompt = sessions.prompt.bind(sessions)
    sessions.prompt = async (...args) => { await prompt(...args); await worker.whenIdle() }
    const allowed = trigger => trigger.source === 'solopup-dream' && trigger.actor.id === 'solopup-runtime'
    engine = new Engine({ repo: store, scope: { scope: trigger => ({ listened: allowed(trigger), observed: true }) },
      policy: () => ({ version: 'dream-lab', paused: false, evalTimeoutMs: 60_000, revalidate: () => true, admitsInferred: () => true,
        gate: trigger => allowed(trigger) ? { admissible: true, strength: 'inferred', basis: { via: 'solopup-lab' } } : { admissible: false, reason: 'unknown-source' } }),
      assessor: { request(value) { candidate = value }, release() {} },
      executor: { start: (...args) => nativeExecutor.start(...args), deliver() {}, stop: (...args) => nativeExecutor.stop(...args) },
      prepareTicket: ticket => ({ ...ticket, execution: { directory: workspace, name: 'dream-lab', assignment: 'Review the prepared evidence.' } }),
      outbox: { send() {}, status() {}, withdraw() {} },
    })
    nativeExecutor = new DshExecutor({ context, store, engine, effects, health, machine: { stateDir: root }, lifetime: lifecycle.signal,
      sessions, closing: () => false, paused: () => false, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined })
    const bridge = {
      probe: ({ challenge }) => ({ ...bindingProof, challenge }),
      status: () => ({ state: 'uncertain' }), cancel: () => ({ state: 'uncertain' }),
      async dispatch(envelope, { signal, onReceipt }) {
        signal.throwIfAborted()
        dispatched = envelope
        assert.equal(engine.receive(envelope.trigger), 'stored')
        assert.equal(engine.receive(envelope.trigger), 'duplicate')
        engine.evaluateDue()
        assert.ok(candidate)
        assert.ok(!JSON.stringify(candidate).includes(syntheticQuote))
        const decision = engine.decide(envelope.trigger.id, { kind: 'accept', title: 'Review project memory', scope: 'one synthetic project',
          reason: 'locally admitted fixture', acknowledgement: '', ruleIds: [], evalId: candidate.evalId })
        expectedTicket = decision.ticketId
        const receipt = { ...envelope.binding, ticketId: expectedTicket }
        onReceipt(receipt)
        const launch = effectsQueue.find(effect => effect.kind === 'launch')
        assert.ok(launch)
        await handlers.get('launch')(launch.payload)
        signal.throwIfAborted()
        assert.ok(worker?.session.id, JSON.stringify(store.tickets.get(expectedTicket)?.assignments))
        const event = worker.session.snapshotEvents().find(row => row.type === 'assistant/message')
        const output = event?.data?.message?.content?.find(block => block.type === 'text')?.text
        assert.equal(output, answer)
        return { receipt: { ...receipt, workerSessionId: worker.session.id }, output }
      },
    }
    const companion = { ...bridge, async dispatch(...args) {
      try { return await bridge.dispatch(...args) } catch (error) { dispatchFailure = error; throw error }
    } }
    const executor = createSuperAgentDreamExecutor({ getBridge: () => companion,
      // Only the synthetic fixture opts into this verifier. It is not an OS isolation proof.
      verifyIsolation: ({ proof }) => proof.runtimeId === bindingProof.runtimeId && proof.isolationId === bindingProof.isolationId })
    const result = await executor.execute({ schema: 1, projectId: 'a'.repeat(64), storeRevision: 'b'.repeat(64),
      items: [{ id: 'c'.repeat(64), summary: 'The product label is teal.',
        sources: [{ id: 'd'.repeat(64), hash: 'e'.repeat(64), quote: syntheticQuote, kind: 'original' }] }] },
    { signal: lifecycle.signal, runId: 'dream-dsh-lab', attempt: 1, route: { provider: 'solopup-dream-fixture', model: 'fixture' },
      maxTokens: 1800, maxTotalTokens: 5000, beforeDispatch() {} }).catch(error => { throw dispatchFailure ?? error })
    assert.equal(result.output, answer)
    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0], { sessionId: result.receipt.workerSessionId, evidencePresent: true })
    return { passed: true, prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE, ticketId: result.receipt.ticketId,
      workerSessionId: result.receipt.workerSessionId, dshModelRequests: requests.length, syntheticProvider: true,
      isolatedDshHome: true, isolationVerified: false, controllerAndEffects: 'fixture', router: 'controlled-policy' }
  } finally {
    lifecycle.abort()
    nativeExecutor?.dispose()
    sessions?.dispose()
    for (const handle of handles) await handle.dispose()
    store.close()
  }
}

export function apply(ctx) {
  const { SOLOPUP_DREAM_LAB: root, SOLOPUP_DREAM_BUNDLE: bundle } = process.env
  if (!root || !bundle || process.env.DSH_HOME !== join(root, 'home')) throw Error('dream-lab-isolated-profile-required')
  setTimeout(() => {
    void runHost(ctx, root, bundle).then(result => writeFileSync(join(root, 'result.json'), JSON.stringify(result)),
      error => writeFileSync(join(root, 'result.json'), JSON.stringify({ passed: false, error: String(error?.stack ?? error) })))
  }, 0)
}

async function main() {
  const bundle = process.env.SOLOPUP_DREAM_BUNDLE
  if (!bundle || !existsSync(bundle)) throw Error('set SOLOPUP_DREAM_BUNDLE to the pinned prototype lab bundle')
  const cli = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-dsh-')))
  const home = join(root, 'home'), profile = join(home, 'profiles', 'dream-lab'), tmp = join(root, 'tmp')
  mkdirSync(profile, { recursive: true })
  mkdirSync(tmp)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'solopup-dream-lab', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: solopup-dream-lab\n      name: ${JSON.stringify(import.meta.url)}\n`)
  const child = spawn(cli, ['--profile', 'dream-lab'], { cwd: root, env: { PATH: process.env.PATH,
    HOME: home, USERPROFILE: home, DSH_HOME: home, TMPDIR: tmp, SOLOPUP_DREAM_LAB: root, SOLOPUP_DREAM_BUNDLE: realpathSync(bundle) },
  stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-5000) })
  try {
    const path = join(root, 'result.json'), deadline = Date.now() + 30_000
    while (!existsSync(path) && child.exitCode === null && Date.now() < deadline) await delay(100)
    if (!existsSync(path)) throw Error(`isolated host stopped or timed out: ${diagnostics}`)
    const result = JSON.parse(readFileSync(path, 'utf8'))
    console.log(JSON.stringify(result, null, 2))
    if (!result.passed) process.exitCode = 1
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM')
      await Promise.race([ended, delay(1000)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
