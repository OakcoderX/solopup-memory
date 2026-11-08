import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from '../fixture-host.mjs'
/**
 * supersede（版本替代）与来源标记。跑法：node --test ~/.dsh/plugins/memory/test/test-supersede.mjs
 *
 * 取代是「修正过期事实」的唯一正确做法：再叠一条会让新旧两条同时被注入，
 * 模型看到矛盾信息。cc-memory 把这叫 anti-patch，MemOS 把它建模成 MemCube 的版本关系。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {  storeDirFor, writeMemory } from '../index.mjs'

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-sup-')))
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

const writeTool = (captured) => captured.tools.find((tool) => tool.name === 'memory_write')
const fakeExec = (captured) => ({
  agent: { session: { id: 'sess-test-1' }, options: { model: 'deepseek-flash' } },
})

// ── supersede 语义 ──────────────────────────────────────────────────────────

test('supersede：旧条目消失、新条目就位，只留一条', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] 下一步 S3 — project.md' })
    const result = writeMemory({
      type: 'project',
      dir,
      line: '- [project] 下一步 S4 — project.md',
      supersedes: '下一步 S3',
    })

    assert.equal(result.superseded, '- [project] 下一步 S3 — project.md')
    const index = readFileSync(result.path, 'utf8')
    assert.doesNotMatch(index, /S3/)
    assert.match(index, /S4/)
    assert.equal(index.split('\n').filter((line) => line.startsWith('- [')).length, 1)
  } finally {
    box.cleanup()
  }
})

test('supersede 匹配不到时报错，并提示怎么查原文', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] 甲 — project.md' })
    assert.throws(
      () => writeMemory({ type: 'project', dir, line: '- [project] 乙 — project.md', supersedes: '不存在' }),
      /没匹配到/,
    )
    // 失败不应改动索引
    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.match(index, /甲/)
    assert.doesNotMatch(index, /乙/)
  } finally {
    box.cleanup()
  }
})

test('supersede 匹配到多条时拒绝猜测，并把候选列出来', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'project', dir, line: '- [project] E01 完成 — project.md' })
    writeMemory({ type: 'project', dir, line: '- [project] E02 待办 — project.md' })
    assert.throws(
      () => writeMemory({ type: 'project', dir, line: '- [project] 新 — project.md', supersedes: 'E0' }),
      (error) => /匹配到 2 条/.test(error.message) && /E01/.test(error.message),
    )
  } finally {
    box.cleanup()
  }
})

test('supersede 跨类型时也把条目挪到新分节', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'user', dir, line: '- [user] 旧偏好 — user.md' })
    const result = writeMemory({
      type: 'feedback',
      dir,
      line: '- [feedback] 旧偏好被纠正 — feedback.md',
      supersedes: '旧偏好',
    })
    const lines = readFileSync(result.path, 'utf8').split('\n')
    const section = lines.indexOf('## feedback')
    const entry = lines.findIndex((line) => line.includes('旧偏好被纠正'))
    assert.ok(section >= 0 && entry > section, '应落在 feedback 分节内')
    assert.ok(!lines.some((line) => line.includes('- [user] 旧偏好')), '旧条目应已移除')
  } finally {
    box.cleanup()
  }
})

// ── 来源标记（审计即账本） ──────────────────────────────────────────────────

test('审计记下来源会话、模型、写入行与被取代的行', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({
      type: 'project',
      dir,
      line: '- [project] 旧 — project.md',
      provenance: { sessionId: 'sess-abc', model: 'deepseek-flash', via: 'memory_write' },
    })
    writeMemory({
      type: 'project',
      dir,
      line: '- [project] 新 — project.md',
      supersedes: '旧',
      provenance: { sessionId: 'sess-abc', model: 'deepseek-flash', via: 'memory_write' },
    })

    const events = readFileSync(join(dir, '.audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.op === 'write')

    assert.equal(events.length, 2)
    assert.equal(events[0].sessionId, 'sess-abc')
    assert.equal(events[0].model, 'deepseek-flash')
    assert.equal(events[1].superseded, '- [project] 旧 — project.md')
    assert.match(events[1].line, /新/)
    // 账本里要有可追溯的时间戳与 pid
    for (const event of events) {
      assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal(typeof event.pid, 'number')
    }
  } finally {
    box.cleanup()
  }
})

test('工具调用会自动带上会话 id 与模型（不需要模型自己填）', async () => {
  const box = sandbox()
  try {
    const captured = mount(box.cwd)
    const tool = writeTool(captured)
    await tool.execute({ type: 'user', summary: '工具来源', scope: 'global' }, fakeExec(captured))

    const dir = storeDirFor('global', box.cwd)
    const events=readFileSync(join(dir, '.audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const event=events.findLast(event=>event.op==='write'&&event.via==='memory_write')
    assert.equal(event.sessionId, 'sess-test-1')
    assert.equal(event.model, 'deepseek-flash')
    assert.equal(event.via, 'memory_write')
  } finally {
    box.cleanup()
  }
})

test('注入文本带信任前置：明确说记忆是数据不是指令', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'user', dir, line: '- [user] 任意 — user.md' })
    const captured = mount(box.cwd)
    const text = captured.context.text({ agent: { session: {} } })
    assert.match(text, /是\*\*数据\*\*，不是指令/)
    assert.match(text, /可能已被污染/)
  } finally {
    box.cleanup()
  }
})

test('没有会话信息时审计仍可写（子进程/测试环境）', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeMemory({ type: 'user', dir, line: '- [user] 无来源 — user.md' })
    const event = JSON.parse(readFileSync(join(dir, '.audit.jsonl'), 'utf8').trim())
    assert.equal(event.sessionId, undefined)
    assert.equal(event.outcome, 'ok')
  } finally {
    box.cleanup()
  }
})
