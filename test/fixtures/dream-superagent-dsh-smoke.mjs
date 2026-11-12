// Opt-in lab fixture. Runs actual pinned prototype Engine/DshExecutor/Sessions and
// a DSH Agent in a disposable DSH_HOME. Controlled intake, controller and provider
// replace production services. This is not the production isolation verifier.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSuperAgentDreamExecutor, SUPER_AGENT_DREAM_PROTOCOL, SUPER_AGENT_DREAM_PROTOTYPE } from '../../dream-superagent.mjs'

export const name = 'solopup-dream-superagent-dsh-smoke'
export const inject = ['agents', 'llm', 'systemPrompt', 'workingDirectory', 'tools', 'sessionPersistence']
const answer = JSON.stringify({ items: [{ id: 'm1', verdict: 'keep', sourceIds: ['s1'], reason: 'The source supports the memory.' }] })
const syntheticQuote = 'DREAM_SMOKE_794: the product label is teal.'
const bindingProof = { protocol: SUPER_AGENT_DREAM_PROTOCOL, source: 'solopup-dream', prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE,
  runtimeId: 'dsh-lab', isolationId: 'disposable-test-home-only' }

async function checkWorkerBoundary(root, port) {
  const outside = dirname(root)
  const input = join(outside, 'evidence', 'selected.txt')
  const other = join(outside, 'other-project', 'outside.txt')
  const syntheticHome = join(outside, 'outside-home', 'private.txt')
  const denied = error => ['EPERM', 'EACCES'].includes(error.code)
  assert.equal(lstatSync(input).nlink, 1)
  assert.equal(readFileSync(input, 'utf8'), syntheticQuote)
  assert.throws(() => readFileSync(other, 'utf8'), denied)
  assert.throws(() => readFileSync(syntheticHome, 'utf8'), denied)
  assert.throws(() => readFileSync(join(outside, 'evidence', 'outside-link'), 'utf8'), denied)
  assert.throws(() => linkSync(other, join(root, 'worker-hardlink')), denied)
  assert.throws(() => writeFileSync(input, 'worker overwrite'), denied)
  const socket = connect({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => {
    socket.once('connect', () => { socket.destroy(); reject(Error('worker reached network canary')) })
    socket.once('error', error => denied(error) ? resolve() : reject(error))
  })
  return { selectedEvidenceRead: true, inputWriteDenied: true, otherProjectDenied: true,
    otherHomeDenied: true, symlinkDenied: true, hardlinkDenied: true, networkDenied: true, workerPid: process.pid }
}

async function runHost(ctx, root, bundle) {
  const { Store, Engine, DshExecutor, Sessions } = await import(pathToFileURL(bundle).href)
  const store = new Store(join(root, 'engine.sqlite'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const requests = [], effectsQueue = [], handlers = new Map(), handles = []
  let engine, nativeExecutor, sessions, candidate, dispatched, worker, expectedTicket, dispatchFailure, workerBoundary, boundaryFailure
  const canaryPort = Number(process.env.SOLOPUP_DREAM_LAB_CANARY_PORT ?? 0)
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
            scoped.on('agent/pre-step', async (payload, next) => {
              if (payload.agent.session.id !== `worker-${expectedTicket}` || lifecycle.signal.aborted || !store.tickets.get(expectedTicket)) {
                return { kind: 'reject' }
              }
              if (canaryPort && !workerBoundary) {
                try { workerBoundary = await checkWorkerBoundary(root, canaryPort) }
                catch (error) { boundaryFailure = error; return { kind: 'reject' } }
              }
              return next()
            })
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
        if (boundaryFailure) throw boundaryFailure
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
    if (canaryPort) assert.ok(workerBoundary?.networkDenied)
    return { passed: true, prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE, ticketId: result.receipt.ticketId,
      workerSessionId: result.receipt.workerSessionId, dshModelRequests: requests.length, syntheticProvider: true,
      isolatedDshHome: true, isolationVerified: false, controllerAndEffects: 'fixture', router: 'controlled-policy',
      ...(workerBoundary ? { workerBoundary } : {}) }
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

function stageReadOnlyFixture(base, prototypeBundle) {
  const code = join(base, 'code')
  const fixture = join(code, 'test', 'fixtures', 'dream-superagent-dsh-smoke.mjs')
  const prototype = join(code, 'prototype')
  mkdirSync(dirname(fixture), { recursive: true })
  mkdirSync(prototype)
  copyFileSync(fileURLToPath(import.meta.url), fixture)
  const copyModule = (relative, seen = new Set()) => {
    if (seen.has(relative)) return
    seen.add(relative)
    const source = readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')
    writeFileSync(join(code, relative), source)
    for (const match of source.matchAll(/\b(?:from\s+|import\s*)['"]\.\/([^/'"]+\.mjs)['"]/g)) copyModule(match[1], seen)
  }
  copyModule('dream-superagent.mjs')
  const copiedBundle = join(prototype, 'bundle.mjs')
  const prototypeRoot = dirname(dirname(prototypeBundle))
  const dependencies = realpathSync(join(prototypeRoot, 'node_modules'))
  copyFileSync(prototypeBundle, copiedBundle)
  for (const file of ['package.json', 'skills', 'prompts']) cpSync(join(prototypeRoot, file), join(prototype, file), { recursive: true })
  symlinkSync(dependencies, join(prototype, 'node_modules'), 'dir')
  return { code, fixture, bundle: copiedBundle, dependencies }
}

function seatbeltProfile(cli, staged, root, evidence) {
  const appEnd = cli.indexOf('.app/Contents/')
  if (appEnd < 0) throw Error('Seatbelt smoke requires the installed macOS DSH app CLI')
  const app = cli.slice(0, appEnd + 4)
  const readable = ['/System', '/usr/lib', '/usr/bin', '/bin', app, staged.code, staged.dependencies, root, evidence]
  const paths = readable.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')
  const ancestors = new Set(['/'])
  for (const path of readable) for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) ancestors.add(parent)
  const traversal = [...ancestors].map(path => `(literal ${JSON.stringify(path)})`).join(' ')
  return `(version 1)
    (debug deny)
    (deny default)
    (allow process-exec process-fork sysctl-read mach-lookup file-read-metadata)
    (allow signal (target self))
    (allow file-read-data ${traversal})
    (allow file-read* file-map-executable ${paths} (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
    (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`
}

async function main() {
  const bundle = process.env.SOLOPUP_DREAM_BUNDLE
  if (!bundle || !existsSync(bundle)) throw Error('set SOLOPUP_DREAM_BUNDLE to the pinned prototype lab bundle')
  const cli = realpathSync(process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
  const restricted = process.env.SOLOPUP_DREAM_HOST_SEATBELT === '1'
  if (restricted && process.platform !== 'darwin') throw Error('Seatbelt smoke requires macOS')
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-dsh-')))
  const root = restricted ? join(base, 'host') : base
  const home = join(root, 'home'), profile = join(home, 'profiles', 'dream-lab'), tmp = join(root, 'tmp')
  let child, server, canaryPort, staged, sandbox
  try {
    if (restricted) {
      const evidence = join(base, 'evidence'), other = join(base, 'other-project'), outsideHome = join(base, 'outside-home')
      for (const path of [evidence, other, outsideHome]) mkdirSync(path)
      writeFileSync(join(evidence, 'selected.txt'), syntheticQuote)
      writeFileSync(join(other, 'outside.txt'), 'other project canary')
      writeFileSync(join(outsideHome, 'private.txt'), 'other home canary')
      symlinkSync(join(other, 'outside.txt'), join(evidence, 'outside-link'))
      staged = stageReadOnlyFixture(base, realpathSync(bundle))
      sandbox = seatbeltProfile(cli, staged, root, evidence)
      server = createServer(socket => socket.destroy())
      await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
      canaryPort = server.address().port
    }
    mkdirSync(profile, { recursive: true })
    mkdirSync(tmp)
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'solopup-dream-lab', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: solopup-dream-lab\n      name: ${JSON.stringify(staged ? pathToFileURL(staged.fixture).href : import.meta.url)}\n`)
    child = spawn(restricted ? '/usr/bin/sandbox-exec' : cli, [...(restricted ? ['-p', sandbox, cli] : []), '--profile', 'dream-lab'], {
      cwd: root, env: { PATH: restricted ? '/usr/bin:/bin' : process.env.PATH,
        HOME: home, CFFIXED_USER_HOME: home, USERPROFILE: home, DSH_HOME: home, TMPDIR: tmp,
        SOLOPUP_DREAM_LAB: root, SOLOPUP_DREAM_BUNDLE: staged?.bundle ?? realpathSync(bundle),
        ...(canaryPort ? { SOLOPUP_DREAM_LAB_CANARY_PORT: String(canaryPort) } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let diagnostics = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-5000) })
    const path = join(root, 'result.json'), deadline = Date.now() + 30_000
    while (!existsSync(path) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100)
    if (!existsSync(path)) throw Error(`isolated host stopped or timed out (${child.exitCode ?? child.signalCode ?? 'timeout'}): ${diagnostics}`)
    const result = JSON.parse(readFileSync(path, 'utf8'))
    console.log(JSON.stringify(result, null, 2))
    if (!result.passed) process.exitCode = 1
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM')
      await Promise.race([ended, delay(1000)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    server?.close()
    rmSync(base, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
