#!/usr/bin/env node
/**
 * 可靠性测试（soak）：走**官方离线安装路径**，反复启动真实 DSH 宿主，并做一次 SIGKILL 恢复。
 *
 *   node scripts/soak.mjs                 # 3 次正常启停 + 1 次崩溃恢复
 *   node scripts/soak.mjs --cycles 5
 *   node scripts/soak.mjs --json
 *
 * 断言：
 *   · 官方 CLI 能从 tgz 离线安装，profile 自动选中 bundle；
 *   · 每次宿主启动都写入 .loaded.json：版本一致、6 工具、degraded 为空、sourceControl=managed；
 *   · 每次优雅退出后，记忆内容文件逐字节不变（无模型调用时不该改动）；
 *   · SIGKILL 后重启可加载，且没有遗留 .write.lock / .publication.json；
 *   · 存储目录权限为 0700、文件 0600。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { VERSION } from '../version.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const TOOLS = ['memory_write', 'memory_forget', 'memory_links', 'memory_search', 'memory_prune', 'memory_status']
const DATA_FILES = /^(MEMORY\.md|(user|feedback|project|reference)\.md|\.candidates\.json|\.episodes\.json|\.history\.jsonl)$/
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const activeHosts = new Set()

function dataFingerprint(memoryRoot) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && DATA_FILES.test(entry.name)) out.push([full.slice(memoryRoot.length), statSync(full).size, hash(full)])
    }
  }
  if (existsSync(memoryRoot)) walk(memoryRoot)
  return JSON.stringify(out.sort())
}

function packTarball() {
  const result = spawnSync('npm', ['pack', '--silent'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 })
  if (result.status !== 0) throw new Error(`npm pack 失败：${result.stderr ?? ''}`)
  const name = result.stdout.trim().split('\n').at(-1)
  return join(ROOT, name)
}

function install(tgz, home) {
  const profile = join(home, 'profiles', 'soak')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'solopup-soak', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  const result = spawnSync(CLI, ['plugin', '--profile', 'soak', 'add', tgz, '--offline', '--ignore-scripts'], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 180000,
  })
  if (result.status !== 0) throw new Error(`官方离线安装失败：${(result.stderr ?? result.stdout ?? '').slice(-500)}`)
  const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  if (!pkg.dsh?.profile?.bundles?.includes('solopup-memory')) throw new Error('安装后 bundle 未自动选中')
  return profile
}

async function startHost(home, profile) {
  const child = spawn(CLI, ['--profile', 'soak', '--port', '0', '--no-open'], {
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DSH_HOME: home, TMPDIR: join(home, 'tmp') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  activeHosts.add(child)
  child.once('exit', () => activeHosts.delete(child))
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const marker = join(home, 'memory', '.loaded.json')
  const started = Date.now()
  const deadline = started + 40000
  while (Date.now() < deadline) {
    await sleep(200)
    if (!existsSync(marker)) continue
    try {
      const stamp = JSON.parse(readFileSync(marker, 'utf8'))
      if (stamp?.pid === child.pid && stamp.version === VERSION) {
        return { child, stamp, loadMs: Date.now() - started, output: () => output }
      }
    } catch {
      /* 写入中，重试 */
    }
  }
  child.kill('SIGKILL')
  throw new Error(`宿主未在 40s 内就绪：${output.slice(-400)}`)
}

async function stopHost(child) {
  const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  const result = await exited
  clearTimeout(timer)
  return result
}

function assertStorePermissions(memoryRoot) {
  const mode = (path, expected) => {
    const value = statSync(path).mode & 0o777
    if (value !== expected) throw new Error(`${path} 权限 ${value.toString(8)}，期望 ${expected.toString(8)}`)
  }
  mode(memoryRoot, 0o700)
  for (const name of readdirSync(memoryRoot)) {
    if (name === 'projects') continue
    const full = join(memoryRoot, name)
    if (statSync(full).isFile() && !name.endsWith('.lock') && !name.endsWith('.json')) mode(full, 0o600)
  }
}

export async function soak({ cycles = 3 } = {}) {
  const base = realpathSync(mkdtempSync(join(homedir(), '.dsh-soak-')))
  const home = join(base, 'home')
  mkdirSync(home)
  mkdirSync(join(home, 'tmp'))
  const memoryRoot = join(home, 'memory')
  const report = { cycles, version: VERSION, startedAt: new Date().toISOString(), loads: [], crash: null, dataStable: null, permissions: null }
  try {
    const tgz = packTarball()
    const profile = install(tgz, home)
    const baseline = dataFingerprint(memoryRoot)
    for (let index = 0; index < cycles; index += 1) {
      const run = await startHost(home, profile)
      if (run.stamp.degraded?.length) throw new Error(`第 ${index + 1} 次加载 degraded：${run.stamp.degraded.join(',')}`)
      if (run.stamp.sourceControl?.state !== 'managed') throw new Error(`第 ${index + 1} 次 sourceControl=${run.stamp.sourceControl?.state}`)
      const missing = TOOLS.filter((name) => !(run.stamp.tools ?? []).includes(name))
      if (missing.length) throw new Error(`第 ${index + 1} 次缺工具：${missing.join(',')}`)
      if (index === 0) {
        // 用官方 accept.mjs 对“正在运行的宿主”做只读安装/运行验收。
        const accept = spawnSync(process.execPath, [join(ROOT, 'accept.mjs'), '--profile', 'soak'], {
          env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: home },
          encoding: 'utf8',
          timeout: 30000,
        })
        let parsed
        try {
          parsed = JSON.parse(accept.stdout)
        } catch {
          throw new Error(`accept.mjs 输出无法解析：${(accept.stderr ?? accept.stdout ?? '').slice(-400)}`)
        }
        if (!parsed.passed) throw new Error(`accept.mjs 未通过：${JSON.stringify(parsed.checks.filter((row) => !row.passed))}`)
        report.accept = { passed: true, checks: parsed.checks.length }
      }
      const stopped = await stopHost(run.child)
      if (stopped.code !== 0 && stopped.signal !== 'SIGTERM') throw new Error(`第 ${index + 1} 次退出异常：${JSON.stringify(stopped)}`)
      report.loads.push({ cycle: index + 1, loadMs: run.loadMs, exit: stopped.code ?? stopped.signal })
    }
    report.permissions = (assertStorePermissions(memoryRoot), 'ok')

    // 崩溃恢复：加载后立刻 SIGKILL，再重启。
    const crashRun = await startHost(home, profile)
    crashRun.child.kill('SIGKILL')
    await new Promise((done) => crashRun.child.once('exit', done))
    const leftovers = ['.write.lock', '.publication.json'].filter((name) => existsSync(join(memoryRoot, name)))
    if (leftovers.length) throw new Error(`崩溃后遗留：${leftovers.join(',')}`)
    const restarted = await startHost(home, profile)
    if (restarted.stamp.degraded?.length) throw new Error(`崩溃恢复后 degraded：${restarted.stamp.degraded.join(',')}`)
    const restartMs = restarted.loadMs
    await stopHost(restarted.child)
    report.crash = { recovered: true, restartMs, leftovers: 0 }

    // 并发：同一 store 上两个宿主同时运行，随后第三个宿主重新加载。
    const hostA = await startHost(home, profile)
    const hostB = await startHost(home, profile)
    await sleep(1200)
    const aliveA = hostA.child.exitCode === null
    const aliveB = hostB.child.exitCode === null
    if (!aliveA || !aliveB) throw new Error(`并发宿主未同时存活：A=${aliveA} B=${aliveB}`)
    await stopHost(hostA.child)
    await stopHost(hostB.child)
    const reload = await startHost(home, profile)
    if (reload.stamp.degraded?.length) throw new Error(`并发后 reload degraded：${reload.stamp.degraded.join(',')}`)
    await stopHost(reload.child)
    report.concurrency = { hosts: 2, bothAlive: true, reloadAfter: true }

    report.dataStable = dataFingerprint(memoryRoot) === baseline
    if (!report.dataStable) throw new Error('多轮启停后记忆内容文件发生变化（无模型调用时应保持不变）')
    report.passed = true
  } catch (error) {
    report.passed = false
    report.error = error.message
  } finally {
    await Promise.all([...activeHosts].filter(child => child.exitCode === null && child.signalCode === null).map(stopHost))
    rmSync(base, { recursive: true, force: true })
  }
  report.finishedAt = new Date().toISOString()
  return report
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const argv = process.argv.slice(2)
  const cyclesAt = argv.indexOf('--cycles')
  const cycles = cyclesAt >= 0 ? Number(argv[cyclesAt + 1]) : 3
  const report = await soak({ cycles })
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else {
    const lines = [
      `SoloPup 可靠性测试（官方离线安装 + 真实宿主）· v${report.version}`,
      `正常启停 ${report.loads.length} 次：` + report.loads.map((row) => `${row.loadMs}ms`).join('、') + `；退出 ${report.loads.map((row) => row.exit).join('、')}`,
      report.crash ? `崩溃恢复：SIGKILL 后重启 ${report.crash.restartMs}ms，遗留锁/发布标记 ${report.crash.leftovers} 个` : '崩溃恢复：未执行',
      report.concurrency ? `并发宿主：${report.concurrency.hosts} 个同时存活=${report.concurrency.bothAlive}，之后 reload=${report.concurrency.reloadAfter}` : '并发宿主：未执行',
      `记忆内容文件多轮不变：${report.dataStable === true ? '是' : '否'}`,
      `存储权限：${report.permissions ?? '未检查'}`,
      report.accept ? `官方 accept 验收：${report.accept.checks} 项通过` : '官方 accept 验收：未执行',
    ]
    if (!report.passed) lines.push(`[FAIL] ${report.error}`)
    else lines.push('[PASS] 可靠性测试通过')
    process.stdout.write(lines.join('\n') + '\n')
  }
  if (!report.passed) process.exit(1)
}
