import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { buildDreamEvidence } from '../dream-review.mjs'
import { readDreamTranscripts } from '../dream-transcripts.mjs'
import { probeEnvironment } from '../scripts/probe-env.mjs'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const projectId = digest('test-project-a')
const otherId = digest('test-project-b')
const targetId = digest('target')
const text = 'Use plain text for project reports.'
const sessionId = 'synthetic-session'
const createdAt = Date.UTC(2026, 10, 13)
const workspace = '/tmp/dream-a'
const sibling = '/tmp/dream-a-linked'
const other = '/tmp/dream-b'
const projects = new Map([[workspace, projectId], [sibling, projectId], [other, otherId]])
const readProject = (cwd) => projects.get(cwd)
const pointer = (overrides = {}) => ({ sessionId, createdAt, seq: 0, hash: digest(text), ...overrides })
const user = (seq, value = text, changes = {}) => ({
  seq, type: 'user/message', time: createdAt + seq + 1, surfaceOp: 'append',
  data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: value }] },
  ...changes,
})
const cwd = (seq, path) => ({ seq, type: 'working-directory/change', time: createdAt + seq + 1, data: { cwd: path } })
const replace = user(1, 'The summary was replaced.', {
  surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0],
})

function fixture({
  id = sessionId, header = {}, inheritedEventCount = 0, events = [user(0)], source = 'prepared'
} = {}) {
  const state = { observed: [], disposed: 0 }
  const session = { id, cwd: workspace, createdAt, version: 4, isSeeded: false, ...header }
  return {
    state,
    query: {
      async observeSession(requested, options) {
        assert.equal(options.projectionMode, 'none')
        assert.equal(options.signal instanceof AbortSignal, true)
        state.observed.push(requested)
        assert.equal(requested, id)
        return {
          header: session, cursor: events.length - 1, inheritedEventCount, events, source,
          [Symbol.dispose]() { state.disposed++ },
        }
      },
      readSurface() { assert.fail('The installed host lists persisted metadata in readSurface()') },
      listSessions() { assert.fail('Only exact reads of explicit session IDs are permitted') },
    },
  }
}

async function collect(query, pointers = [pointer()], options = {}) {
  return readDreamTranscripts({
    query, projectId, pointersByTarget: { [targetId]: pointers }, resolveProjectId: readProject, ...options,
  })
}

test('historical prepared and live observations return bounded owner evidence, once per named session', async () => {
  for (const source of ['prepared', 'live']) {
    const { query, state } = fixture({ source })
    const narrow = pointer({ quote: 'plain text' })
    const result = await collect(query, [narrow, narrow])
    assert.equal(result.skips.length, 0)
    assert.deepEqual(result.additionalEvidenceByTarget[targetId], [{
      projectId, role: 'user', sourceComplete: true, sessionId, messageId: sessionId + ':0',
      text, quote: 'plain text', hash: digest(text), occurredAt: new Date(createdAt + 1).toISOString(),
    }])
    assert.ok(result.bytes > 0)
    assert.deepEqual(state.observed, [sessionId])
    assert.equal(state.disposed, 1)
  }
})

test('workspace identity is checked in the immutable header and again at the exact source event', async () => {
  const f = fixture({
    events: [cwd(0, sibling), user(1), cwd(2, other), user(3), cwd(4, workspace), user(5)],
  })
  const result = await collect(f.query, [pointer({ seq: 1 }), pointer({ seq: 3 }), pointer({ seq: 5 })])
  const outputs = result.additionalEvidenceByTarget[targetId]
  assert.equal(outputs[0].messageId, sessionId + ':1')
  assert.deepEqual(outputs[1], {})
  assert.equal(outputs[2].messageId, sessionId + ':5')
  assert.deepEqual(result.skips, [{ targetId, reason: 'workspace-mismatch' }])

  const wrongOrigin = fixture({ header: { cwd: other }, events: [cwd(0, workspace), user(1)] })
  const blocked = await collect(wrongOrigin.query, [pointer({ seq: 1 })])
  assert.equal(blocked.skips[0].reason, 'workspace-mismatch')
})

test('missing, replaced, inherited, delegated, and changed cuts cannot become sources', async () => {
  const cases = [
    { fixture: { events: [user(0), replace] }, reason: 'source-replaced' },
    { fixture: { events: [user(0), { ...replace, sourceEventSeqs: [] }] }, reason: 'unknown-surface' },
    { fixture: { events: [user(0), { ...replace, surfaceOp: 'future-operation' }] }, reason: 'unknown-surface' },
    { fixture: { events: [user(1)] }, reason: 'source-changed' },
    { fixture: { events: [user(0, text, { surfaceOp: undefined })] }, reason: 'source-unusable' },
    { fixture: { inheritedEventCount: 1 }, reason: 'not-owner-session' },
    { fixture: { header: { isSeeded: true } }, reason: 'not-owner-session' },
    { fixture: { header: { origin: 'subagent', delegationDepth: 1 } }, reason: 'not-owner-session' },
    { fixture: { events: [] }, reason: 'source-missing' },
    { fixture: {}, pointer: { createdAt: createdAt + 1 }, reason: 'source-missing' },
    { fixture: {}, pointer: { hash: digest('changed') }, reason: 'source-changed' },
    { fixture: {}, pointer: { quote: 'definitely not there' }, reason: 'source-changed' },
  ]
  for (const scenario of cases) {
    const { query, state } = fixture(scenario.fixture)
    const result = await collect(query, [pointer(scenario.pointer)])
    assert.deepEqual(result.additionalEvidenceByTarget[targetId], [{}])
    assert.equal(result.skips[0].reason, scenario.reason)
    assert.equal(state.disposed, 1)
  }
})

test('tool/runtime messages, mixed modalities, private and truncated text, and revoked source IDs stay out', async () => {
  const altered = (kind) => ({
    ...user(0),
    data: { ...user(0).data, source: { kind } },
  })
  const values = [
    altered('runtime-context'),
    altered('tool'),
    { ...user(0), data: { ...user(0).data, role: 'assistant' } },
    { ...user(0), data: { ...user(0).data, content: [...user(0).data.content, { type: 'image', data: 'synthetic' }] } },
    user(0, 'My birthday is January 5.'),
    user(0, 'Sample '.repeat(500)),
  ]
  for (const event of values) {
    const { query, state } = fixture({ events: [event] })
    const result = await collect(query)
    assert.equal(result.skips[0].reason, 'source-unusable')
    assert.deepEqual(result.additionalEvidenceByTarget[targetId], [{}])
    assert.equal(state.disposed, 1)
  }
  const { query, state } = fixture()
  const result = await collect(query, [pointer()], {
    withdrawnSourceIds: [digest(JSON.stringify([sessionId, sessionId + ':0']))],
  })
  assert.equal(result.skips[0].reason, 'source-withdrawn')
  assert.deepEqual(result.additionalEvidenceByTarget[targetId], [{}])
  assert.equal(state.disposed, 1)
})

test('missing source is carried as incomplete to the existing review evidence pipeline', async () => {
  const result = await collect({
    async observeSession() { throw Object.assign(Error('retained history missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }) },
  })
  assert.deepEqual(result.skips, [{ targetId, reason: 'source-missing' }])
  const primary = 'owner original note'
  const sourceSession = 'source-session'
  const sourceMessage = 'source-message'
  const input = buildDreamEvidence({
    projectId, storeRevision: digest('revision'),
    records: [{
      id: targetId, scope: 'project', status: 'recorded', summary: text, sessionId: sourceSession,
      sources: [digest(JSON.stringify([sourceSession, sourceMessage]))],
      evidence: [{ messageId: sourceMessage, quote: primary, hash: digest(primary) }],
      meaning: { kind: 'decision' },
    }],
    ...result,
  })
  assert.equal(input.items[0].incompleteEvidence, true)
  assert.equal(input.items[0].sources.length, 1)
})

test('deadline releases late observations and an abort discards the result', async () => {
  const f = fixture()
  const lease = await f.query.observeSession(sessionId, { projectionMode: 'none', signal: new AbortController().signal })
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const result = await collect({
    observeSession: () => pending,
    readSurface: () => assert.fail('late observation must not be consumed'),
  }, [pointer()], { timeoutMs: 5 })
  assert.equal(result.skips[0].reason, 'timeout')
  finish(lease)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.state.disposed, 1)

  const controller = new AbortController()
  const work = collect({
    async observeSession(...args) {
      const observation = await f.query.observeSession(...args)
      controller.abort(Error('session-query-disposed'))
      return observation
    },
  }, [pointer()], { signal: controller.signal })
  await assert.rejects(work, /session-query-disposed/)
  assert.equal(f.state.disposed, 2)
})

test('session, event and retained byte caps prevent widening the source search', async () => {
  const { query, state } = fixture()
  const budget = await collect(query, [pointer()], { maxBytes: 1 })
  assert.equal(budget.skips[0].reason, 'byte-cap')
  assert.equal(budget.bytes, 0)
  assert.deepEqual(budget.additionalEvidenceByTarget[targetId], [{}])
  assert.equal(state.disposed, 1)

  let readEvents = false
  const huge = await collect({
    async observeSession() {
      return {
        header: { id: sessionId, createdAt, cwd: workspace, isSeeded: false },
        inheritedEventCount: 0, source: 'live', cursor: 4096,
        get events() { readEvents = true; return [] },
        [Symbol.dispose]() {},
      }
    },
  })
  assert.equal(huge.skips[0].reason, 'event-cap')
  assert.equal(readEvents, false)

  const attempted = []
  const cap = await collect({
    async observeSession(id) { attempted.push(id); throw Error('not available') },
  }, [], {
    pointersByTarget: Object.fromEntries([0, 1, 2].map(group => [digest('group' + group),
      [0, 1].map(item => pointer({ sessionId: `session-${group}-${item}` }))])),
  })
  assert.equal(attempted.length, 5)
  assert.equal(cap.skips.filter(value => value.reason === 'session-cap').length, 1)
  await assert.rejects(collect(query, [pointer({ sessionId: '../unsafe' })]), /invalid-pointers/)
})

test('metadata preflight refuses oversized stored sessions before opening the named log', async () => {
  const { query, state } = fixture()
  const result = await collect(query, [pointer()], {
    preflightSession: () => ({
      source: 'prepared', header: { id: sessionId, cwd: workspace, createdAt, isSeeded: false },
      revision: 'fixture-revision', sizeBytes: 256 * 1024 + 1,
    }),
  })
  assert.equal(result.skips[0].reason, 'stored-size-cap')
  assert.deepEqual(state.observed, [])
})

// The real host probe is opt-in and uses synthetic data in a disposable SDK profile.
test('installed DSH reads live and persisted sources without resuming the latter', {
  skip: process.env.DSH_TRANSCRIPT_PROBE !== '1',
}, async () => {
  const cli = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-transcript-probe-')))
  const env = probeEnvironment(base)
  const profile = join(env.HOME, 'profiles', 'transcript-probe')
  const resultPath = join(base, 'result.json')
  const driver = join(base, 'driver.mjs')
  let child
  try {
    mkdirSync(profile, { recursive: true })
    mkdirSync(env.TMPDIR)
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'solopup-transcript-probe', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
    }))
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'dream-transcript-probe', name: pathToFileURL(driver).href }] }]))
    writeFileSync(driver, `
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { readDreamTranscripts } from ${JSON.stringify(new URL('../dream-transcripts.mjs', import.meta.url).href)}

export const name = 'dream-transcript-probe'
export const inject = ['sessions', 'sessionQuery', 'sessionPersistence']
export async function apply(ctx) {
  const resultPath = ${JSON.stringify(resultPath)}
  try {
    const digest = value => createHash('sha256').update(value).digest('hex')
    const cwd = ${JSON.stringify(base)}
    const projectId = digest('synthetic-project'), target = digest('synthetic-record')
    const original = 'Use plain text for project reports.'
    const live = ctx.sessions.create('solopup-dream-transcript-live', { meta: { cwd } })
    const event = live.append('user/message', {
      id: 'synthetic-owner-message', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: original }],
    }, { surfaceOp: 'append' })
    const coldId = 'solopup-dream-transcript-cold'
    const header = { ...live.header, id: coldId }
    const writer = await ctx.sessionPersistence.create(header)
    try { await writer.append([event]); await writer.flush() } finally { await writer.close() }
    const location = (await ctx.sessionPersistence.stat(coldId)).location.path
    const prior = digest(readFileSync(location))
    const observations = []
    const query = {
      async observeSession(...args) {
        const source = await ctx.sessionQuery.observeSession(...args)
        observations.push(source.source)
        return source
      },
      readSurface() { assert.fail('Cold source acquisition must not list persisted metadata') },
    }
    const collect = id => readDreamTranscripts({
      query, projectId, resolveProjectId: path => path === cwd ? projectId : undefined,
      pointersByTarget: { [target]: [{ sessionId: id, createdAt: live.header.createdAt, seq: event.seq, hash: digest(original) }] },
      async preflightSession(id, { signal }) {
        const attached = ctx.sessions.get(id)
        if (attached) return { source: 'live', header: attached.header, cursor: attached.seq - 1 }
        const saved = await ctx.sessionPersistence.stat(id, { signal })
        return saved && { source: 'prepared', header: saved.header, sizeBytes: saved.sizeBytes, revision: saved.revision }
      },
    })
    const first = await collect(live.id)
    assert.equal(first.skips.length, 0, JSON.stringify(first.skips))
    assert.equal(first.additionalEvidenceByTarget[target][0].quote, original)
    const cold = await collect(coldId)
    assert.equal(cold.skips.length, 0, JSON.stringify(cold.skips))
    assert.equal(cold.additionalEvidenceByTarget[target][0].quote, original)
    assert.equal(ctx.sessions.get(coldId), undefined)
    assert.equal(digest(readFileSync(location)), prior)
    const missing = await collect('solopup-dream-transcript-missing')
    assert.equal(missing.skips[0].reason, 'source-missing')
    live.append('user/message', {
      id: 'synthetic-replacement-message', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'Use Markdown for project reports.' }],
    }, { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
    const replaced = await collect(live.id)
    assert.equal(replaced.skips[0].reason, 'source-replaced')
    writeFileSync(resultPath, JSON.stringify({
      passed: true, observations, coldSessionAttached: false, coldLogUnchanged: true,
      unavailable: missing.skips[0].reason, replaced: replaced.skips[0].reason, actualModelCalls: 0,
    }))
  } catch (error) { writeFileSync(resultPath, JSON.stringify({ passed: false, error: error.stack })) }
}
`)
    child = spawn(cli, ['--profile', 'transcript-probe'], { env, stdio: ['pipe', 'ignore', 'pipe'] })
    let logs = ''
    let launchError
    child.once('error', error => { launchError = error })
    child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-2000) })
    const deadline = Date.now() + 15_000
    while (!existsSync(resultPath) && !launchError && child.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (launchError) throw launchError
    assert.ok(existsSync(resultPath), logs || 'DSH probe timed out')
    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    assert.equal(result.passed, true, result.error)
    assert.deepEqual(result.observations, ['live', 'prepared', 'live'])
    console.log(JSON.stringify(result))
  } finally {
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
      try { await exited } finally { clearTimeout(timer) }
    }
    rmSync(base, { recursive: true, force: true })
  }
})
