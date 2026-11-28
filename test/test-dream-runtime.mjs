import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as wait } from 'node:timers/promises'
import { createDreamRuntime, renderDreamReport } from '../dream-runtime.mjs'
import { createOrdinaryDreamExecutor, normalizeDreamUsage } from '../dream-ordinary.mjs'
import { buildDreamEvidence } from '../dream-review.mjs'
import { openDreamQueue } from '../dream-queue.mjs'
import { normalizePluginConfig } from '../plugin-config.mjs'
import { apply, searchStore, storeDirFor, withdrawManagedSource } from '../index.mjs'
import { writeFixtureMemory } from '../fixture-host.mjs'
import { candidateSnapshot } from '../candidates.mjs'
import { episodeSnapshot } from '../episodes.mjs'
import { planDreamCorrection, prepareDreamCorrection } from '../dream-auto-apply.mjs'

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
const hashPacket = value => digest(JSON.stringify(value))

const before = '正式交付说明默认用中文，内部审片批注用中文。'
const after = '正式交付说明默认用英文，内部审片批注用中文。'
const correction = `更正「${before}」→「${after}」`
const applicability = { kind: 'decision',
  conditions: [{ dimension: 'approval', value: 'signed' }],
  except: [{ dimension: 'audience', value: 'internal_review' }] }

function preparedCorrection({ old = before, next = after, message = `更正「${old}」→「${next}」`,
  proposed = next, proofOnly = false, later = true, skipCitation = false, multiple = false } = {}) {
  const projectId = digest('synthetic-project'), storeRevision = digest('initial-revision')
  const parent = { ...record, summary: old, type: 'project', createdAt: new Date(1000).toISOString(),
    indexLine: `- [project] ${old} — 索引摘要`, meaning: applicability, expires: '2030-12-12' }
  const pointer = { sessionId: 'correction-owner', seq: 4, hash: digest(message) }
  const source = { ...pointer, projectId, role: 'user', sourceComplete: true, messageId: 'correction-owner:4',
    text: message, quote: message, occurredAt: new Date(later ? 2000 : 1000).toISOString(), wholeOwnerMessage: !proofOnly, liveCursor: 6 }
  const proof = { pointers: { [parent.id]: [pointer] }, additionalEvidenceByTarget: { [parent.id]: [source] } }
  const input = buildDreamEvidence({ projectId, storeRevision, records: [parent], ...proof, now: 3000 })
  const row = { id: parent.id, verdict: 'propose-correction', proposedSummary: proposed, evidenceDigest: hashPacket(input.items[0]),
    pointerDigest: hashPacket([pointer]), sourceIds: input.items[0].sources.map(source => source.id).slice(0, skipCitation ? 1 : 2) }
  return { report: { projectId, storeRevision, items: multiple ? [row, { ...row, id: digest('another-target') }] : [row] }, input, proof, parent }
}

test('automatic admission changes one explicit primary value and preserves the complete prior guard', () => {
  const prepared = preparedCorrection(), plan = planDreamCorrection(prepared)
  assert.equal(plan.after, after)
  const compiled = prepareDreamCorrection(plan, prepared.parent)
  assert.deepEqual(compiled.meaning.conditions, applicability.conditions)
  assert.deepEqual(compiled.meaning.except, applicability.except)
  assert.equal(compiled.expires, '2030-12-12')
  assert.equal(compiled.fieldLineage.parentId, record.id)
  const version = preparedCorrection({ old: '交付模板版本为 V1', next: '交付模板版本为 V2' })
  assert.ok(planDreamCorrection(version))
  for (const guard of [{ dimension: 'template', value: 'release-v1' }, { dimension: 'release_v2', value: 'signed' }]) {
    assert.equal(prepareDreamCorrection(planDreamCorrection(version), {
      ...version.parent, meaning: { ...applicability, except: [guard] },
    }), undefined)
  }
  const english = preparedCorrection({ old: 'Export format is PDF', next: 'Export format is DOCX', message: 'Correction: "Export format is PDF" -> "Export format is DOCX"' })
  assert.equal(planDreamCorrection(english).after, 'Export format is DOCX')
})

test('automatic admission abstains from trial, incomplete, old, nonmatching and ambiguous evidence', () => {
  for (const options of [
    { message: correction + ' 不要写入记忆' }, { message: correction + '，先试行。' },
    { message: `供模型测试用：${correction}` }, { proposed: '报告说明今后统一用英文' },
    { old: '签字前交付模板版本为 V1', next: '签字前交付模板版本为 V2' },
    { next: '正式交付说明默认用中文，内部审片批注用英文。' },
    { old: '第1章交付说明默认用中文。', next: '第2章交付说明默认用中文。' },
    { proofOnly: true }, { later: false }, { skipCitation: true }, { multiple: true },
  ]) assert.equal(planDreamCorrection(preparedCorrection(options)), undefined, JSON.stringify(options))
  const cold = preparedCorrection()
  delete cold.proof.additionalEvidenceByTarget[record.id][0].liveCursor
  assert.equal(planDreamCorrection(cold), undefined)
})

async function managedIdleFixture(t, { autoApply, failQueueReceipt = false, laterOwnerTurn = false, sourceKind = 'live' }, verify) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-managed-')))
  const home = join(base, 'home'), cwd = join(base, 'project'), root = join(home, 'memory')
  mkdirSync(home); mkdirSync(cwd)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const events = [], handlers = [], tools = [], effects = [], sessions = new Map()
  const header = { id: 'dream-live-owner', cwd, createdAt: Date.now() - 200, version: 4, isSeeded: false }
  const session = { id: header.id, header, get seq() { return events.length } }
  if (sourceKind === 'live') sessions.set(session.id, session)
  const llm = { async prepareCall(config) { return { config, async* stream(request) {
    assert.equal(request.purpose, 'memory-dream-review')
    yield { type: 'text-delta', text: JSON.stringify({ items: [{ id: 'm1', verdict: 'propose-correction',
      sourceIds: ['s1', 's2'], reason: '更正保留了原有条件和例外。', proposedSummary: after }] }) }
    yield { type: 'finish', usage: { inputTokens: 100, outputTokens: 50 } }
  } } } }
  const ctx = { llm, systemPrompt: { context() {} }, workingDirectory: { get: () => cwd },
    tools: { register(tool) { tools.push(tool) } }, on(event, fn) { handlers.push([event, fn]) },
    effect(fn) { const stop = fn(); if (typeof stop === 'function') effects.push(stop) }, sessions,
    sessionPersistence: { async stat() { return { header, sizeBytes: 1024, revision: 'known' } } },
    sessionQuery: { async observeSession(id) {
      assert.equal(id, session.id)
      return { source: sourceKind, header, events: [...events], cursor: events.length - 1, inheritedEventCount: 0,
        revision: 'known', [Symbol.dispose]() {} }
    } },
  }
  const config = { autoCapture: { enabled: false }, dream: { enabled: true, autoApply, projects: [cwd],
    idleMs: 1000, timeoutMs: 2500, provider: 'fixture', model: 'fixture' } }
  const stop = () => { for (const effect of effects.splice(0).reverse()) effect(); handlers.length = 0; tools.length = 0 }
  const emit = (eventSession, event) => { for (const [name, fn] of handlers) if (name === 'session/event') fn(eventSession, event) }
  const user = (seq, time, text) => ({ seq, time, type: 'user/message', surfaceOp: 'append',
    data: { id: `owner-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  let queue, db
  try {
    apply(ctx, config)
    const dir = storeDirFor('project', cwd)
    const expires = `${new Date().getUTCFullYear() + 2}-12-12`
    writeFixtureMemory({ dir, type: 'project', summary: before, meaning: applicability, expires })
    const original = candidateSnapshot(dir, 'project').records[0]
    queue = openDreamQueue(root, { existingOnly: true })
    if (failQueueReceipt) {
      db = new DatabaseSync(join(root + '.dream', 'state.sqlite'))
      db.exec(`CREATE TRIGGER simulate_lost_receipt BEFORE UPDATE OF state ON auto_applications
        WHEN NEW.state='applied' BEGIN SELECT RAISE(ABORT,'fixture-post-commit-receipt-failure'); END;`)
    }
    const time = Date.parse(original.createdAt) + 10
    const event = user(0, time, correction)
    events.push(event)
    emit(session, event)
    if (laterOwnerTurn) {
      const otherSession = { id: 'later-project-owner', header: { ...header, id: 'later-project-owner' } }
      const laterTime = laterOwnerTurn === 'clock-backward' ? time - 1 : time + 30
      const laterText = laterOwnerTurn === 'oversized' ? '不要写入。'.repeat(20000) : '请不要写入刚才的更正。'
      emit(otherSession, user(5000, laterTime, laterText))
    }
    async function until(read) {
      const deadline = Date.now() + 3600
      do {
        const state = read()
        if (state) return state
        await wait(20)
      } while (Date.now() < deadline)
      assert.fail(`DREAM fixture did not settle: ${JSON.stringify(queue.status())}`)
    }
    const run = await until(() => queue.listReports()[0])
    await verify({ queue, dir, run, original, expires, until, report(args = {}) {
      const tool = tools.find(tool => tool.name === 'memory_dream_report')
      return tool.execute({ runId: run.runId, ...args }, { agent: { session } })
    }, restart() { stop(); db?.exec('DROP TRIGGER simulate_lost_receipt;'); apply(ctx, config) } })
  } finally {
    stop()
    db?.close(); queue?.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(base, { recursive: true, force: true })
  }
}

test('the idle host atomically replaces an exact value, reconciles a missing receipt after restart, and supports guarded withdrawal', async t => {
  await managedIdleFixture(t, { autoApply: true, failQueueReceipt: true }, async f => {
    const applied = await f.until(() => candidateSnapshot(f.dir, 'project').records.find(row => row.summary === after))
    assert.deepEqual(applied.meaning.conditions, applicability.conditions)
    assert.deepEqual(applied.meaning.except, applicability.except)
    assert.equal(applied.expires, f.expires)
    assert.equal(applied.fieldLineage.parentId, f.original.id)
    assert.ok(f.original.sources.every(source => applied.sources.includes(source)))
    assert.equal(f.queue.autoApplication(f.run.runId).state, 'pending')
    assert.equal(searchStore(f.dir, before, { mode: 'exact' }).hits.length, 0)
    assert.equal(searchStore(f.dir, f.original.id, { mode: 'exact', view: 'history' }).hits.length, 1)
    f.restart()
    const receipt = await f.until(() => {
      const receipt = f.queue.autoApplication(f.run.runId)
      return receipt?.state === 'applied' && receipt
    })
    assert.equal(receipt.recordId, applied.id)
    const history = episodeSnapshot(f.dir).state.entries
    assert.equal(history.filter(row => row.source.id === applied.id).length, 1)
    assert.equal(history.find(row => row.source.id === f.original.id).closed.by, applied.id)
    const report = JSON.parse((await f.report()).report)
    assert.deepEqual(report.autoApplication.source, { sessionId: 'dream-live-owner', messageId: 'dream-live-owner:0' })
    assert.equal(report.autoApplication.current, true)
    const preview = JSON.parse((await f.report({ withdrawalPreview: true })).report).withdrawalPreview
    assert.equal(preview.available, true)
    assert.equal(preview.scope, 'project-preview')
    assert.equal(preview.executionScope, 'all-managed-stores')
    assert.equal(preview.restoresPreviousValue, false)
    assert.ok(preview.affected > 0)
    const later = '正式交付说明默认用日文，内部审片批注用中文。'
    writeFixtureMemory({ dir: f.dir, type: 'project', summary: later, supersedes: applied.indexLine, meaning: applicability })
    assert.equal(JSON.parse((await f.report()).report).autoApplication.current, false)
    const { sessionId, messageId } = report.autoApplication.source
    const review = withdrawManagedSource(f.dir, sessionId, messageId)
    withdrawManagedSource(f.dir, sessionId, messageId, { apply: true, controlReview: review.controlReview })
    assert.equal(searchStore(f.dir, before, { mode: 'exact' }).hits.length, 0)
    assert.equal(searchStore(f.dir, after, { mode: 'exact' }).hits.length, 0)
    assert.equal(searchStore(f.dir, later, { mode: 'exact' }).hits.length, 1)
    assert.ok(!JSON.parse((await f.report()).report).autoApplication.source)
    assert.equal(JSON.parse((await f.report({ withdrawalPreview: true })).report).withdrawalPreview.available, false)
  })
})

for (const options of [{ autoApply: false }, { autoApply: true, laterOwnerTurn: true },
  { autoApply: true, laterOwnerTurn: 'clock-backward' }, { autoApply: true, laterOwnerTurn: 'oversized' },
  { autoApply: true, sourceKind: 'prepared' }]) {
  test(`idle review remains advisory for ${JSON.stringify(options)}`, async t => {
    await managedIdleFixture(t, options, async f => {
      assert.equal(f.queue.report(f.run.runId).items[0].verdict, 'propose-correction')
      assert.equal(f.queue.autoApplication(f.run.runId), undefined)
      const report = JSON.parse((await f.report()).report)
      assert.equal(report.autoApplication.state, 'report-only')
      const expectedReason = !options.autoApply ? 'automatic-application-disabled-at-review' :
        options.laterOwnerTurn ? 'owner-activity-unverified' : 'no-eligible-correction'
      assert.equal(report.autoApplication.reason, expectedReason)
      assert.equal(f.queue.report(f.run.runId).reportOnlyReason, expectedReason)
      assert.equal(searchStore(f.dir, before, { mode: 'exact' }).hits.length, 1)
      assert.equal(searchStore(f.dir, after, { mode: 'exact' }).hits.length, 0)
    })
  })
}

function keepAll(input) {
  let source = 1
  return { items: input.items.map((item, index) => {
    const row = { id: `m${index + 1}`, verdict: 'keep', sourceIds: [`s${source}`], reason: '原话支持现行记录。' }
    source += item.sources.length
    return row
  }) }
}

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

function fixture(t, executors, options = {}, readReplay, extraProjects = {}, callbacks = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-runtime-')))
  const timer = clock()
  const queue = openDreamQueue(join(home, 'memory'), { now: timer.now, maxDailyTokens: options.maxDailyTokens })
  const project = { projectId: digest('project-a'), storeRevision: digest('initial-revision'), records: [record] }
  const runtime = createDreamRuntime({
    options: { projects: ['project-a'], idleMs: 1000, timeoutMs: 5000, provider: 'fixture', model: 'fixture', ...options },
    queue, readProject: (path, consume) => consume(path === 'project-a' ? project : extraProjects[path]), readReplay, executors,
    now: timer.now, timers: { setTimer: timer.setTimer, clearTimer: timer.clearTimer }, ...callbacks,
  })
  t.after(async () => { runtime.dispose(); await flush(); rmSync(home, { recursive: true, force: true }) })
  return { queue, project, runtime, timer, home }
}

test('a restarted runtime declines an uncommitted application from a previous owner', async t => {
  const { queue, project, timer } = fixture(t, {}, { autoApply: true }, undefined, {}, {
    readApplication() {},
    publishCorrection() { assert.fail('Uncommitted prior-runtime work cannot publish') },
  })
  const { runId } = queue.enqueue({ projectId: project.projectId, inputHash: digest('interrupted'), policyVersion: 'review-v4',
    metadata: { itemIds: [record.id], itemKeys: [record.id] } })
  const claim = queue.claim({ owner: 'past-runtime' })
  queue.beginDispatch(claim, { reservedTokens: 200 })
  queue.finish(claim, { status: 'completed', usedTokens: 100,
    report: { projectId: project.projectId, items: [{ id: record.id, verdict: 'propose-correction' }] },
    autoApplication: { targetId: record.id, operationId: digest('interrupted-application') } })
  assert.equal(queue.autoApplication(runId).state, 'pending')
  await timer.advance(1000)
  assert.equal(queue.autoApplication(runId).state, 'skipped')
  assert.equal(queue.autoApplication(runId).reason, 'runtime-interrupted')
})

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
  const { timer, queue, runtime, project, home } = fixture(t, { ordinary }, {}, async () => ({
    additionalEvidenceByTarget: available ? { [record.id]: [source] } : {},
  }))
  queue.recordReplaySource(projectId, record.id, pointer, 1000)
  await timer.advance(1000)
  const [{ runId }] = queue.listReports()
  const shown = await runtime.openReport('project-a')
  assert.equal(shown.runId, runId)
  assert.equal(shown.autoApplication.reason, 'automatic-application-disabled-at-review')
  const oldReport = queue.report(runId)
  delete oldReport.reportOnlyReason
  const db = new DatabaseSync(join(home, 'memory.dream', 'state.sqlite'))
  try { db.prepare('UPDATE reports SET payload = ? WHERE run_id = ?').run(JSON.stringify(oldReport), runId) } finally { db.close() }
  assert.equal((await runtime.openReport('project-a', runId)).autoApplication.reason, 'application-reason-not-recorded')
  assert.equal(shown.items[0].sources[1].quote, changedQuote)
  const preview = shown.items[0].preview
  assert.match(preview.id, /^[a-f0-9]{64}$/)
  assert.equal(preview.storeRevision, project.storeRevision)
  const reopen = expectedPreviewId => runtime.openReport('project-a', runId, undefined, { targetId: record.id, expectedPreviewId })
  assert.equal((await reopen(preview.id)).items[0].preview.id, preview.id)
  assert.equal((await runtime.openReport('project-a', undefined, undefined,
    { targetId: record.id, expectedPreviewId: preview.id })).reason, 'dream-preview-unavailable')
  project.storeRevision = digest('new-store-revision')
  assert.deepEqual(await reopen(preview.id), { available: false, reason: 'dream-preview-stale' })
  const renewed = (await runtime.openReport('project-a', runId)).items[0].preview
  assert.notEqual(renewed.id, preview.id)
  assert.equal(renewed.storeRevision, project.storeRevision)
  assert.equal((await reopen(renewed.id)).available, true)
  assert.equal((await runtime.openReport('another-project', runId)).available, false)
  available = false
  assert.deepEqual(await reopen(renewed.id), { available: false, reason: 'dream-preview-stale' })
  const masked = await runtime.openReport('project-a', runId)
  assert.deepEqual(masked.items, [{ id: record.id, state: 'evidence-changed' }])
  assert.doesNotMatch(JSON.stringify(masked), /改用英文|默认使用英文/)
})

test('new work prioritizes replay, conflict and changed reviewed work and skips unchanged review across revisions', async t => {
  const seen = []
  const ordinary = { ready: () => ({ ready: true }), async execute(input, options) {
    options.beforeDispatch()
    seen.push(input.items.map(item => item.id))
    return { output: keepAll(input), usage: { totalTokens: 120 } }
  } }
  const { timer, queue, project, runtime } = fixture(t, { ordinary })
  const reviewed = record
  await timer.advance(1000)
  assert.deepEqual(seen, [[reviewed.id]])
  project.storeRevision = digest('unrelated-only-revision')
  await timer.advance(1000)
  assert.equal(seen.length, 1)
  assert.equal(queue.listQueued().length, 0)

  function entry(name) {
    return { ...record, id: digest(name), createdAt: new Date(5000).toISOString() }
  }
  const conflict = entry('conflict'), correction = entry('replay'), unchanged = entry('newer-ordinary')
  const supporting = { ...entry('counter-source'), sessionId: 'related-session',
    sources: [hashPacket(['related-session', messageId])] }
  const message = '交付说明改用英文。'
  project.records = [unchanged, supporting, { ...reviewed, summary: '交付说明使用中文。' }, conflict, correction]
  project.relatedRecordIdsByTarget = { [conflict.id]: [supporting.id] }
  project.additionalEvidenceByTarget = { [correction.id]: [{ projectId: project.projectId, role: 'user',
    sourceComplete: true, sessionId: 'correction-session', messageId: 'correction-message', quote: message, text: message,
    hash: digest(message), occurredAt: new Date(7000).toISOString() }] }
  project.storeRevision = digest('changed-and-new')
  runtime.scheduler.wake()
  await timer.advance(24 * 60 * 60_000)
  assert.deepEqual(seen[1].slice(0, 3), [correction.id, conflict.id, reviewed.id])
  assert.equal(queue.listReports().length, 2)
})

test('temporary replay failure remains eligible and confirmed lost evidence uses no model or daily attempt', async t => {
  const changedQuote = '更正「交付说明默认使用中文。」：改用英文。'
  const pointer = { sessionId: 'deferred-source-session', createdAt: 100, seq: 4, hash: digest(changedQuote) }
  let loss = 'query-unavailable', invoked = 0
  const setup = fixture(t, { ordinary: { ready: () => ({ ready: false }), async execute() { invoked++ } } }, {}, async () => ({
    additionalEvidenceByTarget: { [record.id]: [{}] }, skips: [{ targetId: record.id, reason: loss }],
  }))
  const { timer, queue, project, runtime } = setup
  queue.recordReplaySource(project.projectId, record.id, pointer, 1000)
  await timer.advance(1000)
  assert.equal(queue.listReports().length, 0)
  assert.equal(queue.listQueued().length, 0)

  loss = 'source-withdrawn'
  runtime.scheduler.wake()
  await timer.advance(1000)
  assert.equal(invoked, 0)
  assert.equal(queue.status().budget.attempts, 0)
  assert.equal(queue.status().budget.tokens, 0)
  const [{ runId }] = queue.listReports()
  assert.equal(queue.report(runId).items[0].verdict, 'needs-evidence')
  assert.equal(queue.report(runId).items[0].reviewMethod, 'evidence-check')
  await timer.advance(1000)
  assert.equal(queue.listReports().length, 1)
})

test('saved v3 batches keep their executor contract and reviewed keys', async t => {
  let invoked = 0
  const ordinary = { ready: () => ({ ready: true }), async execute(_input, options) {
    options.beforeDispatch()
    invoked++
    return { output: approved }
  } }
  const { timer, queue, project } = fixture(t, { ordinary })
  const input = buildDreamEvidence({ ...project, now: timer.now() })
  const key = hashPacket([record.id, record.summary, record.meaning, record.expires, record.evidence, [], []])
  const prior = queue.enqueue({ projectId: project.projectId, inputHash: hashPacket(input), policyVersion: 'solopup-project-review-v3',
    metadata: { itemIds: [record.id], itemKeys: [key] } })
  await timer.advance(1000)
  assert.equal(invoked, 1)
  assert.equal(queue.getRun(prior.runId).status, 'completed')
  assert.equal(queue.wasReviewed(project.projectId, key), true)
  project.storeRevision = digest('next-revision')
  await timer.advance(1000)
  assert.equal(queue.listQueued().length, 0)
  assert.equal(invoked, 1)
})

test('temporarily unavailable v3 replay stays queued without blocking another project or consuming a model attempt', async t => {
  const message = '更正「交付说明默认使用中文。」：改用英文。'
  const pointer = { sessionId: 'deferred-v3', createdAt: 100, seq: 4, hash: digest(message) }
  const other = { projectId: digest('project-b'), storeRevision: digest('project-b-revision'), records: [record] }
  const calls = []
  const ordinary = { ready: () => ({ ready: true }), async execute(input, options) {
    await options.verifyBeforeDispatch?.()
    options.beforeDispatch()
    calls.push(input.projectId)
    return { output: keepAll(input) }
  } }
  let available = false
  const { timer, queue, project } = fixture(t, { ordinary }, { projects: ['project-a', 'project-b'] }, async () => {
    if (!available) throw Error('session-query-service-restarted')
    return { additionalEvidenceByTarget: { [record.id]: [source] }, skips: [] }
  }, { 'project-b': other })
  const source = { projectId: project.projectId, role: 'user', sourceComplete: true, sessionId: pointer.sessionId,
    messageId: `${pointer.sessionId}:${pointer.seq}`, text: message, quote: message, hash: pointer.hash,
    occurredAt: new Date(1000).toISOString() }
  const key = hashPacket([record.id, record.summary, record.meaning, record.expires, record.evidence, [], [pointer]])
  const input = buildDreamEvidence({ ...project, additionalEvidenceByTarget: { [record.id]: [source] }, now: timer.now() })
  const prior = queue.enqueue({ projectId: project.projectId, inputHash: hashPacket(input), policyVersion: 'solopup-project-review-v3',
    metadata: { itemIds: [record.id], itemKeys: [key] } })
  queue.recordReplaySource(project.projectId, record.id, pointer, 1000)

  await timer.advance(1000)
  assert.deepEqual(calls, [])
  assert.equal(queue.getRun(prior.runId).status, 'queued')
  assert.equal(queue.status().budget.attempts, 0)
  await timer.advance(1000)
  assert.deepEqual(calls, [other.projectId])
  available = true
  await timer.advance(59_000)
  assert.deepEqual(calls, [other.projectId, project.projectId])
  assert.equal(queue.getRun(prior.runId).status, 'completed')
})

test('a v3 batch previously queued with missing replay evidence is never dispatched with that proof still unavailable', async t => {
  const pointer = { sessionId: 'incomplete-v3', createdAt: 100, seq: 4, hash: digest('replacement') }
  let loss = 'query-unavailable'
  const dispatched = []
  const ordinary = { ready: () => ({ ready: true }), async execute(input, options) {
    await options.verifyBeforeDispatch?.()
    options.beforeDispatch()
    dispatched.push(input)
    return { output: { items: [{ id: 'm1', verdict: 'needs-evidence', sourceIds: [], reason: '原话缺失。' }] } }
  } }
  const { timer, queue, project } = fixture(t, { ordinary }, {}, async () => ({
    additionalEvidenceByTarget: { [record.id]: [{}] }, skips: [{ targetId: record.id, reason: loss }],
  }))
  const key = hashPacket([record.id, record.summary, record.meaning, record.expires, record.evidence, [], [pointer]])
  const input = buildDreamEvidence({ ...project, additionalEvidenceByTarget: { [record.id]: [{}] }, now: timer.now() })
  const prior = queue.enqueue({ projectId: project.projectId, inputHash: hashPacket(input), policyVersion: 'solopup-project-review-v3',
    metadata: { itemIds: [record.id], itemKeys: [key] } })
  queue.recordReplaySource(project.projectId, record.id, pointer, 1000)

  await timer.advance(1000)
  assert.equal(queue.getRun(prior.runId).status, 'queued')
  assert.deepEqual(dispatched, [])
  loss = 'source-replaced'
  await timer.advance(60_000)
  assert.equal(queue.getRun(prior.runId).status, 'invalidated')
  await timer.advance(1000)
  assert.deepEqual(dispatched, [])
  assert.equal(queue.status().budget.attempts, 0)
  const [{ runId }] = queue.listReports()
  assert.equal(queue.report(runId).items[0].reviewMethod, 'evidence-check')
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
  const { timer, queue, project } = fixture(t, { ordinary }, { maxDailyTokens: 6500 })
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
