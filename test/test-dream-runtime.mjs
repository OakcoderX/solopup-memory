import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDreamRuntime, renderDreamReport } from '../dream-runtime.mjs'
import { createOrdinaryDreamExecutor, normalizeDreamUsage } from '../dream-ordinary.mjs'
import { openDreamQueue } from '../dream-queue.mjs'
import { normalizePluginConfig } from '../plugin-config.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const flush = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve() }
const quote = '本项目的交付说明以后默认使用中文。'
const sessionId = 'review-test-session'
const messageId = 'review-test-message'
const record = {
  id: digest('project-memory'), scope: 'project', status: 'recorded',
  summary: '交付说明默认使用中文。',
  sessionId, evidence: [{ messageId, quote, hash: digest(quote) }],
  sources: [digest(JSON.stringify([sessionId, messageId]))],
}
const approved = { items: [{ id: 'm1', verdict: 'keep', sourceIds: ['s1'], reason: '用户原话明确规定默认使用中文。' }] }

function clock() {
  let time = 100_000
  const timers = new Map()
  return {
    now: () => time,
    setTimer(fn, delay) { const id = Symbol(); timers.set(id, { due: time + delay, fn }); return id },
    clearTimer: id => timers.delete(id),
    async advance(ms) {
      time += ms
      for (const [id, value] of [...timers]) {
        if (value.due <= time && timers.delete(id)) value.fn()
      }
      await flush()
    },
  }
}

function fixture(t, executors, options = {}, readReplay) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-runtime-')))
  const timer = clock()
  const queue = openDreamQueue(join(home, 'memory'), { now: timer.now, maxDailyTokens: options.maxDailyTokens })
  const project = { projectId: digest('project-a'), storeRevision: digest('initial-revision'), records: [record] }
  const runtime = createDreamRuntime({
    options: { projects: ['project-a'], idleMs: 1000, timeoutMs: 5000, provider: 'fixture', model: 'fixture', ...options },
    queue, readProject: (path, consume) => consume(path === 'project-a' ? project : undefined), readReplay, executors,
    now: timer.now, timers: { setTimer: timer.setTimer, clearTimer: timer.clearTimer },
  })
  t.after(async () => { runtime.dispose(); await flush(); rmSync(home, { recursive: true, force: true }) })
  return { queue, project, runtime, timer }
}

test('dream opt-in requires an explicit scope and route; default is off', () => {
  assert.equal(normalizePluginConfig({}).dream.enabled, false)
  assert.throws(() => normalizePluginConfig({ dream: { enabled: true } }), /memory-invalid-config:dream.projects/)
  assert.throws(() => normalizePluginConfig({ dream: { enabled: true, projects: ['/tmp/example'] } }), /memory-invalid-config:dream.provider/)
  assert.throws(() => normalizePluginConfig({ dream: { projects: ['/'] } }), /memory-invalid-config:dream.projects/)
})

test('last foreground turn ends and ordinary DSH wakes on time without another event', async t => {
  const outbound = []
  const llm = {
    async prepareCall(config) {
      return { config, async *stream(request) {
        outbound.push(request)
        yield { type: 'text-delta', text: JSON.stringify(approved) }
        yield { type: 'finish', usage: { inputTokens: 150, outputTokens: 25, cacheReadTokens: 80, cacheWriteTokens: 20, totalTokens: 275 } }
      } }
    },
  }
  const ordinary = createOrdinaryDreamExecutor({ getLlm: () => ({ value: llm }) })
  const { timer, runtime, queue } = fixture(t, { ordinary })
  runtime.scheduler.enter('foreground')
  await timer.advance(5000)
  assert.equal(outbound.length, 0)
  runtime.scheduler.leave('foreground')
  await timer.advance(999)
  assert.equal(outbound.length, 0)
  await timer.advance(1)
  assert.equal(outbound.length, 1)
  assert.equal(outbound[0].purpose, 'memory-dream-review')
  assert.deepEqual(outbound[0].tools, [])
  assert.doesNotMatch(JSON.stringify(outbound[0].messages), /review-test-session|review-test-message/)
  assert.equal(queue.status().counts.completed, 1)
  const [{ runId }] = queue.listReports()
  const project = { projectId: digest('project-a'), storeRevision: digest('unrelated-change'), records: [record] }
  const report = queue.report(runId), run = queue.getRun(runId)
  assert.deepEqual(report.usage, { inputTokens: 250, outputTokens: 25, totalTokens: 275 })
  assert.equal(queue.status().budget.tokens, 275)
  assert.equal(renderDreamReport(project, run, report).items[0].sources[0].quote, quote)
  assert.equal(renderDreamReport(project, run, report).items[0].sources[0].messageId, messageId)
  assert.deepEqual(renderDreamReport({ ...project, records: [] }, run, report).items, [
    { id: record.id, state: 'evidence-changed' },
  ])
  assert.equal(renderDreamReport({ ...project, projectId: digest('other-project') }, run, report).available, false)
  await timer.advance(1000)
  assert.equal(outbound.length, 1)
})

test('inconsistent DSH usage does not reduce a run reservation', () => {
  assert.equal(normalizeDreamUsage({ inputTokens: 60, cacheReadTokens: 80, outputTokens: 40, totalTokens: 100 }), undefined)
  assert.equal(normalizeDreamUsage({ inputTokens: 60, cacheReadTokens: -1, outputTokens: 40 }), undefined)
  assert.deepEqual(normalizeDreamUsage({ inputTokens: 60, outputTokens: 40 }), { inputTokens: 60, outputTokens: 40, totalTokens: 100 })
})

test('historical evidence is re-read before dispatch and cannot publish after it is replaced', async t => {
  const projectId = digest('project-a'), changedQuote = '更正「交付说明默认使用中文。」：改用英文。'
  const pointer = { sessionId: 'session-later', createdAt: 100, seq: 4, hash: digest(changedQuote) }
  const source = { ...pointer, projectId, role: 'user', sourceComplete: true, messageId: 'session-later:4',
    text: changedQuote, quote: changedQuote, occurredAt: new Date(1000).toISOString() }
  let reads = 0, invoked = 0
  const ordinary = {
    ready: () => ({ ready: true }),
    async execute(input, { verifyBeforeDispatch, beforeDispatch }) {
      assert.equal(input.items[0].sources[1].kind, 'additional-user-message')
      await verifyBeforeDispatch()
      beforeDispatch()
      invoked++
      return { output: { items: [{ id: 'm1', verdict: 'propose-correction', sourceIds: ['s1', 's2'],
        reason: '第二段原话明确更正了默认语言。', proposedSummary: '交付说明默认使用英文。' }] } }
    },
  }
  const { timer, queue } = fixture(t, { ordinary }, {}, async ({ pointers }) => {
    assert.deepEqual(pointers, { [record.id]: [pointer] })
    reads++
    return { additionalEvidenceByTarget: { [record.id]: reads < 4 ? [source] : [{}] } }
  })
  queue.recordReplaySource(projectId, record.id, pointer, 1000)
  await timer.advance(1000)
  assert.equal(reads, 4)
  assert.equal(invoked, 1)
  assert.equal(queue.listReports().length, 0)
  assert.equal(queue.status().counts.invalidated, 1)
})

test('open a completed historical report only with the current authorized evidence', async t => {
  const projectId = digest('project-a'), changedQuote = '更正「交付说明默认使用中文。」：改用英文。'
  const pointer = { sessionId: 'later-report-session', createdAt: 100, seq: 4, hash: digest(changedQuote) }
  const source = { ...pointer, projectId, role: 'user', sourceComplete: true, messageId: 'later-report-session:4',
    text: changedQuote, quote: changedQuote, occurredAt: new Date(1000).toISOString() }
  const correction = { items: [{ id: 'm1', verdict: 'propose-correction', sourceIds: ['s1', 's2'],
    reason: '第二段原话明确更正了默认语言。', proposedSummary: '交付说明默认使用英文。' }] }
  const ordinary = { ready: () => ({ ready: true }), async execute(_input, options) {
    await options.verifyBeforeDispatch()
    options.beforeDispatch()
    return { output: correction }
  } }
  let available = true
  const { timer, queue, runtime } = fixture(t, { ordinary }, {}, async () => ({
    additionalEvidenceByTarget: available ? { [record.id]: [source] } : {},
  }))
  queue.recordReplaySource(projectId, record.id, pointer, 1000)
  await timer.advance(1000)
  const [{ runId }] = queue.listReports()
  const shown = await runtime.openReport('project-a')
  assert.equal(shown.runId, runId)
  assert.equal(shown.items[0].sources[1].quote, changedQuote)
  assert.equal((await runtime.openReport('another-project', runId)).available, false)
  available = false
  const masked = await runtime.openReport('project-a', runId)
  assert.deepEqual(masked.items, [{ id: record.id, state: 'evidence-changed' }])
  assert.doesNotMatch(JSON.stringify(masked), /改用英文|默认使用英文/)
})

test('a Super Agent rechecks withdrawal after claiming but before any model request', async t => {
  let sent = 0, project
  const superagent = { ready: () => ({ ready: true }), async execute(_input, options) {
    options.beforeDispatch()
    project.records = []
    project.storeRevision = digest('withdrawn-before-model')
    try { await options.beforeModel() }
    catch { throw Object.assign(Error('bridge-proved-model-unsent'), { notDispatched: true }) }
    sent++
    return { output: approved }
  } }
  const setup = fixture(t, { superagent })
  project = setup.project
  const { timer, queue } = setup
  queue.requestMode('superagent')
  await timer.advance(1000)
  assert.equal(sent, 0)
  assert.equal(queue.listReports().length, 0)
  assert.equal(queue.status().counts.uncertain, undefined)
  assert.equal(queue.status().budget.tokens, 0)
})

test('installation alone leaves ordinary selected; explicit switch drains then passes the next batch', async t => {
  let installed = false, release
  const calls = []
  const ordinary = {
    ready: () => ({ ready: true }),
    execute(_input, options) {
      options.beforeDispatch()
      calls.push('ordinary')
      return new Promise(resolve => { release = resolve })
    },
  }
  const superagent = {
    ready: () => ({ ready: installed }),
    async execute(_input, options) {
      options.beforeDispatch()
      calls.push('superagent')
      return { output: approved, usage: { totalTokens: 210 } }
    },
  }
  const { timer, runtime, queue, project } = fixture(t, { ordinary, superagent })
  await timer.advance(1000)
  assert.deepEqual(calls, ['ordinary'])
  installed = true
  assert.equal(queue.status().mode, 'ordinary')
  queue.requestExecutor('superagent')
  await runtime.checkControls()
  assert.equal(queue.status().pendingMode, 'superagent')
  assert.equal(queue.status().mode, 'ordinary')
  release({ output: approved, usage: { totalTokens: 100 } })
  await flush()
  assert.equal(queue.status().mode, 'superagent')
  assert.equal(queue.status().counts.completed, 1)
  project.records = [{ ...record, id: digest('new-memory') }]
  project.storeRevision = digest('later-revision')
  await timer.advance(24 * 60 * 60_000 + 1)
  assert.deepEqual(calls, ['ordinary', 'superagent'])
  assert.equal(queue.status().counts.completed, 2)
  installed = false
  queue.requestExecutor('ordinary')
  await runtime.checkControls()
  assert.equal(queue.status().mode, 'ordinary')
  assert.equal(queue.listReports().length, 2)
})

test('requesting a missing Super Agent leaves the ordinary executor selected', async t => {
  const { queue, runtime } = fixture(t, {
    ordinary: { ready: () => ({ ready: true }) },
    superagent: { ready: () => ({ ready: false }) },
  })
  queue.requestExecutor('superagent')
  await runtime.checkControls()
  assert.equal(queue.status().executorRequest.status, 'rejected')
  assert.equal(queue.status().mode, 'ordinary')
  assert.equal(queue.status().pendingMode, null)
})

test('project revision changed in flight rejects the result without accepting a report', async t => {
  let release
  const ordinary = {
    ready: () => ({ ready: true }),
    execute(_input, options) {
      options.beforeDispatch()
      return new Promise(resolve => { release = resolve })
    },
  }
  const { timer, queue, project } = fixture(t, { ordinary })
  await timer.advance(1000)
  assert.equal(queue.status().counts.dispatching, 1)
  project.storeRevision = digest('withdrawal-revision')
  project.records = []
  release({ output: approved, usage: { totalTokens: 100 } })
  await flush()
  assert.equal(queue.status().counts.invalidated, 1)
  assert.equal(queue.status().counts.completed ?? 0, 0)
})

test('large new evidence uses a smaller batch and retains unreviewed entries', async t => {
  const seen = []
  const ordinary = {
    ready: () => ({ ready: true }),
    async execute(input, options) {
      options.beforeDispatch()
      seen.push(input.items.length)
      return {
        output: { items: input.items.map((_item, index) =>
          ({ id: 'm' + (index + 1), verdict: 'keep', sourceIds: ['s' + (index + 1)], reason: '原话支持现行记录。' })) },
        usage: { totalTokens: 100 },
      }
    },
  }
  const { timer, queue, project } = fixture(t, { ordinary }, { maxDailyTokens: 5700 })
  project.records = Array.from({ length: 5 }, (_, index) => {
    const messageId = 'message-' + index
    const longQuote = '用户已经确认项目交付说明的字数和格式。'.repeat(24)
    return { ...record, id: digest('item-' + index), evidence: [{ messageId, quote: longQuote, hash: digest(longQuote) }],
      sources: [digest(JSON.stringify([sessionId, messageId]))] }
  })
  await timer.advance(1000)
  assert.equal(queue.status().counts.completed, 1)
  assert.equal(seen.length, 1)
  assert.ok(seen[0] > 0 && seen[0] < 5)
  await timer.advance(1000)
  assert.ok(queue.listQueued().length > 0)
})
