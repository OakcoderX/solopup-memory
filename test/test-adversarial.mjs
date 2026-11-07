import {prepareMountedFixture} from '../fixture-host.mjs'
import {realpathSync} from 'node:fs'
/**
 * 对抗测试。跑法：node --test ~/.dsh/plugins/memory/test/test-adversarial.mjs
 *
 * 三层：
 *   1. 题库驱动 —— corpus/injections.json 里每条 payload 按 expect 断言
 *   2. 端到端 —— 把所有 payload 塞进一个库，检查渲染出来的框架完整性
 *   3. fuzz —— 随机 Unicode / 长度 / 分节嵌套，检查不变式
 * 外加生命周期：过期、配额、残留锁。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  utimesSync,
  existsSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { findSecrets, sanitizeForInjection, withLock } from '../security.mjs'
import { addIndexLine, apply, indexLine, isExpired, parseExpiry, storeDirFor, storeSize, writeMemory } from '../index.mjs'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))

const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-adv-')))
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
  prepareMountedFixture()
  apply({
    systemPrompt: { context: (entry) => (captured.context = entry) },
    workingDirectory: { get: () => captured.cwd },
    tools: { register: (definition) => captured.tools.push(definition) },
    on() {},
  })
  return captured
}

const render = (captured) => captured.context.text({ agent: { session: {} } })

// ── 1. 题库驱动 ─────────────────────────────────────────────────────────────

const corpus = JSON.parse(readFileSync(join(HERE, 'corpus', 'injections.json'), 'utf8'))

test('题库覆盖 12 类攻击面，且每条都有明确的期待行为', () => {
  assert.ok(corpus.entries.length >= 60, `条目太少：${corpus.entries.length}`)
  const categories = new Set(corpus.entries.map((entry) => entry.category))
  assert.ok(categories.size >= 10, `类别太少：${[...categories].join(',')}`)
  for (const entry of corpus.entries) {
    assert.ok(['neutralized', 'no-invisible', 'secret', 'unchanged'].includes(entry.expect), `未知 expect：${entry.id}`)
  }
})

for (const entry of corpus.entries) {
  test(`payload ${entry.id}（${entry.category}）→ ${entry.expect}`, () => {
    const out = sanitizeForInjection(entry.payload)

    if (entry.expect === 'neutralized') {
      for (const token of entry.forbidden ?? []) {
        assert.ok(!out.includes(token), `未中和：${JSON.stringify(token)}`)
      }
      if (entry.mustKeep !== undefined) {
        assert.ok(out.includes(entry.mustKeep), '正文不应被整段丢弃')
      }
      assert.doesNotMatch(out, /<\/?(memory|system-reminder)[^>]*>/i)
    }

    if (entry.expect === 'no-invisible') {
      assert.doesNotMatch(out, INVISIBLE)
    }

    if (entry.expect === 'secret') {
      assert.ok(findSecrets(entry.payload).length > 0, '应识别出凭据')
      assert.match(out, /\[REDACTED:/)
      assert.ok(!findSecrets(out).length, '打码后不应再命中')
    }

    if (entry.expect === 'unchanged') {
      // 已知缺口：记录既有行为，一旦未来开始拦截，这条就会失败并提醒更新语料
      assert.equal(out, entry.payload, '行为变了：请更新 corpus 与发布计划里的已知限制')
    }
  })
}

// ── 2. 端到端：全部 payload 进同一个库 ──────────────────────────────────────

test('全部 payload 写进一个库后，渲染结果只保留插件自己的框架边界', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    const lines = corpus.entries.map((entry, index) => {
      const body = entry.payload.replace(/\n/g, ' ')
      return `- [user] ${index} ${body} — user.md`
    })
    writeFileSync(join(dir, 'MEMORY.md'), `# 索引\n\n## user\n\n${lines.join('\n')}\n`, 'utf8')

    const text = render(mount(box.cwd))
    assert.match(text, /^<memory-store>/)
    assert.equal((text.match(/<\/memory-store>/g) ?? []).length, 1, '闭合标签必须只有一个')
    assert.equal((text.match(/<memory-store>/g) ?? []).length, 1, '开启标签必须只有一个')
    assert.doesNotMatch(text, /<system-reminder>/i)
    assert.doesNotMatch(text, INVISIBLE)
    assert.equal(findSecrets(text).length, 0, '注入里不应出现任何凭据原文')
    assert.ok(Buffer.byteLength(text, 'utf8') < 30 * 1024, '注入体积应被限额兜住')
  } finally {
    box.cleanup()
  }
})

// ── 3. fuzz ─────────────────────────────────────────────────────────────────

/** 固定种子的线性同余，保证失败可复现。 */
function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const NASTY = [
  '<', '>', '/', '"', "'", '`', '&', '#', '|', '\\', '\n', '\t', ' ',
  '\u200b', '\u200d', '\u202e', '\u202c', '\u2066', '\u2069', '\u0000',
  '\u001b', '\uFEFF', '\u{E0041}', 'a', 'Z', '0', '中', '文', '—', '{', '}',
]

test('fuzz：净化不抛错、幂等、且不留越权字符', () => {
  const rand = prng(20261025)
  for (let round = 0; round < 400; round += 1) {
    const length = Math.floor(rand() * 200)
    let payload = ''
    for (let i = 0; i < length; i += 1) payload += NASTY[Math.floor(rand() * NASTY.length)]

    const once = sanitizeForInjection(payload)
    const twice = sanitizeForInjection(once)

    assert.equal(twice, once, `幂等失败（round ${round}）`)
    assert.doesNotMatch(once, INVISIBLE, `残留不可见字符（round ${round}）`)
    assert.doesNotMatch(once, /<\/?memory-store|<system-reminder/i, `残留定界符（round ${round}）`)
    assert.ok(once.length <= payload.length + 8, `净化后不应变长（round ${round}）`)
  }
})

test('fuzz：随机分节结构下，索引插入保持结构完整', () => {
  const rand = prng(7)
  const headers = ['user', 'feedback', 'project', 'reference', 'misc', '']
  for (let round = 0; round < 200; round += 1) {
    const parts = ['# 索引']
    const lineCount = 1 + Math.floor(rand() * 12)
    for (let i = 0; i < lineCount; i += 1) {
      const roll = rand()
      if (roll < 0.3) parts.push(`## ${headers[Math.floor(rand() * headers.length)]}`)
      else parts.push(`- [user] 第 ${i} 条 — user.md`)
    }
    const before = parts.join('\n')
    const target = headers[Math.floor(rand() * 4)]
    const after = addIndexLine(before, target, `- [${target}] 新条目 — ${target}.md`)

    // 新条目恰好出现一次
    assert.equal(after.split(`- [${target}] 新条目`).length - 1, 1, `round ${round}`)
    // 不新增重复的同类分节
    const sameHeaders = after.split('\n').filter((line) => line.trim() === `## ${target}`).length
    const hadHeader = before.split('\n').filter((line) => line.trim() === `## ${target}`).length
    assert.equal(sameHeaders, hadHeader === 0 ? 1 : hadHeader, `round ${round}：分节数应不变或恰好加一`)
    // 原有内容一行不少
    for (const line of before.split('\n')) assert.ok(after.includes(line), `round ${round}：丢了「${line}」`)
  }
})

// ── 4. 生命周期 ─────────────────────────────────────────────────────────────

test('过期条目不再注入，但保留在文件里', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
    writeFileSync(
      join(dir, 'MEMORY.md'),
      [
        '# 索引',
        '',
        '## user',
        `- [user] 已过期 ${yesterday} — user.md (exp:${yesterday})`,
        `- [user] 还有效 ${tomorrow} — user.md (exp:${tomorrow})`,
        '',
      ].join('\n'),
      'utf8',
    )

    const text = render(mount(box.cwd))
    assert.doesNotMatch(text, /已过期/)
    assert.match(text, /还有效/)
    assert.match(text, /已隐藏 1 条过期记忆/)
    // 文件本身不动
    const raw = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.match(raw, /已过期/)
  } finally {
    box.cleanup()
  }
})

test('isExpired 按本地日历日：当天有效，本地次日零点过期', () => {
  const day = new Date(2026, 9, 25).getTime() // 本地 2026-10-25 00:00
  const line = '- [user] x — user.md (exp:2026-10-25)'
  assert.equal(isExpired(line, day), false, '当天有效')
  assert.equal(isExpired(line, day + 86399999), false, '当天最后一毫秒有效')
  assert.equal(isExpired(line, day + 86400000), true, '本地次日零点过期')
  assert.equal(isExpired('- [user] 无标记 — user.md', day + 10 ** 12), false)
})

test('parseExpiry 拒绝非法日期', () => {
  assert.equal(parseExpiry(undefined), undefined)
  assert.equal(parseExpiry('2026-12-01'), '2026-12-01')
  assert.throws(() => parseExpiry('2026-13-01'), /合法日期/)
  assert.throws(() => parseExpiry('2026-02-30'), /合法日期/)
  assert.throws(() => parseExpiry('26-12-01'), /YYYY-MM-DD/)
})

test('写入时带 expires，索引行带标记', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    const result = writeMemory({
      type: 'project',
      dir,
      line: indexLine('project', '限期条目', '2026-12-01'),
    })
    assert.match(result.indexLine, /\(exp:2026-12-01\)$/)
    assert.match(readFileSync(result.path, 'utf8'), /限期条目 — project\.md \(exp:2026-12-01\)/)
  } finally {
    box.cleanup()
  }
})

test('总配额超限时拒绝写入', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    // 造一个 2 MB 的主题文件把配额吃满
    writeFileSync(join(dir, 'user.md'), 'x'.repeat(2 * 1024 * 1024), 'utf8')
    assert.ok(storeSize(dir) >= 2 * 1024 * 1024)

    assert.throws(
      () => writeMemory({ type: 'user', dir, line: '- [user] 配额检查 — user.md' }),
      /超过配额/,
    )
    assert.equal(existsSync(join(dir, 'MEMORY.md')), false, '被拒绝时不应创建索引')
  } finally {
    box.cleanup()
  }
})

test('storeSize 统计嵌套目录', () => {
  const box = sandbox()
  try {
    const dir = join(box.store, 'a', 'b')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(box.store, 'root.txt'), 'x'.repeat(100))
    writeFileSync(join(dir, 'deep.txt'), 'y'.repeat(50))
    assert.ok(storeSize(box.store) >= 150)
  } finally {
    box.cleanup()
  }
})

// ── 5. 残留锁 ───────────────────────────────────────────────────────────────

test('残留锁（超 staleMs）会被回收，不永久卡死', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    const lock = join(dir, '.write.lock')
    writeFileSync(lock, '{"pid":1}', 'utf8')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)

    const value = withLock(dir, () => 'acquired', { timeoutMs: 500, staleMs: 1000 })
    assert.equal(value, 'acquired')
    assert.equal(existsSync(lock), false, '锁应被释放')
  } finally {
    box.cleanup()
  }
})

test('未到 staleMs 的锁会如实报忙，而不是静默覆盖', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.write.lock'), '{"pid":1}', 'utf8')
    assert.throws(
      () => withLock(dir, () => 'never', { timeoutMs: 100, staleMs: 60_000 }),
      /正被另一个写入占用/,
    )
  } finally {
    box.cleanup()
  }
})
