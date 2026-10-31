import {writeFixtureMemory} from './fixture-host.mjs'
import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from './fixture-host.mjs'
/**
 * 记忆系统 × 宿主对话压缩（compaction）的兼容性测试。
 * 跑法：node --test ~/.dsh/plugins/memory/test-compaction-compat.mjs
 *
 * 背景：DSH 自带对话压缩（dsh-compaction-basic + /compact + 工具输出修剪），
 * 会在 token 压力上升时把较早历史换成摘要。记忆系统必须和它互不干扰。
 *
 * 四个接触面，每个都有断言：
 *   1. provider 每步从当前库重建；本文件不模拟真实宿主历史或压缩算法
 *   2. 注入体积与会话长度无关，只有硬上限（压缩救不了它，只能自己封顶）
 *   3. 工具输出必须低于宿主的修剪阈值（8192 字符），否则会在中间被截断、JSON 变形
 *   4. 压缩后模型可能忘记自己写过——重复写入必须仍被闸门拦住
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  
  indexLine,
  lookupLinks,
  pruneStore,
  searchStore,
  statusOf,
  storeDirFor,
  writeMemory,
} from './index.mjs'
import { entryId } from './security.mjs'

/** 宿主 tool-result-pruner 的默认阈值，见 dsh-base/cordis.patch.yml。 */
const HOST_TOOL_RESULT_LIMIT = 8192

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-compaction-')))
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

const exec = { agent: { session: { id: 'compat' }, options: { model: 'test' } } }

function seed(dir, count, prefix = '条目') {
  mkdirSync(dir, { recursive: true })
  const lines = ['# 索引', '', '## project', '']
  for (let i = 0; i < count; i += 1) lines.push(`- [project] ${prefix}${i} — project.md`)
  writeFileSync(join(dir, 'MEMORY.md'), `${lines.join('\n')}\n`, 'utf8')
}

// ── 1. 注入不依赖会话历史 ──────────────────────────────────────────────────

test('注入与会话 id 无关：换一个 session 也得到完全相同的文本', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    seed(dir, 20)
    const mounted = mount(box.cwd)

    const a = mounted.context.text({ agent: { session: { id: 'before-compaction' } } })
    const b = mounted.context.text({ agent: { session: { id: 'after-compaction' } } })
    assert.equal(a, b, '注入不能引用会话状态')
  } finally {
    box.cleanup()
  }
})

test('连续渲染 10 次结果完全一致（每步重新解析，不累积）', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    seed(dir, 30)
    const mounted = mount(box.cwd)
    const first = mounted.context.text({ agent: { session: {} } })
    for (let i = 0; i < 10; i += 1) {
      assert.equal(mounted.context.text({ agent: { session: {} } }), first)
    }
  } finally {
    box.cleanup()
  }
})

test('注入里不含任何对话内容（只来自库文件）', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    seed(dir, 5, '唯一标记')
    const mounted = mount(box.cwd)
    const text = mounted.context.text({ agent: { session: { id: 'x' } } })
    assert.match(text, /唯一标记0/)
    // 注入是纯数据块：没有会话角色前缀，也不回显对话
    assert.match(text, /^<memory-store>/)
    assert.doesNotMatch(text, /\n(user|assistant):/i)
  } finally {
    box.cleanup()
  }
})

// ── 2. 注入体积可控（压缩救不了它，只能封顶）────────────────────────────────

test('注入体积与会话长度无关，只随库增长并封顶在 25 KB 附近', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    seed(dir, 60)
    const mounted = mount(box.cwd)
    const small = Buffer.byteLength(mounted.context.text({ agent: { session: {} } }), 'utf8')

    seed(dir, 1000)
    const large = Buffer.byteLength(mounted.context.text({ agent: { session: {} } }), 'utf8')

    assert.ok(large > small, '库变大时注入应变大')
    assert.ok(large < 25 * 1024 + 2048, `超上限：${large} 字节`)
  } finally {
    box.cleanup()
  }
})

test('注入块声明自己不受对话压缩影响', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    seed(dir, 3)
    const mounted = mount(box.cwd)
    const text = mounted.context.text({ agent: { session: {} } })
    assert.match(text, /运行时快照会写入会话历史/)
    assert.match(text, /压缩后从当前库重建/)
  } finally {
    box.cleanup()
  }
})

// ── 3. 工具输出低于宿主的修剪阈值 ──────────────────────────────────────────

test('memory_search 的渲染结果低于宿主修剪阈值', async () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 40; i += 1) lines.push(`- [project] 关键词${'z'.repeat(150)}${i} — project.md`)
    writeFileSync(join(dir, 'MEMORY.md'), `${lines.join('\n')}\n`, 'utf8')

    const mounted = mount(box.cwd)
    const tool = mounted.tools.find((item) => item.name === 'memory_search')
    const value = await tool.execute({ query: '关键词', scope: 'global', limit: 20 }, exec)
    const rendered = tool.output.render({}, value).map((part) => part.text).join('\n')
    assert.ok(Buffer.byteLength(rendered, 'utf8') < HOST_TOOL_RESULT_LIMIT, `渲染 ${Buffer.byteLength(rendered, 'utf8')} 字节`)
  } finally {
    box.cleanup()
  }
})

test('memory_links 把入边截到 10 条，渲染结果仍低于阈值', async () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const target = indexLine('project', '被很多条目引用的中心条目')
    seed(dir, 1)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), `# 索引\n\n## project\n\n${target}\n`, 'utf8')
    const targetId = entryId(target)

    // 直接写 30 条入边事件（正常写入要靠相似度才会建边，这里构造极端情况）
    const events = Array.from({ length: 30 }, (_, i) =>
      JSON.stringify({
        at: new Date().toISOString(),
        op: 'insert',
        id: `fake${i}`,
        line: `- [project] 引用者${i} — project.md`,
        related: [{ id: targetId, score: 0.5 }],
      }),
    )
    writeFileSync(join(dir, '.history.jsonl'), `${events.join('\n')}\n`, 'utf8')

    const value = lookupLinks(dir, { id: targetId })
    assert.equal(value.backlinks.length, 10, '只列前 10')
    assert.equal(value.backlinksTotal, 30, '但总数要给出来')

    const mounted = mount(box.cwd)
    const tool = mounted.tools.find((item) => item.name === 'memory_links')
    const rendered = tool.output.render({}, value).map((part) => part.text).join('\n')
    assert.match(rendered, /共 30 条，只列前 10/)
    assert.ok(Buffer.byteLength(rendered, 'utf8') < HOST_TOOL_RESULT_LIMIT)
  } finally {
    box.cleanup()
  }
})

test('memory_status 的渲染结果远低于阈值', async () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    seed(dir, 50)
    const mounted = mount(box.cwd)
    const tool = mounted.tools.find((item) => item.name === 'memory_status')
    const value = await tool.execute({ scope: 'global' }, exec)
    const rendered = tool.output.render({}, value).map((part) => part.text).join('\n')
    assert.ok(Buffer.byteLength(rendered, 'utf8') < 2048)
  } finally {
    box.cleanup()
  }
})

// ── 4. 压缩后的行为 ────────────────────────────────────────────────────────

test('压缩后模型重述同一事实：逐字重复仍被幂等拦住', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const line = indexLine('project', 'S3 场景卡待写')
    const first = writeMemory({ type: 'project', dir, line })
    // 模拟：对话被压缩，模型不记得写过，再写一次
    const second = writeMemory({ type: 'project', dir, line })
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
  } finally {
    box.cleanup()
  }
})

test('压缩后模型换一种说法重述：相似度闸或冲突提示会响', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: indexLine('project', '剧本定为 26 集') })
    const result = writeMemory({ type: 'project', dir, line: indexLine('project', '剧本定为 24 集') })
    assert.match(result.warning ?? '', /冲突/, '同一事实不同取值必须提示')
  } finally {
    box.cleanup()
  }
})

test('压缩之后，取代与过期效果不变', () => {
  const box = sandbox()
  try {
    const mounted = mount(box.cwd)
    const dir = storeDirFor('project', box.cwd)
    writeFixtureMemory({ type: 'project', dir, line: indexLine('project', '剧本定为 26 集') })
    writeFixtureMemory({ type: 'project', dir, line: indexLine('project', '剧本定为 24 集'), supersedes: '26 集' })
    writeFixtureMemory({ type: 'project', dir, line: indexLine('project', '过期条目', '2020-01-01') })

    const text = mounted.context.text({ agent: { session: { id: 'after-compaction' } } })
    assert.doesNotMatch(text, /26 集/, '旧值不应复活')
    assert.match(text, /24 集/)
    assert.doesNotMatch(text, /过期条目/)
  } finally {
    box.cleanup()
  }
})

// ── 5. 命名与幂等 ──────────────────────────────────────────────────────────

test('工具名是 memory_prune，不再有 memory_compact', () => {
  const box = sandbox()
  try {
    const mounted = mount(box.cwd)
    const names = mounted.tools.map((item) => item.name)
    assert.ok(names.includes('memory_prune'))
    assert.ok(!names.includes('memory_compact'), '避免与宿主 /compact 混淆')
  } finally {
    box.cleanup()
  }
})

test('prune 幂等，且不产生任何会话相关内容', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    seed(dir, 5)
    writeFileSync(join(dir, 'MEMORY.md'), `${readFileSync(join(dir, 'MEMORY.md'), 'utf8')}- [project] 过期 — project.md (exp:2020-01-01)\n`, 'utf8')
    const first = pruneStore(dir, { apply: true })
    const second = pruneStore(dir, { apply: true })
    assert.equal(first.removed.expired, 1)
    assert.deepEqual(second.removed, { expired: 0, duplicate: 0, overCap: 0 })
    const audit = readFileSync(join(dir, '.audit.jsonl'), 'utf8')
    assert.doesNotMatch(audit, /conversation|message|turn/, '审计里不应出现会话内容')
  } finally {
    box.cleanup()
  }
})
