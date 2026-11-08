import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { detectRoot, detectStore } from './detect.mjs'

function store(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-detect-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

function ids(report) {
  return report.findings.map((finding) => finding.id)
}

test('检测：干净库不报错，锚点用折叠比较（标题带标点也能解析）', () => {
  const dir = store({
    'MEMORY.md': '# 记忆索引\n\n## user\n\n- [user] 中文母语 — user.md#身份说明\n',
    'user.md': '## 身份 说明\n\n中文母语写作者。\n',
  })
  try {
    const report = detectStore(dir)
    assert.equal(report.summary.errors, 0)
    assert.ok(!ids(report).includes('I2-missing-anchor'))
    assert.equal(report.metrics.indexLines, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('检测：坏索引行、缺失主题文件、重复行、冲突签名都会被报出来', () => {
  const dir = store({
    'MEMORY.md': [
      '# 记忆索引',
      '',
      '## project',
      '',
      '- [nope] 类型不合法 — user.md',
      '- [project] 剧本上限 100 集 — missing.md',
      '- [project] 剧本上限 120 集 — project.md',
      '- [project] 剧本上限 120 集 — project.md',
      '',
    ].join('\n'),
    'project.md': '## 正文\n\n剧本上限 120 集。\n',
  })
  try {
    const report = detectStore(dir, { scope: 'project' })
    const seen = ids(report)
    assert.ok(seen.includes('I1-invalid-index-line'))
    assert.ok(seen.includes('I2-missing-topic-file'))
    assert.ok(seen.includes('I6-duplicate-line'))
    assert.ok(seen.includes('I7-conflict'))
    assert.equal(report.summary.errors >= 2, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('检测：预算超限与过期标记语法错误', () => {
  const lines = ['# 记忆索引', '', '## user', '']
  for (let i = 0; i < 302; i += 1) lines.push(`- [user] 条目 ${i} — user.md`)
  const dir = store({ 'MEMORY.md': lines.join('\n'), 'user.md': '# 用户\n' })
  try {
    const report = detectStore(dir)
    const seen = ids(report)
    assert.ok(seen.includes('I8-budget-lines'))
    assert.equal(report.metrics.indexLines, 302)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('检测：根目录会报告空库与内容完全相同的重复库', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-detect-root-'))
  const projectA = join(root, 'projects', 'v2-a')
  const projectB = join(root, 'projects', 'v2-b')
  const empty = join(root, 'projects', 'v2-empty')
  mkdirSync(projectA, { recursive: true })
  mkdirSync(projectB, { recursive: true })
  mkdirSync(empty, { recursive: true })
  const body = '# 记忆索引\n\n## project\n\n- [project] 同一条 — project.md\n'
  writeFileSync(join(root, 'MEMORY.md'), body)
  writeFileSync(join(projectA, 'MEMORY.md'), body)
  writeFileSync(join(projectB, 'MEMORY.md'), body)
  try {
    const report = detectRoot(root)
    const seen = report.crossFindings.map((finding) => finding.id)
    assert.ok(seen.includes('X1-empty-project-store'))
    assert.ok(seen.includes('X2-duplicate-store'))
    assert.equal(report.stores.length, 4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('检测：正文块出现在标题之前会被提示（结构检查）', () => {
  const dir = store({
    'MEMORY.md': '# 记忆索引\n\n## feedback\n\n- [feedback] 先读再改 — feedback.md\n',
    'feedback.md': '[candidate:aaaaaaaa]\n先读再改\n',
  })
  try {
    const report = detectStore(dir)
    assert.ok(ids(report).includes('I14-candidate-without-heading'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('检测：段落以未完成标点结尾会被标记为截断；列表引导句不误报', () => {
  const dir = store({
    'MEMORY.md': '# 索引\n\n## user\n\n- [user] 一条 — user.md\n',
    'user.md': '# user\n\n## 记录\n\n主要产出：\n\n- 剧本\n- 剪辑\n\n- 2026-10-28｜交接文件需自带上下文，\n',
  })
  try {
    const report = detectStore(dir)
    const truncated = report.findings.filter((finding) => finding.id === 'I14-truncated-paragraph')
    assert.equal(truncated.length, 1)
    assert.match(truncated[0].message, /交接文件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
