#!/usr/bin/env node
import {realpathSync} from 'node:fs'
/** Offline pack -> clean extraction -> packaged tests -> fresh-home host load. No install. */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { probeEnvironment } from './probe-env.mjs'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const args = process.argv.slice(2)
const reportAt = args[0] === '--report' && args.length === 2 ? resolve(args[1]) : undefined
if (args.length && !reportAt) throw new Error('用法：probe-package.mjs [--report 文件]')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-package-')))
const cleanEnv = probeEnvironment(root)
mkdirSync(cleanEnv.HOME); mkdirSync(cleanEnv.TMPDIR)
let host
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const report = { at: new Date().toISOString(), sourceVersion: JSON.parse(readFileSync(join(source, 'package.json'))).version, releaseReady: false }
function run(command, argv, cwd, extra = {}) {
  const result = spawnSync(command, argv, { cwd, env: cleanEnv, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024, ...extra })
  if (result.status !== 0) {
    report.commandFailure = { command, args: argv, code: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-24000) }
    throw new Error(`package-probe-command-failed:${command}:${result.status}`)
  }
  return result.stdout
}
try {
  if (!existsSync(CLI)) throw new Error('package-probe-host-unavailable')
  const packed = JSON.parse(run('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root], source))[0]
  const paths = packed.files.map((file) => file.path)
  if (paths.some((path) => path.startsWith('/') || path.split('/').includes('..') || /^(research|node_modules|eval\/bench)\//.test(path) || /(^|\/)\.(loaded|episodes|candidates|capture-jobs|capture-inputs|capture-state|publication)/.test(path))) throw new Error('package-probe-private-or-unsafe-path')
  const archive = join(root, packed.filename)
  report.archiveSha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
  report.files = paths
  run('tar', ['-xzf', archive, '-C', root], root)
  const unpacked = join(root, 'package')
  report.privacyFindings = paths.filter((path) => /\/Users\/oakfilm(?:\/|\b)/.test(readFileSync(join(unpacked, path), 'utf8')))
  if (report.privacyFindings.length) throw new Error('package-probe-machine-specific-content')
  const pkg = JSON.parse(readFileSync(join(unpacked, 'package.json')))
  if (pkg.version !== report.sourceVersion) throw new Error('package-probe-version-mismatch')
  const testArgs = pkg.scripts.test.trim().split(/\s+/)
  if(testArgs[0]!=='node'||testArgs[1]!=='--test'||testArgs.slice(2).some(arg=>!arg.endsWith('.mjs')&&!/^--test-concurrency=[1-9]\d*$/.test(arg)))throw Error('package-probe-unsupported-test-command')
  const testOutput = run(process.execPath, testArgs.slice(1), unpacked)
  report.packagedTests = Number(/(?:ℹ|#) tests (\d+)/.exec(testOutput)?.[1])
  report.lockContention = testOutput.split('\n').filter((line) => /accepted=40; lock-busy retries=/.test(line))
  if (!Number.isInteger(report.packagedTests) || report.packagedTests < 1) throw new Error('package-probe-test-count-missing')

  // Entire profile is authored here; no copy of the user's desktop configuration.
  const home = join(root, 'home'); const profile = join(home, 'profiles', 'clean')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-memory-package-probe', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  run(process.execPath, ['scripts/patch.mjs', 'install', '--profile', profile, '--plugin', join(unpacked, 'index.mjs')], unpacked)
  host = spawn(CLI, ['--profile', 'clean', '--port', '0', '--no-open'], { env: cleanEnv, stdio: ['ignore', 'ignore', 'ignore'] })
  let hostError
  host.once('error', (error) => { hostError = error.code })
  const marker = join(home, 'memory', '.loaded.json')
  const deadline = Date.now() + 40000
  let stamp
  while (Date.now() < deadline && host.exitCode === null && !hostError) {
    if (existsSync(marker)) {
      const observed = JSON.parse(readFileSync(marker))
      if (typeof observed.version === 'string' && Array.isArray(observed.tools)) { stamp = observed; break }
    }
    await sleep(100)
  }
  if (!stamp) throw new Error(`package-probe-host-load-failed:${hostError ?? host.exitCode ?? 'timeout'}`)
  const expected = ['memory_write', 'memory_forget', 'memory_links', 'memory_search', 'memory_prune', 'memory_status']
  if (stamp.version !== pkg.version || expected.some((tool) => !stamp.tools.includes(tool)) || stamp.degraded.length || stamp.sourceControl?.state !== 'managed') throw new Error('package-probe-host-registration-failed')
  report.hostLoad = { version: stamp.version, node: stamp.node, tools: stamp.tools, cleanHome: true, profileCopied: false, sourceControl: stamp.sourceControl,
    environmentAllowlist: Object.keys(cleanEnv).sort(), parentEnvironmentInherited: false }
  const retained = join(home, 'memory', 'MEMORY.md')
  const syntheticMemory = '- [user] 合成验收偏好只用于打包检查 — user.md\n'
  writeFileSync(retained, syntheticMemory)
  const unrelated = join(home, 'profiles', 'unrelated'); mkdirSync(unrelated)
  writeFileSync(join(unrelated, 'cordis.patch.yml'), '# unrelated synthetic profile\n[]\n')
  run(process.execPath, ['scripts/patch.mjs', 'uninstall', '--profile', profile], unpacked)
  if (readFileSync(join(profile, 'cordis.patch.yml'), 'utf8') !== '[]\n' || readFileSync(retained, 'utf8') !== syntheticMemory || readFileSync(join(unrelated, 'cordis.patch.yml'), 'utf8') !== '# unrelated synthetic profile\n[]\n') throw new Error('package-probe-uninstall-retention-failed')
  report.patchLifecycle = { actualInstallerUsedForHostLoad: true, installUninstall: true, unrelatedProfilePreserved: true, syntheticMemoryPreserved: true, runningHostReloadTested: false }
  if (reportAt) {
    const artifact = join(dirname(reportAt), `${pkg.name}-${pkg.version}-${report.archiveSha256.slice(0, 12)}.tgz`)
    if (!existsSync(artifact)) copyFileSync(archive, artifact, constants.COPYFILE_EXCL)
    if (createHash('sha256').update(readFileSync(artifact)).digest('hex') !== report.archiveSha256) throw new Error('package-probe-export-hash-mismatch')
    report.archivePath = artifact
  }
  report.passed = true
  console.log(`[PASS] 实际安装包 ${pkg.version}：${report.packagedTests} 项测试；全新 DSH_HOME 加载六工具；配置卸载保留合成数据`)
} catch (error) {
  report.passed = false; report.error = error.message
  console.error(`[FAIL] ${error.message}`); process.exitCode = 1
} finally {
  if (host && host.exitCode === null && !host.killed) {
    const stopped = new Promise((resolve) => host.once('exit', resolve))
    host.kill('SIGTERM'); await Promise.race([stopped, sleep(1500)])
    if (host.exitCode === null && host.signalCode === null) { host.kill('SIGKILL'); await Promise.race([stopped, sleep(1500)]) }
  }
  if (reportAt) writeFileSync(reportAt, JSON.stringify(report, null, 2) + '\n')
  rmSync(root, { recursive: true, force: true })
}
