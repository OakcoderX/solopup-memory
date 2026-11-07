#!/usr/bin/env node
/**
 * 发布门禁：一条命令跑完三段验证。
 *
 *   node scripts/verify.mjs [--no-accept]
 *
 * 1. package.json 中声明的完整单元/集成测试集
 * 2. 评测门禁（逃逸率、写入精确率、成本、气味检测三套数据）
 * 3. 验收（真实记忆库 + 真实会话；需要桌面应用加载了当前版本）
 *
 * 段与段之间不短路：前一段失败也继续跑完，让一次输出看到全部问题。
 * 退出码 0 只在全过时给出。
 */

import { spawnSync } from 'node:child_process'
import { existsSync,readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const withAccept = !process.argv.includes('--no-accept')

const testArgs=JSON.parse(readFileSync(join(ROOT,'package.json'),'utf8')).scripts.test.trim().split(/\s+/)
if(testArgs[0]!=='node'||testArgs[1]!=='--test'||testArgs.slice(2).some(arg=>!/^test\/test(?:-[a-z0-9-]+)?\.mjs$/.test(arg)&&!/^--test-concurrency=[1-9]\d*$/.test(arg)))throw Error('unsupported-test-command')
const SUITES=testArgs.slice(2).filter(arg=>arg.endsWith('.mjs'))

function run(label, command, args) {
  const started = Date.now()
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 300000 })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const ok = result.status === 0
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { label, ok, seconds, output }
}

function tail(output, pattern, fallback = '') {
  const lines = output.split('\n').filter((line) => pattern.test(line))
  return lines.length > 0 ? lines.slice(-6).join('\n') : fallback
}

const results = []

const missing = SUITES.filter((file) => !existsSync(join(ROOT, file)))
if (missing.length > 0) {
  console.error(`缺测试文件：${missing.join(', ')}`)
  process.exit(1)
}

results.push(run('测试', process.execPath, testArgs.slice(1)))
results.push(run('加载探针', process.execPath, ['scripts/probe-load.mjs']))
results.push(run('评测门禁', process.execPath, ['eval/run-eval.mjs', '--check']))
results.push(run('可用性门禁', process.execPath, ['eval/mechanical-table.mjs', '--check']))
if (withAccept) results.push(run('验收', process.execPath, ['accept.mjs']))

let failed = 0
console.log('')
for (const result of results) {
  const mark = result.ok ? 'PASS' : 'FAIL'
  if (!result.ok) failed += 1
  console.log(`[${mark}] ${result.label}（${result.seconds}s）`)
  if (result.ok) {
    const summary =
      result.label === '测试'
        ? tail(result.output, /^(#|ℹ) ?(tests|pass|fail)/)
        : result.label === '评测门禁' || result.label === '可用性门禁' || result.label === '加载探针'
          ? tail(result.output, /^\[(PASS|FAIL)\]/) 
          : tail(result.output, /^\[(PASS|FAIL)\]/)
    if (summary.length > 0) console.log(summary.split('\n').map((line) => `       ${line}`).join('\n'))
  } else {
    console.log(tail(result.output, /not ok|✖|\[FAIL\]|失败|Error/, '(无输出)').split('\n').map((line) => `       ${line}`).join('\n'))
  }
}

console.log('')
if (failed === 0) {
  console.log('机械检查全部通过；真实捕获质量与发布状态需独立验收')
  process.exit(0)
}
console.log(`${failed} 段未通过`)
process.exit(1)
