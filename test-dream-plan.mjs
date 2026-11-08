import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const { planDream } = await import(join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'dream.mjs'))
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function store() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dream-'))
  writeFileSync(join(root, 'MEMORY.md'), [
    '# 索引',
    '',
    '## project',
    '',
    '- [project] 重复条目 — project.md',
    '- [project] 重复条目 — project.md',
    '- [project] 指向缺失文件 — missing.md',
    '- [project] 当前版本 v0.2.0 — project.md',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'project.md'), '# project\n\n## 一\n\n正文。\n')
  return root
}

test('做梦 P0：只生成 op 计划，不改任何文件、不调模型', () => {
  const root = store()
  try {
    const before = hash(join(root, 'MEMORY.md'))
    const plan = planDream(root)
    assert.equal(plan.readOnly, true)
    assert.equal(plan.applySupported, false)
    assert.equal(plan.modelCalls, 0)
    const kinds = plan.ops.map((op) => op.kind)
    assert.ok(kinds.includes('merge-duplicate'))
    assert.ok(kinds.includes('repair-reference'))
    assert.ok(kinds.includes('compact-index') || kinds.includes('review-stale'))
    assert.ok(plan.ops.every((op) => /^[0-9a-f]{12}$/.test(op.opId)))
    assert.equal(hash(join(root, 'MEMORY.md')), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('做梦 P1：只自动执行 compact-index，需 reviewed 哈希，可重复执行且不二次改动', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dream-apply-'))
  try {
    const lines = ['# 索引', '', '## project', '']
    for (let index = 0; index < 302; index += 1) lines.push(`- [project] 条目 ${index} 编号 ${index} — project.md`)
    writeFileSync(join(root, 'MEMORY.md'), lines.join('\n') + '\n')
    writeFileSync(join(root, 'project.md'), '# project\n\n## 一\n\n正文。\n')
    const { planDream, applyDream, planHash } = await import(join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'dream.mjs'))
    const before = hash(join(root, 'MEMORY.md'))
    const plan = planDream(root)
    const compact = plan.ops.filter((op) => op.kind === 'compact-index')
    assert.ok(compact.length >= 1, '超限库应产生 compact-index op')
    assert.throws(() => applyDream(plan, 'deadbeef'), /dream-review-hash-mismatch/)
    const result = applyDream(plan, planHash(plan))
    assert.equal(result.applied >= 1, true)
    assert.ok(result.backup !== null && Object.keys(result.backup).length >= 1)
    assert.ok(result.verification.every((row) => row.ok))
    assert.ok(readFileSync(join(root, 'MEMORY.md'), 'utf8') !== readFileSync(Object.values(result.backup)[0] + '/MEMORY.md', 'utf8') || hash(join(root, 'MEMORY.md')) !== before)
    const again = planDream(root)
    const compactAgain = again.ops.filter((op) => op.kind === 'compact-index')
    assert.equal(compactAgain.length, 0, '应用后不应再产生 compact-index op')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
