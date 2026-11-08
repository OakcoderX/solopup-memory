import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { collect } = await import('../scripts/telemetry.mjs')

const DAY = 86_400_000

function audit(now) {
  const at = (daysAgo) => new Date(now - daysAgo * DAY).toISOString()
  return [
    { op: 'capture', outcome: 'ok', inserted: 1, at: at(10) },
    { op: 'capture', outcome: 'ok', inserted: 0, at: at(9) },
    { op: 'capture', outcome: 'error', at: at(8) },
    { op: 'capture', outcome: 'error', at: at(7) },
    { op: 'capture', outcome: 'rejected', at: at(6) },
    { op: 'capture', outcome: 'skipped', reason: 'short-session-below-threshold', at: at(5) },
    { op: 'capture', outcome: 'skipped', reason: 'short-session-below-threshold', at: at(4) },
    { op: 'capture', outcome: 'skipped', reason: 'short-session-below-threshold', at: at(3) },
  ]
}

test('遥测：捕获成功率、零产出天数与短会话跳过都能算出来', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-telemetry-'))
  const now = Date.parse('2026-11-08T10:00:00.000Z')
  try {
    writeFileSync(join(root, 'MEMORY.md'), '# 索引\n\n## project\n\n- [project] 一条 — project.md\n')
    mkdirSync(join(root, 'projects', 'v2-x'), { recursive: true })
    writeFileSync(join(root, 'projects', 'v2-x', 'MEMORY.md'), '# 索引\n\n## project\n\n- [project] 两条 — project.md\n')
    writeFileSync(join(root, '.audit.jsonl'), audit(now).map((event) => JSON.stringify(event)).join('\n') + '\n')
    const report = collect(root, now)
    assert.equal(report.capture.total, 8)
    assert.equal(report.capture.skipped, 3)
    assert.equal(report.capture.successRate, 0.25)
    assert.equal(report.output.zeroOutputDays, 10)
    const ids = report.warnings.map((warning) => warning.id)
    assert.ok(ids.includes('T1-low-capture-success'))
    assert.ok(ids.includes('T2-zero-output'))
    assert.ok(ids.includes('T3-short-sessions'))
    assert.equal(report.stores.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('遥测：没有账本时不编造成功率', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-telemetry-empty-'))
  try {
    writeFileSync(join(root, 'MEMORY.md'), '# 索引\n')
    const report = collect(root, Date.parse('2026-11-08T10:00:00.000Z'))
    assert.equal(report.capture.total, 0)
    assert.equal(report.capture.successRate, null)
    assert.equal(report.output.zeroOutputDays, null)
    assert.ok(report.warnings.some((warning) => warning.id === 'T5-no-memory'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
