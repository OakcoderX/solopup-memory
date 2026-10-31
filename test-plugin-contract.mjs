import {realpathSync} from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config, normalizePluginConfig, DEFAULT_AUTO_CAPTURE } from './plugin-config.mjs'
import { optionalService } from './host-services.mjs'
import { extractWithLlm } from './capture-llm.mjs'
import { apply,storeDirFor } from './index.mjs'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await sleep(5) } throw Error('fixture deadline') }

test('Cordis Config implements synchronous Standard Schema V1 and returns independent defaults', () => {
  assert.equal(Config['~standard'].version, 1)
  assert.equal(typeof Config['~standard'].vendor, 'string')
  const a = Config['~standard'].validate({}), b = normalizePluginConfig({})
  assert.deepEqual(a.value.autoCapture, DEFAULT_AUTO_CAPTURE)
  assert.deepEqual(Config['~standard'].validate(undefined).value.autoCapture, DEFAULT_AUTO_CAPTURE)
  a.value.autoCapture.enabled = false
  assert.equal(b.autoCapture.enabled, true)
  assert.equal(normalizePluginConfig({ autoCapture: { everyTurns: undefined } }).autoCapture.everyTurns, 4)
})
for (const [key, values] of Object.entries({ enabled: [0, 'false'], everyTurns: [0, 1.5, 1001], maxEntries: [0, 11], maxTokens: [0, 8193], maxInputBytes: [1023, 65537], timeoutMs: [0, 120001] })) {
  test(`invalid ${key} fails load-time validation rather than entering capture`, () => {
    for (const value of values) {
      const result = Config['~standard'].validate({ autoCapture: { [key]: value } })
      assert.ok(result.issues.length)
      assert.throws(() => normalizePluginConfig({ autoCapture: { [key]: value } }), /memory-invalid-config/)
    }
  })
}
test('unknown fields, nonobjects and incomplete routes are rejected without echoing configured values', () => {
  for (const value of [null, [], true, { unknown: 'synthetic-private-value' }, { autoCapture: null }, { autoCapture: { timeout: 'synthetic-private-value' } }, { autoCapture: { provider: 'only-provider' } }, { autoCapture: { provider: ' ', model: 'model' } }]) {
    assert.throws(() => normalizePluginConfig(value), /memory-invalid-config/)
    assert.doesNotMatch(JSON.stringify(Config['~standard'].validate(value)), /synthetic-private-value|only-provider/)
  }
  assert.deepEqual(normalizePluginConfig({ autoCapture: { provider: ' p ', model: ' m ' } }).autoCapture, { ...DEFAULT_AUTO_CAPTURE, provider: 'p', model: 'm' })
})
test('invalid configuration registers no tools or prompt contributions', () => {
  let calls = 0
  const ctx = { systemPrompt: { context: () => calls++ }, tools: { register: () => calls++ }, workingDirectory: { get: () => '' } }
  assert.throws(() => apply(ctx, { autoCapture: { everyTurns: 0 } }), /memory-invalid-config/)
  assert.equal(calls, 0)
})
test('optional service lookup prefers public active lookup and never revives an absent provider', () => {
  const active = { marker: 'active' }
  assert.equal(optionalService({ get: name => name === 'llm' ? active : undefined }, 'llm'), active)
  assert.equal(optionalService({ get: () => undefined, reflect: { get: () => active }, llm: active }, 'llm'), undefined)
  assert.equal(optionalService({ get: () => { throw Error('not permitted') }, llm: active }, 'llm'), undefined)
  assert.equal(optionalService({ reflect: { get: () => active } }, 'llm'), active)
  assert.equal(optionalService({ llm: active }, 'llm'), active)
})
const options = { messages: [], indexLines: [], route: { provider: 'fixture', model: 'fixture' }, timeoutMs: 5000 }
test('pre-cancelled capture never prepares or sends a model call', async () => {
  const controller = new AbortController(); controller.abort()
  let prepared = 0
  await assert.rejects(extractWithLlm({ ...options, signal: controller.signal, llm: { prepareCall: () => { prepared++; throw Error('must not run') } } }), /capture-cancelled/)
  assert.equal(prepared, 0)
})
test('unload during preparation stops waiting and rejects late dispatch even if provider ignores cancellation', async () => {
  const controller = new AbortController()
  let finish, dispatched = 0
  const pending = extractWithLlm({ ...options, signal: controller.signal, llm: { prepareCall: () => new Promise(resolve => finish = resolve) } })
  controller.abort()
  await assert.rejects(pending, /capture-cancelled/)
  finish({ config: {}, stream: () => { dispatched++; throw Error('must not dispatch') } })
  await sleep(10)
  assert.equal(dispatched, 0)
})
test('unload during an uncooperative stream stops waiting and propagates abort without accepting late text', async () => {
  const controller = new AbortController()
  let received, finish, started = false
  const pending = extractWithLlm({ ...options, signal: controller.signal, llm: { async prepareCall(config, signal) {
    received = signal
    return { config, stream: async function* () { started = true; await new Promise(resolve => finish = resolve); yield { type: 'text-delta', text: '[]' } } }
  } } })
  await until(() => started)
  controller.abort()
  await assert.rejects(pending, /capture-cancelled/)
  assert.equal(received.aborted, true)
  finish()
  await sleep(10)
})
test('plugin disposal prevents pending capture from adopting a valid late candidate', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-plugin-dispose-'))), previous = process.env.DSH_HOME
  const cwd = join(root, 'project'), store = join(root, 'memory')
  mkdirSync(cwd); process.env.DSH_HOME = root
  const disposers = [], handlers = new Map()
  let release, streamStarted = false, requestSignal
  const llm = { listProviders: () => [{ provider: 'fixture', model: 'fixture' }], async prepareCall(config, signal) {
    requestSignal = signal
    return { config, stream: async function* () { streamStarted = true; await new Promise(resolve => release = resolve); yield { type: 'text-delta', text: JSON.stringify([{ type: 'user', summary: '合成项目使用低反差画面', scope: 'project', meaning:{kind:'claim'},basis: 'explicit', evidence: [{ messageId: 'dispose-session:event-0', quote: '合成项目使用低反差画面' }] }]) } } }
  } }
  const ctx = { get: name => name === 'llm' ? llm : undefined, systemPrompt: { context() {} }, tools: { register() {} }, workingDirectory: { get: () => cwd },
    effect: callback => disposers.push(callback()), on: (name, fn) => handlers.set(name, fn) }
  try {
    apply(ctx, { autoCapture: { everyTurns: 1 } })
    const session = { id: 'dispose-session' }, emit = handlers.get('session/event')
    emit(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '合成项目使用低反差画面，其他项目另定。' }] } })
    emit(session, { type: 'step/end' })
    await until(() => streamStarted)
    for (const dispose of disposers.reverse()) dispose?.()
    await until(() => JSON.parse(readFileSync(join(store, '.capture-state.json'))).lastError === 'capture-cancelled')
    assert.equal(requestSignal.aborted, true)
    release()
    await sleep(20)
    const project=storeDirFor('project',cwd)
    assert.equal(existsSync(join(project,'.managed-policy.json')),true)
    assert.equal(existsSync(join(project,'MEMORY.md')),false)
    assert.equal(existsSync(join(project,'.candidates.json')),false)
    assert.equal(existsSync(join(store, 'MEMORY.md')), false)
  } finally {
    release?.()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})
