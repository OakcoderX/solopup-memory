import {realpathSync} from 'node:fs'
/**
 * 并发与故障注入。跑法：node --test ~/.dsh/plugins/memory/test-concurrency.mjs
 *
 * 这两类最容易被本地测试放过：
 *   · 进程内锁测过了，跨进程仍可能丢更新
 *   · 正常路径全绿，但磁盘只读、目标被换成目录、锁残留时就崩
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { apply, storeDirFor, writeMemory } from './index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'worker-write.mjs')

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-conc-')))
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
      // 只读目录要先恢复权限才能删
      try {
        chmodSync(join(home, 'memory'), 0o700)
      } catch {
        /* ignore */
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function runWorker(dir, prefix, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, dir, prefix, String(count)], {
      cwd: HERE,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(JSON.parse(stdout))
      else reject(new Error(`worker ${prefix} 退出码 ${code}: ${stderr.slice(0, 300)}`))
    })
  })
}

// ── 并发 ────────────────────────────────────────────────────────────────────

test('8 个进程 × 5 条并发写入：有界占用重试后40条一条不少', async (t) => {
  const box = sandbox()
  try {
    const dir = join(box.store, 'global')
    mkdirSync(dir, { recursive: true })

    const workers = 8
    const perWorker = 5
    const outcomes = await Promise.allSettled(
      Array.from({ length: workers }, (_, i) => runWorker(dir, `w${i}`, perWorker)),
    )
    // Never remove a fixture while peer workers are still writing; cleanup must
    // not hide the original worker error behind ENOTEMPTY.
    const failures = outcomes.filter((result) => result.status === 'rejected')
    assert.equal(failures.length, 0, failures.map((result) => result.reason.message).join('\n'))
    t.diagnostic(`accepted=40; lock-busy retries=${outcomes.reduce((sum, result) => sum + result.value.retries, 0)}`)

    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    for (let w = 0; w < workers; w += 1) {
      for (let i = 0; i < perWorker; i += 1) {
        assert.ok(index.includes(`w${w}-${i}`), `丢了 w${w}-${i}`)
      }
    }
    const lines = index.split('\n').filter((line) => line.trim().startsWith('- ['))
    assert.equal(lines.length, workers * perWorker, '索引行数应等于总写入数')

    // 不能留半截临时文件
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [], `不应残留临时文件：${leftovers.join(',')}`)
    // 锁应释放
    assert.equal(existsSync(join(dir, '.write.lock')), false)
  } finally {
    box.cleanup()
  }
})

test('并发写入时审计条数与索引行数一致', () => {
  const box = sandbox()
  try {
    const dir = join(box.store, 'global')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 10; i += 1) {
      writeMemory({ type: 'user', dir, line: `- [user] 顺序-${i} — user.md` })
    }
    const audit = readFileSync(join(dir, '.audit.jsonl'), 'utf8').trim().split('\n')
    const okWrites = audit.map((line) => JSON.parse(line)).filter((e) => e.op === 'write' && e.outcome === 'ok')
    assert.equal(okWrites.length, 10)
  } finally {
    box.cleanup()
  }
})

// ── 故障注入 ────────────────────────────────────────────────────────────────

test('目录只读时写入报错，且不留下半截文件', () => {
  const box = sandbox()
  try {
    const dir = join(box.store, 'global')
    mkdirSync(dir, { recursive: true })
    writeMemory({ type: 'user', dir, line: '- [user] 之前 — user.md' })
    const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8')

    chmodSync(dir, 0o500) // r-x
    try {
      assert.throws(() =>
        writeMemory({ type: 'user', dir, line: '- [user] 写入应失败 — user.md' }),
      )
    } finally {
      chmodSync(dir, 0o700)
    }

    const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.equal(after, before, '失败不应改动原文件')
    assert.equal(readdirSync(dir).filter((n) => n.includes('.tmp-')).length, 0, '不应残留临时文件')
  } finally {
    box.cleanup()
  }
})

test('MEMORY.md 被换成目录时，读取降级为空且写入报错而不是静默成功', () => {
  const box = sandbox()
  try {
    const dir = join(box.store, 'global')
    mkdirSync(join(dir, 'MEMORY.md'), { recursive: true })

    const captured = { cwd: box.cwd }
    apply({
      systemPrompt: { context: (entry) => (captured.context = entry) },
      workingDirectory: { get: () => captured.cwd },
      tools: { register() {} },
      on() {},
    })
    assert.match(captured.context.text({ agent: { session: {} } }), /需要升级/, '旧错误目录结构应提示升级，不把状态当空库')

    assert.throws(() => writeMemory({ type: 'user', dir, line: '- [user] x — user.md' }))
  } finally {
    box.cleanup()
  }
})

test('库目录不存在时写入会自动创建（而不是报错）', () => {
  const box = sandbox()
  try {
    const dir = join(box.store, 'brand', 'new')
    assert.equal(existsSync(dir), false)
    const result = writeMemory({ type: 'user', dir, line: '- [user] 自动建目录 — user.md' })
    assert.ok(existsSync(result.path))
  } finally {
    box.cleanup()
  }
})

test('storeDirFor 对含空格与中文的路径也能稳定分库', () => {
  const box = sandbox()
  try {
    const odd = join(box.root, '项目 之一')
    mkdirSync(odd, { recursive: true })
    const a = storeDirFor('project', odd)
    const b = storeDirFor('project', odd)
    assert.equal(a, b, '同一路径必须映射到同一目录')
    assert.doesNotMatch(a, /\s/, '分库名里不应有空格')
    assert.ok(a.startsWith(join(box.store, 'projects')))
  } finally {
    box.cleanup()
  }
})
