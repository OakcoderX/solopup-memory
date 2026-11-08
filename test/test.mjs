import {prepareMountedFixture} from '../fixture-host.mjs'
import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from '../fixture-host.mjs'
/**
 * dsh-memory 的单元测试。跑法：node --test ~/.dsh/plugins/memory/test/test.mjs
 *
 * 不依赖 DSH 宿主：用假的 ctx 捕获注册结果，再直接调 provider 的 text() 和工具 execute。
 * 两条必须守住的约定：
 *   · 注入点是 provider 的 text()，不能是 system-prompt/assemble 钩子
 *     （宿主每一步 refreshContext() 会按 provider 重新解析，钩子里的改写被覆盖）
 *   · 每个用例都要隔离 DSH_HOME，否则 apply() 的加载痕迹会污染真实记忆库
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import {
  
  inject,
  name,
  addIndexLine,
  appendTopic,
  checkIndexBudget,
  forgetLines,
  forgetMemory,
  indexLine,
  storeDirFor,
  writeMemory,
} from '../index.mjs'

const CONTEXT_NAME = 'memory:index'

/** 建一个隔离的 DSH_HOME + 工作目录，返回清理函数。 */
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-test-')))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    root,
    home,
    cwd,
    store: join(home, 'memory'),
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 装配插件，返回捕获到的注册结果。 */
function mount() {
  const captured = { cwd: undefined, tools: [] }
  const ctx = {
    systemPrompt: {
      context(entry) {
        captured.context = entry
      },
    },
    workingDirectory: {
      get() {
        return captured.cwd
      },
    },
    tools: {
      register(definition) {
        captured.tools.push(definition)
      },
    },
    on(name) {
      if (name === 'system-prompt/assemble') throw new Error('插件不应注册 system-prompt/assemble 钩子')
    },
  }
  apply(ctx)
  return captured
}

/** 调 provider 的 text()，模拟宿主每一步的装配。 */
function render(captured, cwd) {
  captured.cwd = cwd
  return captured.context.text({ agent: { session: {} } })
}

function writeIndex(dir, body) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), body, 'utf8')
}

function projectKeyOf(dir) {
  return 'v2-' + createHash('sha256').update(dir).digest('hex')
}

/** 造一个 exec，供工具 execute 使用。 */
function fakeExec(captured, cwd) {
  captured.cwd = cwd
  return { agent: { session: {} } }
}

const tool = (captured, toolName) => captured.tools.find((item) => item.name === toolName)

// ── 注册形态 ────────────────────────────────────────────────────────────────

test('注册形态：名字、依赖、上下文条目、六个工具', () => {
  const box = sandbox()
  try {
    const captured = mount()
    assert.equal(name, 'memory')
    assert.deepEqual(inject, ['systemPrompt', 'workingDirectory', 'tools'])
    assert.equal(captured.context.name, CONTEXT_NAME)
    assert.equal(captured.context.order, 250)
    assert.equal(captured.context.required, true)
    assert.equal(captured.context.interpolate, false)
    assert.equal(typeof captured.context.text, 'function')
    // 关键回归：宿主的 refreshContext 是同步取值，不能给异步函数
    assert.equal(captured.context.text.constructor.name, 'Function')
    assert.deepEqual(captured.tools.map((item) => item.name).sort(), [
      'memory_forget',
      'memory_links',
      'memory_prune',
      'memory_search',
      'memory_status',
      'memory_write',
    ])
    for (const definition of captured.tools) {
      assert.equal(typeof definition.execute, 'function')
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(definition.parameters.type, 'object')
    }
    assert.ok(existsSync(join(box.store, '.loaded.json')), '加载痕迹应写进隔离目录')
  } finally {
    box.cleanup()
  }
})

// ── 注入 ────────────────────────────────────────────────────────────────────

test('两个库都空时不注入（零成本）', () => {
  const box = sandbox()
  try {
    assert.equal(render(mount(),box.cwd),'')
  } finally {
    box.cleanup()
  }
})

test('只有全局库时注入全局索引，并带上绝对路径', () => {
  const box = sandbox()
  try {
    writeIndex(box.store, '# 记忆索引\n\n- [user] 中文写作者 — user.md\n')
    const text = render(mount(), box.cwd)
    assert.match(text, /<memory-store>/)
    assert.match(text, /global（跨项目）/)
    assert.ok(text.includes(box.store), '应包含全局库绝对路径')
    assert.match(text, /\[user\] 中文写作者/)
  } finally {
    box.cleanup()
  }
})

test('项目根由 .git 标记发现，项目库与全局库同时注入', () => {
  const box = sandbox()
  try {
    const projectRoot = join(box.root, 'repo')
    const deep = join(projectRoot, 'sub', 'deeper')
    mkdirSync(deep, { recursive: true })
    mkdirSync(join(projectRoot, '.git'))
    writeIndex(box.store, '- [user] 全局条目 — user.md\n')
    writeIndex(join(box.store, 'projects', projectKeyOf(projectRoot)), '- [feedback] 项目条目 — feedback.md\n')

    const text = render(mount(), deep)
    assert.match(text, /global（跨项目）/)
    assert.match(text, /project（当前项目）/)
    assert.ok(text.indexOf('全局条目') < text.indexOf('项目条目'), '全局在前、项目在后')
  } finally {
    box.cleanup()
  }
})

test('.dsh-root 同样能当项目锚点', () => {
  const box = sandbox()
  try {
    const projectRoot = join(box.root, 'manual')
    const deep = join(projectRoot, 'a', 'b')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(projectRoot, '.dsh-root'), '')
    writeIndex(join(box.store, 'projects', projectKeyOf(projectRoot)), '- [project] 人工锚点命中 — project.md\n')
    assert.match(render(mount(), deep), /人工锚点命中/)
  } finally {
    box.cleanup()
  }
})

test('没有标记时项目根退回 cwd', () => {
  const box = sandbox()
  try {
    writeIndex(join(box.store, 'projects', projectKeyOf(box.cwd)), '- [project] 按 cwd 命中 — project.md\n')
    assert.match(render(mount(), box.cwd), /按 cwd 命中/)
  } finally {
    box.cleanup()
  }
})

test('索引超上限时保最新：旧条目省略、新条目保留，并明说省略了多少', () => {
  const box = sandbox()
  try {
    const lines = ['# 记忆索引']
    for (let i = 0; i < 400; i += 1) lines.push(`- [user] 第 ${i} 条 — user.md`)
    writeIndex(box.store, lines.join('\n'))
    const text = render(mount(), box.cwd)

    assert.match(text, /已省略最早的/)
    assert.match(text, /300 行/)
    assert.match(text, /第 399 条/, '最新的一条必须保留')
    assert.doesNotMatch(text, /第 0 条 /, '最早的一条应被省略')
  } finally {
    box.cleanup()
  }
})

test('索引超 25 KB 时按字节继续省略，体积压回上限内', () => {
  const box = sandbox()
  try {
    const line = '- [project] ' + 'x'.repeat(1024)
    writeIndex(box.store, Array.from({ length: 60 }, () => line).join('\n'))
    const text = render(mount(), box.cwd)
    assert.match(text, /已省略最早的/)
    assert.ok(Buffer.byteLength(text, 'utf8') < 26 * 1024)
  } finally {
    box.cleanup()
  }
})

test('内容里的 {{…}} 原样保留，不触发变量插值', () => {
  const box = sandbox()
  try {
    writeIndex(box.store, '- [reference] 模板语法 {{unknown_var}} 原样保留 — reference.md\n')
    assert.match(render(mount(), box.cwd), /\{\{unknown_var\}\}/)
  } finally {
    box.cleanup()
  }
})

test('frontmatter 被剥离，正文保留', () => {
  const box = sandbox()
  try {
    writeIndex(box.store, '---\ntitle: 索引\nkind: index\n---\n\n- [user] 正文第一行 — user.md\n')
    const text = render(mount(), box.cwd)
    assert.doesNotMatch(text, /title: 索引/)
    assert.match(text, /正文第一行/)
  } finally {
    box.cleanup()
  }
})

test('文件变化后缓存失效，注入内容跟着更新', () => {
  const box = sandbox()
  try {
    const file = join(box.store, 'MEMORY.md')
    writeIndex(box.store, '- [user] 旧内容 — user.md\n')
    const captured = mount()
    assert.match(render(captured, box.cwd), /旧内容/)

    writeFileSync(file, '- [user] 新内容 — user.md\n', 'utf8')
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)

    const text = render(captured, box.cwd)
    assert.match(text, /新内容/)
    assert.doesNotMatch(text, /旧内容/)
  } finally {
    box.cleanup()
  }
})

test('受管读取遇到非法文件时阻断请求，不把错误当空库', () => {
  const box = sandbox()
  try {
    mkdirSync(box.store,{recursive:true}); prepareMountedFixture({empty:true})
    mkdirSync(join(box.store, 'MEMORY.md'), { recursive: true })
    const mounted=mount();assert.throws(()=>render(mounted,box.cwd),/memory-context-managed-state-unavailable/)
  } finally {
    box.cleanup()
  }
})

test('没有 agent 时返回空串，且不抛错', () => {
  const box = sandbox()
  try {
    writeIndex(box.store, '- [user] 任意 — user.md\n')
    const captured = mount()
    assert.equal(captured.context.text({}), '')
    assert.equal(captured.context.text(undefined), '')
  } finally {
    box.cleanup()
  }
})

test('workingDirectory 抛错时退化为不注入', () => {
  const box = sandbox()
  let entry
  try {
    writeIndex(box.store, '- [user] 任意 — user.md\n')
    const ctx = {
      systemPrompt: {
        context(value) {
          entry = value
        },
      },
      workingDirectory: {
        get() {
          throw new Error('projection not ready')
        },
      },
      tools: { register() {} },
      on() {},
    }
    apply(ctx)
    assert.equal(entry.text({ agent: { session: {} } }), '')
  } finally {
    box.cleanup()
  }
})

// ── 索引编辑（纯函数） ──────────────────────────────────────────────────────

test('索引行格式固定为 `- [type] 摘要 — type.md`', () => {
  assert.equal(indexLine('user', '中文写作者'), '- [user] 中文写作者 — user.md')
  assert.equal(indexLine('feedback', '  两边留空要裁掉  '), '- [feedback] 两边留空要裁掉 — feedback.md')
})

test('插入到已有分节末尾，不越过下一个分节', () => {
  const before = ['# 索引', '## user', '', '- [user] 甲 — user.md', '', '## feedback', '', '- [feedback] 乙 — feedback.md', ''].join('\n')
  const after = addIndexLine(before, 'user', '- [user] 丙 — user.md')
  const lines = after.split('\n')
  assert.ok(lines.indexOf('- [user] 丙 — user.md') > lines.indexOf('- [user] 甲 — user.md'))
  assert.ok(lines.indexOf('- [user] 丙 — user.md') < lines.indexOf('## feedback'))
})

test('分节不存在时新建一个', () => {
  const after = addIndexLine('# 索引\n\n## user\n\n- [user] 甲 — user.md', 'reference', '- [reference] 丙 — reference.md')
  assert.match(after, /## reference/)
  assert.match(after, /- \[reference\] 丙 — reference\.md/)
})

test('预算检查：行数与字节数各自生效', () => {
  assert.equal(checkIndexBudget('- [user] 短 — user.md').ok, true)
  const manyLines = Array.from({ length: 350 }, () => '- [user] x — user.md').join('\n')
  assert.equal(checkIndexBudget(manyLines).ok, false, '350 行应超 300 行上限')
  const wide = '- [project] ' + 'x'.repeat(26 * 1024)
  assert.equal(checkIndexBudget(wide).ok, false)
})

test('forgetLines 只删索引行，不动标题与空行', () => {
  const text = '# 索引\n\n## user\n\n- [user] 甲 — user.md\n- [user] 乙 — user.md\n'
  const result = forgetLines(text, '甲')
  assert.equal(result.removed, 1)
  assert.match(result.text, /## user/)
  assert.doesNotMatch(result.text, /甲/)
  assert.match(result.text, /乙/)
})

// ── 工具端到端（走 execute） ────────────────────────────────────────────────

test('memory_write 写入项目库：索引入分节，细节进主题文件', async () => {
  const box = sandbox()
  try {
    const captured = mount()
    const write = tool(captured, 'memory_write')
    const result = await write.execute(
      { type: 'project', summary: 'E01 跑完', detail: 'DS 7,486 字，Gemini 11,024 字' },
      fakeExec(captured, box.cwd),
    )
    assert.equal(result.duplicate, false)
    assert.ok(result.path.endsWith(join('projects', projectKeyOf(box.cwd), 'MEMORY.md')))
    const index = readFileSync(result.path, 'utf8')
    assert.match(index, /## project/)
    assert.match(index, /- \[project\] E01 跑完 — project\.md/)
    const topic = readFileSync(result.detailPath, 'utf8')
    assert.match(topic, /DS 7,486 字/)
    assert.match(topic, /\d{4}-\d{2}-\d{2}｜/)
  } finally {
    box.cleanup()
  }
})

test('memory_write 重复写入不产生第二行', async () => {
  const box = sandbox()
  try {
    const captured = mount()
    const write = tool(captured, 'memory_write')
    const args = { type: 'user', summary: '结论先行', scope: 'global' }
    const first = await write.execute(args, fakeExec(captured, box.cwd))
    const second = await write.execute(args, fakeExec(captured, box.cwd))
    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
    const index = readFileSync(first.path, 'utf8')
    assert.equal(index.split('\n').filter((line) => line.includes('结论先行')).length, 1)
  } finally {
    box.cleanup()
  }
})

test('memory_write 拒绝非法参数', async () => {
  const box = sandbox()
  try {
    const captured = mount()
    const write = tool(captured, 'memory_write')
    await assert.rejects(() => write.execute({ type: 'nope', summary: 'x' }, fakeExec(captured, box.cwd)), /type/)
    await assert.rejects(() => write.execute({ type: 'user', summary: '  ' }, fakeExec(captured, box.cwd)), /summary/)
    await assert.rejects(
      () => write.execute({ type: 'user', summary: 'a\nb' }, fakeExec(captured, box.cwd)),
      /单行/,
    )
    await assert.rejects(
      () => write.execute({ type: 'user', summary: 'x', scope: 'nowhere' }, fakeExec(captured, box.cwd)),
      /scope/,
    )
  } finally {
    box.cleanup()
  }
})

test('memory_write 在索引超预算时拒绝写入并提示压缩', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const lines = ['# 索引']
    for (let i = 0; i < 299; i += 1) lines.push(`- [user] 旧 ${i} — user.md`)
    writeIndex(dir, lines.join('\n'))
    assert.throws(
      () => writeMemory({ type: 'user', dir, line: indexLine('user', '再加一条'), detail: undefined }),
      /超过上限|先.*压缩/,
    )
    // 拒绝后文件不该被改动
    const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.doesNotMatch(after, /再加一条/)
  } finally {
    box.cleanup()
  }
})

test('memory_write 写完后注入立刻能读到（同一进程内）', async () => {
  const box = sandbox()
  try {
    const captured = mount()
    assert.doesNotMatch(render(captured, box.cwd), /刚写的那条/)
    const write = tool(captured, 'memory_write')
    await write.execute({ type: 'project', summary: '刚写的那条' }, fakeExec(captured, box.cwd))
    assert.match(render(captured, box.cwd), /刚写的那条/)
  } finally {
    box.cleanup()
  }
})

test('memory_forget 删除匹配行，返回条数', async () => {
  const box = sandbox()
  try {
    const captured = mount()
    const write = tool(captured, 'memory_write')
    const forget = tool(captured, 'memory_forget')
    await write.execute({ type: 'user', summary: '要删掉的甲', scope: 'global' }, fakeExec(captured, box.cwd))
    await write.execute({ type: 'user', summary: '保留的乙', scope: 'global' }, fakeExec(captured, box.cwd))

    const result = await forget.execute({ match: '要删掉的甲', scope: 'global' }, fakeExec(captured, box.cwd))
    assert.equal(result.removed, 1)
    const index = readFileSync(result.path, 'utf8')
    assert.doesNotMatch(index, /要删掉的甲/)
    assert.match(index, /保留的乙/)
  } finally {
    box.cleanup()
  }
})

test('memory_forget 空 match 被拒绝', async () => {
  const box = sandbox()
  try {
    const captured = mount()
    const forget = tool(captured, 'memory_forget')
    await assert.rejects(() => forget.execute({ match: '  ' }, fakeExec(captured, box.cwd)), /match/)
  } finally {
    box.cleanup()
  }
})

test('appendTopic 会创建主题文件并保留原有内容', () => {
  const box = sandbox()
  try {
    const first = appendTopic(box.store, 'feedback', '第一条')
    const second = appendTopic(box.store, 'feedback', '第二条')
    assert.equal(first, second)
    const text = readFileSync(first, 'utf8')
    assert.match(text, /第一条/)
    assert.match(text, /第二条/)
  } finally {
    box.cleanup()
  }
})

test('forgetMemory 在索引不存在时安全返回 0', () => {
  const box = sandbox()
  try {
    const result = forgetMemory(join(box.store, 'nope'), '任意')
    assert.equal(result.removed, 0)
  } finally {
    box.cleanup()
  }
})
