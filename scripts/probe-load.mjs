#!/usr/bin/env node
import {realpathSync} from 'node:fs'
/**
 * 隔离加载探针：用临时 DSH_HOME 与最小新配置启动宿主，验证插件真的能加载。
 *
 *   node scripts/probe-load.mjs
 *
 * 为什么需要它：宿主在**注册时**校验工具 schema，不合格会让整个插件静默不加载；
 * 单元测试直接调 execute()，完全绕过那道校验。2026-10-28 就是这样翻车的：
 * 272 个测试全绿，插件却因为 `additionalProperties` 不是布尔值而没加载。
 *
 * 不复制用户 profile 或继承凭据，不启动其额外插件；--port 0 --no-open，跑完即删。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { VERSION } from '../version.mjs'

const CLI =
  process.env.DSH_CLI ??
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
if (!existsSync(CLI)) {
  console.error(`[FAIL] 找不到宿主 CLI（${CLI}）；可用 DSH_CLI 指定入口，不能据此报告加载通过`)
  process.exit(2)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-probe-')))
const home = join(root, 'home')
const profile = join(home, 'profiles', 'probe')
mkdirSync(profile, { recursive: true })
mkdirSync(join(root, 'tmp'))
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-memory-source-probe', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
writeFileSync(join(profile, 'cordis.yml'), '[]\n')
const entry = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs')).href
writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: memory\n      name: ${JSON.stringify(entry)}\n`)

const child = spawn(CLI, ['--profile', 'probe', '--port', '0', '--no-open'], {
  env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DSH_HOME: home, TMPDIR: join(root, 'tmp') },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', (chunk) => (output += chunk))
child.stderr.on('data', (chunk) => (output += chunk))

const marker = join(home, 'memory', '.loaded.json')
const deadline = Date.now() + 40_000
let stamp
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (existsSync(marker)) {
    const observed = JSON.parse(readFileSync(marker, 'utf8'))
    // apply() writes a preliminary pid marker before final registration status.
    if (typeof observed.version === 'string' && Array.isArray(observed.tools)) {
      stamp = observed
      break
    }
  }
}

child.kill('SIGTERM')
await new Promise((resolve) => setTimeout(resolve, 500))
rmSync(root, { recursive: true, force: true })

const loadError = output
  .split('\n')
  .find((line) => line.includes('memory (file://') || line.includes('JsonSchemaError'))

if (stamp === undefined) {
  console.error(`[FAIL] 插件没有加载${loadError === undefined ? '' : `\n       ${loadError.trim()}`}`)
  process.exit(1)
}
if (stamp.version !== VERSION) {
  console.error(`[FAIL] 加载的是 v${stamp.version}，当前代码是 v${VERSION}`)
  process.exit(1)
}
const expected = ['memory_write', 'memory_forget', 'memory_links', 'memory_search', 'memory_prune', 'memory_status']
const missing = expected.filter((name) => !(stamp.tools ?? []).includes(name))
if (missing.length > 0) {
  console.error(`[FAIL] 少注册了工具：${missing.join('、')}`)
  process.exit(1)
}
if (stamp.sourceControl?.state !== 'managed' || stamp.degraded?.length) { console.error('[FAIL] 工具存在但来源控制未就绪'); process.exit(1) }
console.log(`[PASS] 隔离实例加载成功：v${stamp.version}，${stamp.tools.length} 个工具，pid ${stamp.pid}`)
