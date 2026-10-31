import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from './fixture-host.mjs'
/**
 * 历史链与写入相似度闸。跑法：node --test ~/.dsh/plugins/memory/test-history.mjs
 *
 * 两件事各自的「为什么」：
 *   · 历史链：审计回答「做过什么」，历史回答「原来是什么」。取代/删除后原文必须可回溯，
 *     否则一次误取代就永久丢失（MemOS 把这种版本关系建模成 MemCube 的一部分）。
 *   · 相似度闸：同一件事换个说法再写一条，会让新旧两条同时被注入、给模型互相矛盾的信号。
 *     完全重复另有幂等分支；这里只管「像但不是同一句」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  SIMILARITY,
  
  forgetMemory,
  similarity,
  storeDirFor,
  summaryOf,
  writeMemory,
} from './index.mjs'

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-hist-')))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    root,
    cwd,
    store: join(home, 'memory'),
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// ── 历史链 ──────────────────────────────────────────────────────────────────

test('supersede 把被取代的原文写进历史，并留取代指针', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] 下一步 S3 — project.md' })
    writeMemory({
      type: 'project',
      dir,
      line: '- [project] 下一步 S4 — project.md',
      supersedes: '下一步 S3',
      provenance: { sessionId: 'sess-1', model: 'deepseek-flash' },
    })

    // 日志里还有 insert 记录（用来存关系边），这里只看取代事件
    const history = readJsonl(join(dir, '.history.jsonl')).filter((entry) => entry.op === 'supersede')
    assert.equal(history.length, 1)
    assert.equal(history[0].op, 'supersede')
    assert.equal(history[0].line, '- [project] 下一步 S3 — project.md')
    assert.equal(history[0].supersededBy, '- [project] 下一步 S4 — project.md')
    assert.equal(history[0].sessionId, 'sess-1')
    assert.match(history[0].at, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    box.cleanup()
  }
})

test('forget 把每一行被删的原文都写进历史', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'user', dir, line: '- [user] 甲 要删 — user.md' })
    writeMemory({ type: 'user', dir, line: '- [user] 乙 要删 — user.md' })
    writeMemory({ type: 'user', dir, line: '- [user] 丙 保留 — user.md' })

    // forget 现在强制唯一匹配：先断言通配会被拒，再逐条删
    assert.throws(() => forgetMemory(dir, '要删'), /匹配到 2 条/)
    assert.equal(forgetMemory(dir, '甲 要删').removed, 1)
    assert.equal(forgetMemory(dir, '乙 要删').removed, 1)

    const history = readJsonl(join(dir, '.history.jsonl')).filter((entry) => entry.op === 'forget')
    assert.equal(history.length, 2)
    assert.match(history.map((entry) => entry.line).join('\n'), /甲 要删[\s\S]*乙 要删/)
  } finally {
    box.cleanup()
  }
})

test('历史是只追加的：两次操作留下两条，不覆盖', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'user', dir, line: '- [user] 一 — user.md' })
    writeMemory({ type: 'user', dir, line: '- [user] 二 — user.md', supersedes: '一 —' })
    writeMemory({ type: 'user', dir, line: '- [user] 三 — user.md', supersedes: '二 —' })

    const history = readJsonl(join(dir, '.history.jsonl')).filter((entry) => entry.op === 'supersede')
    assert.equal(history.length, 2)
    assert.match(history[0].line, /一 —/)
    assert.match(history[1].line, /二 —/)
  } finally {
    box.cleanup()
  }
})

test('历史文件是 0600', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'user', dir, line: '- [user] 权限 — user.md' })
    writeMemory({ type: 'user', dir, line: '- [user] 权限2 — user.md', supersedes: '权限 —' })
    assert.equal(statSync(join(dir, '.history.jsonl')).mode & 0o777, 0o600)
  } finally {
    box.cleanup()
  }
})

test('只有写入时，日志里只有 insert（没有取代/删除事件）', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'user', dir, line: '- [user] 只写 — user.md' })
    const events = readJsonl(join(dir, '.history.jsonl'))
    assert.deepEqual(
      events.map((entry) => entry.op),
      ['insert'],
    )
  } finally {
    box.cleanup()
  }
})

// ── 相似度 ──────────────────────────────────────────────────────────────────

test('similarity：同一句为 1，完全无关接近 0，过短返回 0', () => {
  assert.equal(similarity('同一条记忆', '同一条记忆'), 1)
  assert.equal(similarity('普通一条记忆', '完全无关的另一件事'), 0)
  assert.equal(similarity('', '任意'), 0)
  assert.equal(similarity('单', '单'), 0, '单字没有二元组')
  assert.ok(similarity('E01 已跑完', 'E01 已跑完了') > 0.8)
})

test('summaryOf 剥掉前缀与文件后缀', () => {
  assert.equal(summaryOf('- [feedback] 改稿要附说明 — feedback.md'), '改稿要附说明')
  assert.equal(summaryOf('- [project] 带 (exp:2026-12-01) — project.md (exp:2026-12-01)'), '带 (exp:2026-12-01)')
})

test('近似重复（≥0.9）被拒绝，错误里给出候选与 supersedes 提示', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md' })
    assert.throws(
      () =>
        writeMemory({
          type: 'project',
          dir,
          line: '- [project] E01 全链路已跑完，下一步 S3 场景卡。 — project.md',
        }),
      (error) =>
        /高度相似的记忆/.test(error.message) &&
        /supersedes/.test(error.message) &&
        /S3 场景卡/.test(error.message),
    )
  } finally {
    box.cleanup()
  }
})

test('相似度落在 0.8–0.9 之间时放行但带警告', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const base = 'E01 全链路已跑完，下一步 S3 场景卡'
    writeMemory({ type: 'project', dir, line: `- [project] ${base} — project.md` })

    // 在同一个基句上做受控改写，找到一个落在警告区间的候选
    const candidates = [
      `${base}，准备开工`,
      `${base}，先做场景卡`,
      `${base}，按计划推进`,
      `${base}，随后进入 SCRIPT`,
      `${base}，细节待定`,
    ]
    const picked = candidates
      .map((text) => ({ text, score: similarity(base, text) }))
      .find((item) => item.score >= SIMILARITY.warn && item.score < SIMILARITY.reject)
    assert.ok(picked !== undefined, '没有候选落在 0.8–0.9 区间，说明阈值或候选需要重新校准')

    const result = writeMemory({ type: 'project', dir, line: `- [project] ${picked.text} — project.md` })
    assert.equal(result.duplicate, false)
    assert.ok(typeof result.warning === 'string' && result.warning.length > 0, '应带警告')
    assert.match(readFileSync(result.path, 'utf8'), new RegExp(picked.text.slice(0, 6)))
  } finally {
    box.cleanup()
  }
})

test('用 supersedes 时绕过相似度闸（这是修正路径）', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md' })
    const result = writeMemory({
      type: 'project',
      dir,
      line: '- [project] E01 全链路已跑完，下一步 S3 场景卡。 — project.md',
      supersedes: '下一步 S3 场景卡',
    })
    assert.equal(result.duplicate, false)
    assert.equal(result.superseded, '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md')
  } finally {
    box.cleanup()
  }
})

test('完全重复仍然走幂等分支，不会被相似度闸拦住', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const line = '- [user] 结论先行 — user.md'
    const first = writeMemory({ type: 'user', dir, line })
    const second = writeMemory({ type: 'user', dir, line })
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
  } finally {
    box.cleanup()
  }
})

test('工具调用遇到近似重复时，错误信息足以让模型自行修正', async () => {
  const box = sandbox()
  try {
    const captured = { cwd: box.cwd, tools: [] }
    apply({
      systemPrompt: { context: (entry) => (captured.context = entry) },
      workingDirectory: { get: () => captured.cwd },
      tools: { register: (definition) => captured.tools.push(definition) },
      on() {},
    })
    const write = captured.tools.find((tool) => tool.name === 'memory_write')
    const exec = { agent: { session: { id: 's' }, options: { model: 'm' } } }

    await write.execute({ type: 'user', summary: 'E01 全链路已跑完，下一步 S3 场景卡', scope: 'global' }, exec)
    await assert.rejects(
      () => write.execute({ type: 'user', summary: 'E01 全链路已跑完，下一步 S3 场景卡。', scope: 'global' }, exec),
      (error) => /supersedes/.test(error.message),
    )
  } finally {
    box.cleanup()
  }
})

// ── 审计发现的两个数据安全问题（回归） ──────────────────────────────────────

test('主题文件超出读取上限时拒绝追加，绝不覆盖历史', async () => {
  const { appendTopic } = await import('./index.mjs')
  const box = sandbox()
  try {
    const dir = join(box.cwd, 'store')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'user.md')
    writeFileSync(file, 'x'.repeat(600 * 1024), 'utf8')

    assert.throws(() => appendTopic(dir, 'user', '新细节'), /不可读|拒绝追加/)
    // 原文件必须原样还在
    assert.equal(readFileSync(file, 'utf8').length, 600 * 1024)
  } finally {
    box.cleanup()
  }
})

test('通配 match 被拒绝，不会一次清空索引', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'user', dir, line: '- [user] 甲 — user.md' })
    writeMemory({ type: 'user', dir, line: '- [user] 乙 — user.md' })
    writeMemory({ type: 'project', dir, line: '- [project] 丙 — project.md' })

    assert.throws(() => forgetMemory(dir, '-'), /匹配到 3 条/)
    assert.throws(() => forgetMemory(dir, 'user.md'), /匹配到 2 条/)
    assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /甲/)
  } finally {
    box.cleanup()
  }
})
