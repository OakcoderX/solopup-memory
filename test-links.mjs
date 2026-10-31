import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from './fixture-host.mjs'
/**
 * 条目 id、关系边与多跳查询。跑法：node --test ~/.dsh/plugins/memory/test-links.mjs
 *
 * 对应两项差距：MemOS 的「版本可查询」与 A-MEM 的「插入时建链」。
 * id 用内容寻址（sha1 前 8 位），不新增字段、不改索引格式：一行内容的 id 就是它自己。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { entryId } from './security.mjs'
import { LINK_LIMIT, LINK_THRESHOLD,  lookupLinks, relatedEntries, storeDirFor, writeMemory } from './index.mjs'

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-links-')))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    cwd,
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function mount(cwd) {
  const captured = { cwd, tools: [] }
  apply({
    systemPrompt: { context: (entry) => (captured.context = entry) },
    workingDirectory: { get: () => captured.cwd },
    tools: { register: (definition) => captured.tools.push(definition) },
    on() {},
  })
  return captured
}

// ── id ──────────────────────────────────────────────────────────────────────

test('内容寻址：同一行恒定、不同行不同、长度 8', () => {
  const line = '- [user] 甲 — user.md'
  assert.equal(entryId(line), entryId(line))
  assert.equal(entryId(line).length, 8)
  assert.notEqual(entryId(line), entryId('- [user] 乙 — user.md'))
  assert.match(entryId(line), /^[0-9a-f]{8}$/)
})

// ── 建边 ────────────────────────────────────────────────────────────────────

test('插入时按相似度建边，达到阈值才连', () => {
  const a = '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md'
  const b = '- [project] E01 全链路已跑完，下一步 S4 场景卡 — project.md'
  const c = '- [user] 回答要结论先行 — user.md'
  const related = relatedEntries(`${a}\n${c}`, b)
  assert.equal(related.length, 1)
  assert.equal(related[0].id, entryId(a))
  assert.ok(related[0].score >= LINK_THRESHOLD)
})

test('建边有上限，且按分数降序', () => {
  const lines = Array.from({ length: 6 }, (_, i) => `- [project] E01 全链路已跑完第 ${i} 场 — project.md`)
  const related = relatedEntries(lines.join('\n'), '- [project] E01 全链路已跑完第九场 — project.md')
  assert.ok(related.length <= LINK_LIMIT)
  for (let i = 1; i < related.length; i += 1) assert.ok(related[i - 1].score >= related[i].score)
})

test('写入返回 id 与相关条目', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md' })
    const second = writeMemory({
      type: 'project',
      dir,
      line: '- [project] E01 全链路已跑完，下一步 S4 场景卡 — project.md',
    })
    assert.match(second.id, /^[0-9a-f]{8}$/)
    assert.equal(second.related.length, 1)
    assert.equal(second.related[0].line, '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md')
  } finally {
    box.cleanup()
  }
})

// ── 查询 ────────────────────────────────────────────────────────────────────

test('lookupLinks 能给出出边与入边（多跳的一步）', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const a = '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md'
    const b = '- [project] E01 全链路已跑完，下一步 S4 场景卡 — project.md'
    writeMemory({ type: 'project', dir, line: a })
    writeMemory({ type: 'project', dir, line: b })

    const fromA = lookupLinks(dir, { id: entryId(a) })
    assert.equal(fromA.found, true)
    assert.equal(fromA.related.length, 0, 'A 先写，还没有出边')
    assert.equal(fromA.backlinks.length, 1, 'B 指向 A')
    assert.equal(fromA.backlinks[0].id, entryId(b))

    const fromB = lookupLinks(dir, { id: entryId(b) })
    assert.equal(fromB.related.length, 1)
    assert.equal(fromB.related[0].id, entryId(a))
  } finally {
    box.cleanup()
  }
})

test('lookupLinks 支持按子串定位，歧义时报错并列候选', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] E01 全链路已跑完 — project.md' })
    writeMemory({ type: 'project', dir, line: '- [project] E02 待开始 — project.md' })

    const ok = lookupLinks(dir, { match: 'E02' })
    assert.equal(ok.found, true)
    assert.match(ok.line, /E02/)

    assert.throws(() => lookupLinks(dir, { match: 'E0' }), /匹配到 2 条/)
  } finally {
    box.cleanup()
  }
})

test('取代之后，旧条目的 id 仍可查到取代链', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const oldLine = '- [project] 下一步 S3 — project.md'
    const newLine = '- [project] 下一步 S4 — project.md'
    writeMemory({ type: 'project', dir, line: oldLine })
    writeMemory({ type: 'project', dir, line: newLine, supersedes: '下一步 S3' })

    const old = lookupLinks(dir, { id: entryId(oldLine) })
    assert.equal(old.found, true, '被取代的条目仍可从历史里解析')
    assert.equal(old.supersededById, entryId(newLine))

    const fresh = lookupLinks(dir, { id: entryId(newLine) })
    assert.equal(fresh.supersedesLine, oldLine)
  } finally {
    box.cleanup()
  }
})

test('memory_links 工具注册且可调用', async () => {
  const box = sandbox()
  try {
    const captured = mount(box.cwd)
    const tool = captured.tools.find((item) => item.name === 'memory_links')
    assert.ok(tool, '注册了 memory_links')

    const write = captured.tools.find((item) => item.name === 'memory_write')
    const exec = { agent: { session: { id: 's' }, options: { model: 'm' } } }
    const written = await write.execute(
      { type: 'user', summary: 'E01 全链路已跑完，下一步 S3 场景卡', scope: 'global' },
      exec,
    )

    const result = await tool.execute({ id: written.id, scope: 'global' }, exec)
    assert.equal(result.found, true)
    assert.equal(result.line, written.indexLine)
  } finally {
    box.cleanup()
  }
})

test('没有历史文件时查询安全返回 found=false', () => {
  const box = sandbox()
  try {
    const dir = join(box.cwd, 'nope')
    mkdirSync(dir, { recursive: true })
    const result = lookupLinks(dir, { id: 'deadbeef' })
    assert.equal(result.found, false)
    assert.deepEqual(result.related, [])
    assert.deepEqual(result.backlinks, [])
    assert.equal(existsSync(join(dir, '.history.jsonl')), false)
  } finally {
    box.cleanup()
  }
})

// ── 取代时的边继承（R2b） ───────────────────────────────────────────────────

test('取代后新条目继承旧条目的出边，不会变成孤立节点', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const hub = '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md'
    // 与 hub 相似度 0.85，会建边
    const oldLine = '- [project] E01 全链路已跑完，下一步 S3 场景卡的清单 — project.md'
    // 与 hub 相似度很低，自动发现不会连上；只能靠继承
    const newLine = '- [project] 清单先从卡做起，再进稿子 — project.md'

    writeMemory({ type: 'project', dir, line: hub })
    const old = writeMemory({ type: 'project', dir, line: oldLine })
    assert.ok(old.related.some((edge) => edge.id === entryId(hub)), '旧条目本来连着 hub')

    const replaced = writeMemory({ type: 'project', dir, line: newLine, supersedes: '场景卡的清单' })
    assert.ok(
      replaced.related.some((edge) => edge.id === entryId(hub)),
      '继承来的边应包含 hub（新文本自己发现的边里没有它）',
    )
  } finally {
    box.cleanup()
  }
})

test('指向旧条目的入边，在取代后仍算在新条目头上', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const oldLine = '- [project] E01 全链路已跑完，下一步 S3 场景卡 — project.md'
    // 与 old 相似度 0.50，会指向 old
    const point = '- [project] E01 全链路已跑完了，S3 场景卡还没开始 — project.md'
    // 与 point / old 都低相似，避免自动发现造成伪证
    const newLine = '- [project] 后面按新计划推进 — project.md'

    writeMemory({ type: 'project', dir, line: oldLine })
    const pointer = writeMemory({ type: 'project', dir, line: point })
    assert.ok(pointer.related.some((edge) => edge.id === entryId(oldLine)), 'pointer 应指向 old')

    writeMemory({ type: 'project', dir, line: newLine, supersedes: '下一步 S3 场景卡' })

    const fresh = lookupLinks(dir, { id: entryId(newLine) })
    assert.equal(fresh.found, true)
    assert.ok(
      fresh.backlinks.some((edge) => edge.id === entryId(point)),
      '入边应顺着取代链继承过来',
    )
  } finally {
    box.cleanup()
  }
})
