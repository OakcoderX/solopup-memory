import { test } from 'node:test'
import assert from 'node:assert/strict'

const { runSuite, CASES } = await import('../eval/semantic-suite.mjs')

test('L2 管道保真套件：冻结用例全部通过', () => {
  const report = runSuite()
  assert.equal(report.cases, CASES.length)
  assert.equal(report.failed, 0, report.results.filter((row) => !row.ok).map((row) => `${row.id}: ${row.error}`).join('\n'))
  assert.ok(report.assertions >= 15)
  assert.equal(report.semanticTruthEvaluated, false)
})

test('L2 套件自检：被改坏的期望必须失败（防止空转全绿）', () => {
  const base = CASES.find((row) => row.id === 'quote-must-be-verbatim')
  const broken = { ...base, id: 'broken-expectation', expect: { status: 'eligible' } }
  const report = runSuite([broken])
  assert.equal(report.failed, 1)
  assert.match(report.results[0].error, /eligible/)
})
