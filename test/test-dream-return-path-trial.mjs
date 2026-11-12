import assert from 'node:assert/strict'
import test from 'node:test'
import { dreamReturnPlan, dreamReturnRubric, previousReturnUsage, scoreDreamReturn } from '../eval/dream-return-path-trial.mjs'

test('return-path fixture freezes five source-bound questions and a balanced shuffled trial', () => {
  const first = dreamReturnPlan()
  assert.deepEqual(dreamReturnPlan(), first)
  assert.equal(first.jobs.length, 20)
  assert.equal(new Set(first.jobs.map(job => job.arm + ':' + job.questionId)).size, 20)
  assert.equal(first.jobs.filter(job => job.arm === 'raw-only').length, 5)
  assert.deepEqual(dreamReturnRubric().map(row => row.id), first.questionIds)
  for (const row of dreamReturnRubric()) {
    assert.ok(row.sources.length > 0 && row.sources.every(source => /^[a-f0-9]{64}$/.test(source.sourceId)))
  }
})

test('blind acceptance requires corrected old value, citations, no new critical error and a matching negative control', () => {
  const plan = dreamReturnPlan()
  const rows = plan.jobs.map((job, index) => ({ ...job, label: 'blind-' + index, status: 'completed' }))
  const grades = Object.fromEntries(rows.map(row => [row.label, {
    correctDecision: row.arm !== 'old-memory' || row.questionId !== 'C01',
    correctScope: true, correctCitation: true, criticalError: false,
  }]))
  const receipt = { fixtureSha256: plan.fixtureSha256, rows, controls: { reportOnlyProjectionMatched: true }, transport: 'real-model' }
  const passed = scoreDreamReturn({ receipt, grades })
  assert.equal(passed.passed, true)
  assert.deepEqual(passed.summary['old-memory'], { passed: 4, criticalErrors: 0 })
  assert.equal(scoreDreamReturn({ receipt: { ...receipt, transport: 'scripted' }, grades }).passed, false)
  const corrected = rows.find(row => row.arm === 'corrected-memory' && row.questionId === 'C01')
  grades[corrected.label].correctCitation = false
  assert.equal(scoreDreamReturn({ receipt, grades }).improvedOldValue, false)
  grades[corrected.label].correctCitation = true
  const other = rows.find(row => row.arm === 'corrected-memory' && row.questionId === 'C02')
  grades[other.label].criticalError = true
  assert.equal(scoreDreamReturn({ receipt, grades }).noNewCriticalError, false)
  assert.throws(() => scoreDreamReturn({ receipt: { ...receipt, rows: rows.slice(0, 19) }, grades }), /incomplete-receipt/)
})

test('retry charges a stopped return receipt only when every dispatched row is measured and trial bindings match', () => {
  const plan = dreamReturnPlan()
  const candidateSha256 = 'a'.repeat(64)
  const route = { provider: 'test-provider', model: 'test-model' }
  const prior = { sha256: 'b'.repeat(64), trialId: 'completed-review' }
  const earlier = [{ sha256: 'c'.repeat(64), trialId: 'stopped-review', usage: { calls: 1, inputTokens: 600, outputTokens: 300 } }]
  const totals = { calls: 5, inputTokens: 1400, outputTokens: 700 }
  const rows = plan.jobs.map((job, index) => ({ ...job,
    label: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, status: 'queued',
  }))
  Object.assign(rows[0], { status: 'completed', requestSha256: 'd'.repeat(64), answerSha256: 'e'.repeat(64),
    usage: { calls: 1, inputTokens: 800, outputTokens: 100 } })
  Object.assign(rows[1], { status: 'failed', requestSha256: 'f'.repeat(64), usage: { calls: 1, inputTokens: 900, outputTokens: 368 } })
  const receipt = { schema: 1, status: 'stopped', transport: 'real-model', providerThinking: 'explicit-off',
    seed: plan.seed, fixtureSha256: plan.fixtureSha256, candidateSha256, route, earlierReceipts: earlier,
    priorReceiptSha256: prior.sha256, priorTrialId: prior.trialId, rows,
    totals: { calls: 7, inputTokens: 3100, outputTokens: 1168 },
  }
  const binding = { candidateSha256, route, prior, earlier, totals }
  assert.equal(plan.generationMaxTokens, 600)
  assert.equal(plan.outputTokenReservation, 680)
  assert.deepEqual(previousReturnUsage(receipt, binding), { calls: 2, inputTokens: 1700, outputTokens: 468 })
  assert.throws(() => previousReturnUsage({ ...receipt, candidateSha256: 'f'.repeat(64) }, binding), /previous-return-mismatch/)
  assert.throws(() => previousReturnUsage({ ...receipt, priorReceiptSha256: 'f'.repeat(64) }, binding), /previous-return-mismatch/)
  assert.throws(() => previousReturnUsage({ ...receipt, totals: { ...receipt.totals, outputTokens: 1167 } }, binding), /previous-return-incomplete/)
  rows[1].status = 'uncertain'
  delete rows[1].usage
  assert.throws(() => previousReturnUsage(receipt, binding), /previous-return-incomplete/)
})
