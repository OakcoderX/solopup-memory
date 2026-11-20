#!/usr/bin/env node
/** Real DSH CLI/Loader, Session and Projection API check. Synthetic input, no model calls. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probeEnvironment } from './probe-env.mjs'

const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
if (!existsSync(CLI)) { console.error('[FAIL] DSH_CLI must identify an installed official host'); process.exit(2) }
const source = dirname(dirname(fileURLToPath(import.meta.url)))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-history-probe-')))
const env = probeEnvironment(root), profile = join(env.HOME, 'profiles', 'probe')
mkdirSync(profile, { recursive: true }); mkdirSync(env.TMPDIR)
const reportFile = join(root, 'result.json'), driver = join(root, 'driver.mjs')
writeFileSync(driver, `
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as memory from ${JSON.stringify(pathToFileURL(join(source, 'index.mjs')).href)}
import { memoryContextProjection, reconcileMemoryContext, setupMemoryHistory } from ${JSON.stringify(pathToFileURL(join(source, 'context-history.mjs')).href)}
export const name = 'solopup-history-probe'
export const inject = ['agents', 'llm', 'sessions', 'sessionProjections', 'systemPrompt', 'workingDirectory', 'tools']

function fixtureAdapter(ctx, route, observe) {
  ctx.llm.registerAdapter([route.provider], {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, listModels: async () => [],
    resolveModel: async (provider, id) => ({ provider, id, name: id }),
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
    },
    async *stream(options) {
      observe(options)
      const output = 'fixture response'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: output }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
      yield { type: 'finish', reason: 'stop' }
    },
  })
}

async function probeProjectDetails(ctx) {
  const route = { provider: 'solopup-project-details-fixture', model: 'fixture' }
  const active = ${JSON.stringify(join(root, "active-project"))}
  const other = ${JSON.stringify(join(root, "other-project"))}
  mkdirSync(active); mkdirSync(other)
  const summary = 'Keep the previously agreed handoff format.'
  const detail = 'Put the runnable lifecycle example in examples/quickstart.mjs.'
  const hash = text => createHash('sha256').update(text).digest('hex')
  memory.writeMemory({
    dir: memory.storeDirFor('project', active), scope: 'project', type: 'feedback',
    summary, detail, line: memory.indexLine('feedback', summary, undefined, true),
    meaning: { kind: 'preference' },
    provenance: { basis: 'tool-context', sessionId: 'synthetic-source', callHash: hash('source-call'),
      evidence: [{ messageId: 'synthetic-owner', hash: hash(detail), quote: detail }] },
  })
  const requests = new Map()
  fixtureAdapter(ctx, route, ({ sessionId, messages }) => {
    if (!sessionId?.startsWith('solopup-project-details-') ||
        !messages.some(message => message.source?.kind === 'user' &&
          'solopup-project-details-' + message.id === sessionId)) return
    const snapshot = messages.findLast(message => message.source?.sections?.some(section => section.name === 'memory:index'))
    const sent = requests.get(sessionId) ?? []
    sent.push(snapshot?.source.sections.find(section => section.name === 'memory:index').text ?? '')
    requests.set(sessionId, sent)
  })
  const query = 'Update the lifecycle and keep the runnable example aligned with the API.'
  const cases = [
    { id: 'relevant', cwd: active, text: query, visible: true },
    { id: 'unrelated', cwd: active, text: 'Explain the landscape palette.', visible: false },
    { id: 'different-project', cwd: other, text: query, visible: false },
  ]
  for (const { id, cwd, text, visible } of cases) {
    const sessionId = 'solopup-project-details-' + id
    const handle = await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions: route })
    try {
      const { agent } = handle
      agent.followup({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
      await agent.whenIdle()
      const outcome = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
      assert.ok(requests.has(sessionId), id + ' must reach the in-process adapter')
      assert.notEqual(outcome?.kind, 'error', id + ' must reach the in-process adapter: ' + JSON.stringify(outcome))
      for (const request of requests.get(sessionId)) {
        assert.equal(request.includes('来源摘录：' + detail), visible, id)
      }
    } finally { await handle.dispose() }
  }
  return { cases: cases.length, exactSourceMatched: true, paidRequests: 0 }
}

async function probeRequests(ctx) {
  const route = { provider: 'solopup-history-fixture', model: 'fixture' }
  const sessionId = 'solopup-generated-history-probe'
  const requests = []
  fixtureAdapter(ctx, route, options => {
    if (options.sessionId === sessionId && options.messages.some(m => m.source?.kind === 'runtime-context')) requests.push(options.messages)
  })

  let current = '<memory-store>original synthetic memory</memory-store>'
  const initial = current
  let other = 'old non-memory provider text with </SYSTEM-reminder > as data'
  const originalOther = other
  const history = await setupMemoryHistory(ctx, () => current)
  assert.equal(history.available, true)
  const handle = await ctx.agents.create({
    sessionId, agentOptions: route,
    setup(scoped) {
      scoped.systemPrompt.context({ name: 'memory:index', order: 10, required: true, interpolate: false, text: () => current })
      scoped.systemPrompt.context({ name: 'fixture:other', order: 20, required: true, interpolate: false, text: () => other })
      scoped.tools.restrict({ allow: [] })
    },
  })
  const { agent } = handle
  try {
    const submit = async turn => {
      const text = 'ordinary synthetic input ' + turn
      agent.followup({ id: 'user-' + turn, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
      await agent.whenIdle()
      const outcome = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')?.data.reason
      assert.equal(requests.length, turn, 'turn ' + turn + ' must reach the in-process adapter: ' + JSON.stringify(outcome))
      assert.notEqual(outcome?.kind, 'error')
      const messages = requests[turn - 1]
      assert.ok(messages.some(m => m.source?.kind === 'user' && m.content[0]?.text === text))
      const snapshot = messages.findLast(m => m.source?.kind === 'runtime-context' && m.source.sections?.some(s => s.name === 'memory:index'))
      assert.ok(snapshot, 'the host must assemble a memory snapshot')
      assert.equal(snapshot.source.sections.find(s => s.name === 'memory:index').text, current)
      return snapshot
    }
    const first = await submit(1)
    const reminder = first.content[0].text.startsWith('<system-reminder>')
    if (reminder) assert.match(first.content[0].text, /<\\\\\\/SYSTEM-reminder >/)
    current = '<memory-store>updated synthetic memory</memory-store>'
    other = 'current non-memory provider text'
    const second = await submit(2)
    if (reminder) assert.match(second.content[0].text, /replaces earlier versions of this context/)
    await submit(3)
    for (const messages of requests.slice(1)) {
      assert.ok(!JSON.stringify(messages).includes(initial), 'old memory must leave the request')
      assert.ok(messages.some(m => m.source?.sections?.some(s => s.name === 'fixture:other' && s.text === originalOther)))
      assert.ok(messages.some(m => m.source?.kind === 'user' && m.content[0]?.text === 'ordinary synthetic input 1'))
    }
    assert.ok(agent.session.snapshotEvents().some(e => e.type === 'user/message' &&
      e.data.source?.sections?.some(s => s.name === 'memory:index' && s.text === initial)), 'old memory remains in the append-only event log')
    return { format: reminder ? 'system-reminder' : 'legacy-snapshot', completedTurns: requests.length }
  } finally { await handle.dispose() }
}

export async function apply(ctx) {
  try {
    const owner = await ctx.plugin(memory, { autoCapture: { enabled: false } })
    if (typeof owner?.await === 'function') await owner.await()
    const stamp = JSON.parse(readFileSync(${JSON.stringify(join(env.HOME, 'memory', '.loaded.json'))}, 'utf8'))
    assert.equal(stamp.memoryHistory.available, true)
    assert.ok(stamp.tools.includes('memory_document'))
    const key = 'solopup:synthetic-projection-probe'
    const definition = { ...memoryContextProjection(), key }
    const register = async () => {
      const value = await ctx.sessionProjections.register(definition)
      return typeof value?.stateOf === 'function' ? { ...value, retained: true } : { stateOf: session => ctx.sessionProjections.stateOf(session, key), dispose: value, retained: false }
    }
    const handle = await register()
    const session = ctx.sessions.create('solopup-synthetic-history')
    const ordinary = { id: 'ordinary', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary synthetic quotation remains' }] }
    session.append('user/message', ordinary, { surfaceOp: 'append' })
    const sections = [{ name: 'memory:index', text: 'obsolete synthetic memory' }, { name: 'other:context', text: 'keep other provider' }]
    const old = { id: 'old-context', role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\\n\\n' + sections.map(s => s.text).join('\\n\\n') }] }
    const event = session.append('user/message', old, { surfaceOp: 'append' })
    assert.deepEqual(handle.stateOf(session).nodes, [{ id: 'old-context', seq: event.seq }])
    assert.equal(reconcileMemoryContext(session, handle.stateOf(session), 'current synthetic memory').replaced, 1)
    assert.deepEqual(session.deriveMessages()[0], ordinary)
    assert.doesNotMatch(JSON.stringify(session.deriveMessages()), /obsolete synthetic memory/)
    assert.match(JSON.stringify(session.deriveMessages()), /keep other provider/)
    assert.deepEqual(handle.stateOf(session).nodes, [])
    await handle.dispose()
    // A registration acquired after events exist must reconstruct from the real Session.
    const replay = await register()
    assert.deepEqual(replay.stateOf(session).nodes, [])
    const replayed = ctx.sessions.create('solopup-synthetic-replay', { seed: [{ ...event, seq: 0 }] })
    assert.equal(replay.stateOf(replayed).nodes.length, 1)
    await replay.dispose()
    if (replay.retained) assert.equal(replay.stateOf(replayed).nodes.length, 1, 'retained readers remain usable after owner disposal')
    await assert.rejects(async () => await ctx.sessionProjections.register({ ...definition, stateVersion: -1 }), /non-negative/)
    const projectDetails = await probeProjectDetails(ctx)
    await owner.dispose()
    const hostGeneratedRequests = await probeRequests(ctx)
    writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ passed: true, realDshHost: true, realModel: false, cleanHome: true, syntheticInput: true, tools: stamp.tools.length, projectionApi: handle.retained ? 'retained-handle' : 'legacy-registry', historyAvailable: stamp.memoryHistory.available, liveState: true, rewritePreservesOrdinaryAndOtherProvider: true, coldReplay: true, registrationRejected: true, ownerDisposed: true, hostGeneratedRequests, projectDetails }) + '\\n')
  } catch (error) {
    writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ passed: false, error: error.stack }) + '\\n')
  }
}
`)
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'solopup-history-probe', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
writeFileSync(join(profile, 'cordis.yml'), '[]\n')
writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: history-probe\n      name: ${JSON.stringify(pathToFileURL(driver).href)}\n`)
let output = '', child
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  child = spawn(CLI, ['--profile', 'probe', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  let childError
  child.once('error', error => { childError = error.code })
  const deadline = Date.now() + 40000
  while (!existsSync(reportFile) && !childError && child.exitCode === null && Date.now() < deadline) await sleep(100)
  if (!existsSync(reportFile)) throw Error(`history-probe-host-failed:${childError ?? child.exitCode ?? 'timeout'}\n${output.slice(-6000)}`)
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  if (!report.passed) throw Error(report.error + '\n' + output.slice(-6000))
  console.log('[PASS] Real DSH history registration, rewrite, cold replay and host-generated requests')
  console.log(JSON.stringify(report))
} catch (error) {
  console.error('[FAIL] ' + error.message); process.exitCode = 1
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM'); await Promise.race([stopped, sleep(1500)])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([stopped, sleep(1500)]) }
  }
  rmSync(root, { recursive: true, force: true })
}
