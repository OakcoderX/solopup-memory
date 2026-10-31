import {writeFixtureMemory} from './fixture-host.mjs'
import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from './fixture-host.mjs'
/**
 * 可用性测试。跑法：node --test ~/.dsh/plugins/memory/test-usability.mjs
 *
 * 这份文件验收五条指标（对应计划里的 U1–U5）：
 *   U1 无死路：写入失败必须给出已存在的下一步；满索引一次 compact 恢复可写
 *   U2 可找回：被截断的条目、主题文件里的内容，一次检索就能拿到
 *   U3 不腐烂：连续写入后不超限、重复不累积、过期不残留
 *   U4 可诊断：一条 status 回答"多大、多满、多少过期、多少重复"
 *   U5 成本有界：检索输出 ≤4 KB，注入不因新功能变重
 *
 * 全部隔离 DSH_HOME，不碰真实记忆库。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { countFrameTokens } from './security.mjs'
import {
  
  pruneStore,
  forgetExpired,
  indexLine,
  searchStore,
  statusOf,
  storeDirFor,
  writeMemory,
} from './index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-usability-')))
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

const exec = { agent: { session: { id: 'usability' }, options: { model: 'test' } } }

function writeIndex(dir, body) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), body, 'utf8')
}

function indexEntries(dir) {
  const text = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  return text.split('\n').filter((line) => line.trim().startsWith('- ['))
}

function daysAgo(days) {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

test('默认检索同时找当前项目和全局偏好，不读其他项目；首次登记只创建控制元数据', async () => {
  const box = sandbox()
  try {
    const global = storeDirFor('global', box.cwd), project = storeDirFor('project', box.cwd)
    const other = storeDirFor('project', join(box.root, 'other-project'))
    writeIndex(global, '- [user] 我的 palette-code 是 silver-development\n')
    writeIndex(other, '- [project] 隔壁项目 palette-code 是 hidden-other\n')
    const tool = mount(box.cwd).tools.find(tool => tool.name === 'memory_search')
    const value = await tool.execute({ query: 'palette-code' }, exec)
    assert.equal(value.hits.length, 1)
    assert.equal(value.hits[0].scope, 'global')
    assert.match(value.hits[0].text, /silver-development/)
    assert.equal(existsSync(project), true);assert.equal(existsSync(join(project,'MEMORY.md')),false);assert.equal(existsSync(join(project,'.candidates.json')),false)
    assert.doesNotMatch(JSON.stringify(value), /hidden-other/)
    assert.deepEqual(value, JSON.parse(JSON.stringify(value)))
    assert.match(tool.output.render({}, value)[0].text, /\[global\] MEMORY.md:/)
  } finally { box.cleanup() }
})

test('显式单库检索保留原返回约定，两库同名同号条目不混淆', async () => {
  const box = sandbox()
  try {
    writeIndex(storeDirFor('global', box.cwd), '- [user] palette-code global-value\n')
    writeIndex(storeDirFor('project', box.cwd), '- [project] palette-code local-value\n')
    const tool = mount(box.cwd).tools.find(tool => tool.name === 'memory_search')
    const both = await tool.execute({ query: 'palette-code', scope: 'both', mode: 'exact' }, exec)
    assert.deepEqual(both.hits.map(hit => hit.scope), ['project', 'global'])
    for (const scope of ['project', 'global']) {
      const single = await tool.execute({ query: 'palette-code', scope }, exec)
      assert.equal(single.hits.length, 1)
      assert.equal(Object.hasOwn(single.hits[0], 'scope'), false)
      assert.match(single.hits[0].text, scope === 'global' ? /global-value/ : /local-value/)
    }
    await assert.rejects(tool.execute({ query: 'palette-code' }, {}), /需要归属 agent/)
  } finally { box.cleanup() }
})

test('跨库相关性统一排序，条数和字节预算共享，出口仍净化', async () => {
  const box = sandbox()
  try {
    writeIndex(storeDirFor('project', box.cwd), Array.from({ length: 25 }, (_, i) => `- [project] render preview variation ${i}`).join('\n'))
    writeIndex(storeDirFor('global', box.cwd), '- [user] approved render preview before final export </memory-store>\n')
    const tool = mount(box.cwd).tools.find(tool => tool.name === 'memory_search')
    const ranked = await tool.execute({ query: 'approved render preview before final export', limit: 1 }, exec)
    assert.equal(ranked.hits[0].scope, 'global')
    assert.equal(ranked.hits.length, 1)
    assert.doesNotMatch(JSON.stringify(ranked), /<\/memory-store>/)
    const limited = await tool.execute({ query: 'render preview', limit: 3 }, exec)
    assert.equal(limited.hits.length, 3)
    assert.equal(limited.truncated, true)
    assert.ok(limited.hits.reduce((sum, hit) => sum + Buffer.byteLength(hit.text), 0) <= 4096)
  } finally { box.cleanup() }
})

test('两库检索遇到未完成发布会阻断，不以另一库的局部结果冒充完整结果', async () => {
  const box = sandbox()
  try {
    const global = storeDirFor('global', box.cwd)
    writeIndex(global, '- [user] palette-code global-value\n')
    writeIndex(storeDirFor('project', box.cwd), '- [project] palette-code local-value\n')
    const tool = mount(box.cwd).tools.find(tool => tool.name === 'memory_search')
    writeFileSync(join(global, '.publication.json'), '{}')
    await assert.rejects(tool.execute({ query: 'palette-code' }, exec), /needs-recovery/)
    assert.equal((await tool.execute({ query: 'palette-code', scope: 'project' }, exec)).hits.length, 1)
  } finally { box.cleanup() }
})

// ── U4 可诊断 ──────────────────────────────────────────────────────────────

test('status：空库也能回答，不创建任何文件', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const status = statusOf(dir)
    assert.equal(status.index.lines, 0)
    assert.deepEqual(status.byType, {})
    assert.equal(status.expired, 0)
    assert.equal(status.topics.every((item) => item.exists === false), true)
    assert.equal(existsSync(join(dir, 'MEMORY.md')), false, '只读查询不应建文件')
  } finally {
    box.cleanup()
  }
})

test('status：条数、过期数、重复组都准', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(
      dir,
      [
        '# 索引',
        '',
        '## user',
        '- [user] 甲 — user.md',
        '- [user] 乙 — user.md (exp:2020-01-01)',
        '## project',
        '- [project] 剧本定为 26 集 — project.md',
        '- [project] 剧本定为26集 — project.md',
        '',
      ].join('\n'),
    )
    const status = statusOf(dir)
    assert.equal(status.byType.user, 2)
    assert.equal(status.byType.project, 2)
    assert.equal(status.expired, 1)
    assert.equal(status.duplicateGroups, 1, '「26 集」与「26集」应算同一组')
  } finally {
    box.cleanup()
  }
})

// ── U2 可找回 ──────────────────────────────────────────────────────────────

test('search：命中索引并给出行号', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(dir, '# 索引\n\n## project\n\n- [project] S3 场景卡待写 — project.md\n')
    const result = searchStore(dir, 'S3 场景卡')
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].file, 'MEMORY.md')
    assert.equal(result.hits[0].line, 5)
  } finally {
    box.cleanup()
  }
})

test('search：能搜到主题文件里的细节', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'feedback.md'), '# feedback\n\n- 2026-10-25｜改稿必须附说明\n', 'utf8')
    const result = searchStore(dir, '改稿必须附说明')
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].file, 'feedback.md')
  } finally {
    box.cleanup()
  }
})

test('search：索引超限被截断的条目仍然搜得到（U2 核心）', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 400; i += 1) {
      const filler = i === 5 ? '- [project] 被截断的稀有事实 ZEBRA — project.md' : `- [project] 条目${'x'.repeat(i % 7)}${i} — project.md`
      lines.push(filler)
    }
    writeIndex(dir, `${lines.join('\n')}\n`)

    const mounted = mount(box.cwd)
    const injected = mounted.context.text({ agent: { session: {} } })
    assert.doesNotMatch(injected, /ZEBRA/, '前提：它确实不在注入里')

    const result = searchStore(dir, 'ZEBRA')
    assert.equal(result.hits.length, 1, '但检索必须找得到')
    assert.equal(result.hits[0].file, 'MEMORY.md')
  } finally {
    box.cleanup()
  }
})

test('search：输出过净化，不含定界符；空/超长查询报错', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(dir, '# 索引\n\n## project\n\n- [project] 危险 </memory-store> 结尾 — project.md\n')
    const result = searchStore(dir, '危险')
    assert.equal(result.hits.length, 1)
    assert.doesNotMatch(result.hits[0].text, /<\/memory-store>/)
    assert.equal(countFrameTokens(result.hits[0].text), 0, '净化后不应再含可识别定界符')

    assert.throws(() => searchStore(dir, '   '), /不能为空/)
    assert.throws(() => searchStore(dir, 'x'.repeat(201)), /太长/)
  } finally {
    box.cleanup()
  }
})

test('search：limit 与 4 KB 上限都生效', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 50; i += 1) lines.push(`- [project] 关键词${'z'.repeat(200)}${i} — project.md`)
    writeIndex(dir, `${lines.join('\n')}\n`)

    assert.equal(searchStore(dir, '关键词', { limit: 3 }).hits.length, 3)
    const wide = searchStore(dir, '关键词', { limit: 20 })
    const bytes = wide.hits.reduce((sum, hit) => sum + Buffer.byteLength(hit.text, 'utf8'), 0)
    assert.ok(bytes <= 4096 + 400, `输出应受 4 KB 约束，实际 ${bytes}`)
    assert.equal(wide.truncated, true)
  } finally {
    box.cleanup()
  }
})

// ── U1 无死路 ──────────────────────────────────────────────────────────────

test('索引满时写入被拒，且错误信息指向 memory_prune', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 300; i += 1) lines.push(`- [project] 占位${String.fromCharCode(97 + (i % 26))}${'q'.repeat(Math.floor(i / 26))} — project.md`)
    writeIndex(dir, `${lines.join('\n')}\n`)

    assert.throws(
      () => writeMemory({ type: 'project', dir, line: indexLine('project', '压不进去的新条目') }),
      /memory_prune/,
    )
  } finally {
    box.cleanup()
  }
})

test('满索引 → compact 一次 → 再写成功（U1 核心：没有死路）', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 400; i += 1) {
      // 前 60 条已过期，压缩时会被优先清掉；剩下 340 条仍超 300 行上限
      const suffix = i < 60 ? ` (exp:${daysAgo(3)})` : ''
      lines.push(`- [project] 占位${String.fromCharCode(97 + (i % 26))}${i} — project.md${suffix}`)
    }
    writeIndex(dir, `${lines.join('\n')}\n`)

    assert.throws(() => writeMemory({ type: 'project', dir, line: indexLine('project', '新条目') }))
    const report = pruneStore(dir, { apply: true })
    assert.ok(report.removed.overCap > 0, '应压掉超限的旧条目')
    const written = writeMemory({ type: 'project', dir, line: indexLine('project', '新条目') })
    assert.equal(written.duplicate, false)
    assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /新条目/)
  } finally {
    box.cleanup()
  }
})

// ── U3 不腐烂 ──────────────────────────────────────────────────────────────

test('compact：默认 dry-run，不落盘', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(dir, '# 索引\n\n## project\n\n- [project] 过期 — project.md (exp:2020-01-01)\n')
    const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    const report = pruneStore(dir, {})
    assert.equal(report.applied, false)
    assert.equal(report.removed.expired, 1)
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), before)
  } finally {
    box.cleanup()
  }
})

test('compact：删过期并写历史', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(dir, '# 索引\n\n## project\n\n- [project] 甲 — project.md\n- [project] 过期乙 — project.md (exp:2020-01-01)\n')
    const report = pruneStore(dir, { apply: true })
    assert.equal(report.removed.expired, 1)
    assert.equal(indexEntries(dir).length, 1)
    const history = readFileSync(join(dir, '.history.jsonl'), 'utf8')
    assert.match(history, /"reason":"expired"/)
  } finally {
    box.cleanup()
  }
})

test('compact：合并仅差空格的重复，保留最新写法', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(dir, '# 索引\n\n## project\n\n- [project] 剧本定为 26 集 — project.md\n- [project] 剧本定为26集 — project.md\n')
    const report = pruneStore(dir, { apply: true })
    assert.equal(report.removed.duplicate, 1)
    const entries = indexEntries(dir)
    assert.equal(entries.length, 1)
    assert.equal(entries[0], '- [project] 剧本定为26集 — project.md', '保留后写入的那条写法')
  } finally {
    box.cleanup()
  }
})

test('compact：指数压到 300 行以内，且保留最新', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 400; i += 1) lines.push(`- [project] 第${i}${'w'.repeat(i % 3)}条 — project.md`)
    writeIndex(dir, `${lines.join('\n')}\n`)

    const report = pruneStore(dir, { apply: true })
    assert.ok(report.removed.overCap > 0)
    const entries = indexEntries(dir)
    assert.ok(entries.length <= 300, `压后 ${entries.length} 行`)
    assert.ok(entries.some((line) => /第399/.test(line)), '最新一条必须保留')
  } finally {
    box.cleanup()
  }
})

test('compact：超大主题文件轮转，内容不丢，之后能继续追加', async () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    const big = `# user\n\n- 2026-01-01｜${'大'.repeat(600 * 1024)}\n`
    writeFileSync(join(dir, 'user.md'), big, 'utf8')

    const report = pruneStore(dir, { apply: true })
    assert.equal(report.archived.length, 1)
    assert.match(report.archived[0].to, /^user\.archive-\d{8}\.md$/)
    assert.equal(existsSync(join(dir, 'user.md')), false)
    assert.equal(statSync(join(dir, report.archived[0].to)).size, Buffer.byteLength(big), '内容必须逐字保留')

    const { appendTopic } = await import('./index.mjs')
    appendTopic(dir, 'user', '轮转后仍可追加')
    assert.match(readFileSync(join(dir, 'user.md'), 'utf8'), /轮转后仍可追加/)
  } finally {
    box.cleanup()
  }
})

test('compact：幂等，第二次没有可做的', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(dir, '# 索引\n\n## project\n\n- [project] 甲 — project.md\n- [project] 过期 — project.md (exp:2020-01-01)\n')
    pruneStore(dir, { apply: true })
    const second = pruneStore(dir, { apply: true })
    assert.deepEqual(second.removed, { expired: 0, duplicate: 0, overCap: 0 })
    assert.equal(second.archived.length, 0)
  } finally {
    box.cleanup()
  }
})

test('compact：审计留下一条 compact 记录', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(dir, '# 索引\n\n## project\n\n- [project] 过期 — project.md (exp:2020-01-01)\n')
    pruneStore(dir, { apply: true })
    const events = readFileSync(join(dir, '.audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(events.at(-1).op, 'compact')
    assert.equal(events.at(-1).expired, 1)
  } finally {
    box.cleanup()
  }
})

// ── 批量删过期 ─────────────────────────────────────────────────────────────

test('forgetExpired：一次删掉全部过期条目，结果逐条返回', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    writeIndex(
      dir,
      '# 索引\n\n## project\n\n- [project] 甲 — project.md\n- [project] 乙 — project.md (exp:2020-01-01)\n- [project] 丙 — project.md (exp:2020-01-02)\n',
    )
    const result = forgetExpired(dir)
    assert.equal(result.removed, 2)
    assert.equal(result.lines.length, 2)
    assert.equal(indexEntries(dir).length, 1)
  } finally {
    box.cleanup()
  }
})

test('memory_forget 工具：match 与 expired 互斥', async () => {
  const box = sandbox()
  try {
    const mounted = mount(box.cwd)
    const tool = mounted.tools.find((item) => item.name === 'memory_forget')
    await assert.rejects(() => tool.execute({ match: '甲', expired: true }, exec), /只能给一个/)
  } finally {
    box.cleanup()
  }
})

// ── 工具面 ─────────────────────────────────────────────────────────────────

test('注册了 6 个工具，新工具都能通过 execute 调用', async () => {
  const box = sandbox()
  try {
    const mounted = mount(box.cwd)
    assert.deepEqual(
      mounted.tools.map((item) => item.name).sort(),
      ['memory_forget', 'memory_links', 'memory_prune', 'memory_search', 'memory_status', 'memory_write'],
    )

    const write = mounted.tools.find((item) => item.name === 'memory_write')
    await write.execute({ type: 'user', summary: '可用性测试条目', scope: 'global' }, exec)

    const search = mounted.tools.find((item) => item.name === 'memory_search')
    const found = await search.execute({ query: '可用性测试', scope: 'global' }, exec)
    assert.equal(found.hits.length, 1)

    const status = mounted.tools.find((item) => item.name === 'memory_status')
    const snapshot = await status.execute({ scope: 'global' }, exec)
    assert.equal(snapshot.byType.user, 1)

    const compact = mounted.tools.find((item) => item.name === 'memory_prune')
    const planned = await compact.execute({ scope: 'global' }, exec)
    assert.equal(planned.applied, false, '默认必须是 dry-run')
  } finally {
    box.cleanup()
  }
})

// ── U3 七天模拟 ────────────────────────────────────────────────────────────

test('七天模拟：210 次写入 + 取代 + 过期，不撞死路、最新可见、成本有界', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    let written = 0
    for (let day = 0; day < 7; day += 1) {
      for (let i = 0; i < 30; i += 1) {
        const summary = `第 ${day} 天第 ${i} 条记录 ${String.fromCharCode(97 + (i % 26))}${'k'.repeat(day)}`
        const type = day % 2 === 0 ? 'project' : 'reference'
        writeMemory({
          type,
          dir,
          line: indexLine(type, summary, i === 29 ? daysAgo(1) : undefined),
        })
        written += 1
      }
      // 每天一次取代：把当天的第一条换成新说法
      const first = `第 ${day} 天第 0 条记录 a${'k'.repeat(day)}`
      writeMemory({
        type: 'project',
        dir,
        line: indexLine('project', `${first}（已修订）`),
        supersedes: first,
      })
    }

    assert.equal(written, 210)
    const mounted = mount(box.cwd)
    const injected = mounted.context.text({ agent: { session: {} } })
    // 注意：i=29 的条目带 exp:昨天，注入时会按设计隐藏，所以断言 i=28
    assert.match(injected, /第 6 天第 28 条记录/, '最新未过期条目必须可见')
    assert.ok(Buffer.byteLength(injected, 'utf8') <= 25 * 1024 + 1024, '注入体积必须受 25 KB 约束')

    const status = statusOf(dir)
    assert.ok(status.index.lines <= 300, `索引 ${status.index.lines} 行应 ≤300`)

    // 必须还能继续写：不行就压缩一次再写
    try {
      writeFixtureMemory({ type: 'reference', dir, line: indexLine('reference', '第八天的新记录') })
    } catch {
      pruneStore(dir, { apply: true })
      writeFixtureMemory({ type: 'reference', dir, line: indexLine('reference', '第八天的新记录') })
    }
    assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /第八天的新记录/)
  } finally {
    box.cleanup()
  }
})

// ── 并发：压缩与写入不打架 ─────────────────────────────────────────────────

test('compact 与 4 个写入进程并发，最终条目一个不少', async () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '# 索引\n\n## user\n\n', 'utf8')

    const runWorker = (prefix) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(HERE, 'worker-write.mjs'), dir, prefix, '5'], { stdio: 'ignore' })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${prefix} exit ${code}`))))
      })

    const compactWhileWriting = (async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        pruneStore(dir, { apply: true })
      }
    })()

    await Promise.all([runWorker('w0'), runWorker('w1'), runWorker('w2'), runWorker('w3'), compactWhileWriting])

    const lines = indexEntries(dir)
    for (const prefix of ['w0', 'w1', 'w2', 'w3']) {
      const found = lines.filter((line) => line.includes(prefix))
      assert.equal(found.length, 5, `${prefix} 应保留 5 条，实际 ${found.length}`)
    }
  } finally {
    box.cleanup()
  }
})
