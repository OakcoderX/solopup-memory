/**
 * 冲突检测（同一事实、不同取值）。跑法：node --test ~/.dsh/plugins/memory/test-conflict.mjs
 *
 * 规则只有一条：**非取值部分完全相同，且恰好一个取值不同** → 疑似冲突。
 * 它产生「警告」而不是「拒绝」，因为文本结构无法区分「改口」和「枚举」：
 *   「剧本定为 26 集 → 24 集」 是改口
 *   「填充 0 → 填充 1」        是并列的两行
 * 两者签名一模一样。拒绝会误伤后者，所以交给能看到上下文的人判断。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { conflictSignature, findConflict, storeDirFor, writeMemory } from './index.mjs'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-conflict-'))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    root,
    cwd,
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    },
  }
}

// ── 签名抽取 ────────────────────────────────────────────────────────────────

test('数字、日期、带数字的标识符都被替换成占位符', () => {
  assert.deepEqual(conflictSignature('剧本定为 26 集'), { signature: '剧本定为Ø集', values: ['26'] })
  assert.deepEqual(conflictSignature('2026-10-24 定稿').values, ['2026-10-24'])
  assert.deepEqual(conflictSignature('写手用 deepseek-flash').values, ['deepseek-flash'])
  assert.deepEqual(conflictSignature('v10.1 分叉点').values, ['v10.1'])
})

test('没有取值的摘要不会有签名冲突', () => {
  assert.equal(conflictSignature('改稿要附说明').values.length, 0)
})

// ── 判定 ────────────────────────────────────────────────────────────────────

const BODY = [
  '- [project] 剧本定为 26 集 — project.md',
  '- [project] E01 是 16 场 — project.md',
  '- [project] 写手用 deepseek-flash — project.md',
  '- [project] 第 3 轮盲评得分 8.7 — project.md',
].join('\n')

test('单值替换判为冲突', () => {
  assert.match(findConflict(BODY, '剧本定为 24 集'), /26 集/)
  assert.match(findConflict(BODY, 'E01 是 12 场'), /16 场/)
  assert.match(findConflict(BODY, '写手用 gemini-4-argon'), /deepseek-flash/)
})

test('两处以上不同不判冲突（并列枚举）', () => {
  assert.equal(findConflict(BODY, '第 4 轮盲评得分 9.1'), undefined)
})

test('不同主体不判冲突', () => {
  assert.equal(findConflict(BODY, 'E02 定稿 24 集'), undefined)
})

test('取值相同不算冲突（走重复分支）', () => {
  assert.equal(findConflict(BODY, '剧本定为 26 集'), undefined)
})

// ── 写入行为 ────────────────────────────────────────────────────────────────

test('冲突产生警告但两条都保留', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] 剧本定为 26 集 — project.md' })
    const second = writeMemory({ type: 'project', dir, line: '- [project] 剧本定为 24 集 — project.md' })

    assert.equal(second.duplicate, false)
    assert.match(second.warning, /疑似冲突/)
    assert.match(second.warning, /supersedes/)

    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.match(index, /26 集/)
    assert.match(index, /24 集/)
  } finally {
    box.cleanup()
  }
})

test('用 supersedes 取代时不产生冲突警告', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] 剧本定为 26 集 — project.md' })
    const result = writeMemory({
      type: 'project',
      dir,
      line: '- [project] 剧本定为 24 集 — project.md',
      supersedes: '26 集',
    })
    assert.equal(result.superseded, '- [project] 剧本定为 26 集 — project.md')
    assert.equal(result.warning, undefined)
    assert.doesNotMatch(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /26 集/)
  } finally {
    box.cleanup()
  }
})

test('审计记下警告类型', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] 剧本定为 26 集 — project.md' })
    writeMemory({ type: 'project', dir, line: '- [project] 剧本定为 24 集 — project.md' })
    const events = readFileSync(join(dir, '.audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.op === 'write')
    assert.deepEqual(events.at(-1).warnings, ['conflict'])
  } finally {
    box.cleanup()
  }
})
