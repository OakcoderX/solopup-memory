import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzePairs, signTail } from './eval/paired-analysis.mjs'

test('配对精确检验：已知二项尾概率', () => {
  assert.equal(signTail(0, 0), 1)
  assert.ok(Math.abs(signTail(5, 0) - 1 / 32) < 1e-12)
  assert.ok(Math.abs(signTail(2, 2) - 11 / 16) < 1e-12)
  assert.ok(signTail(1000, 0) < 1e-100)
})
test('配对检验：重复运行不能伪装独立样本', () => {
  const report = analyzePairs([{ id: 'one', ours: Array(100).fill(true), baseline: Array(100).fill(false) }])
  assert.equal(report.scenarios, 1)
  assert.ok(Math.abs(report.oneSidedSignP - 0.5) < 1e-12)
})
test('配对检验：相同与反向结果不产生胜出结论', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, ours: [false], baseline: [true] }))
  assert.equal(analyzePairs(rows).oneSidedSignP, 1)
  assert.match(analyzePairs(rows).conclusion, /statistics-only/)
})
test('配对检验：失败、缺失、重复编号不能静默从分母删除', () => {
  const row = { id: 'a', ours: [true], baseline: [false] }
  assert.throws(() => analyzePairs([row, row]), /duplicate/)
  assert.throws(() => analyzePairs([{ ...row, baseline: [] }]), /unpaired/)
  assert.throws(() => analyzePairs([{ ...row, ours: [null] }]), /boolean/)
})
