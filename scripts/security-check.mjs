#!/usr/bin/env node
/**
 * 发版前安全自查（只读）。检查依赖面、运行时执行/网络面、密钥与绝对路径、
 * CI 工作流权限与 pin、打包内容、许可与引擎声明。
 *
 *   node scripts/security-check.mjs
 *   node scripts/security-check.mjs --json
 *
 * 这不是渗透测试，也不能替代独立审计；它检查的是“不该进发行包/不该在运行时出现”的机械项。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const checks = []
const check = (id, run) => {
  try {
    const detail = run()
    checks.push({ id, passed: true, detail: detail ?? null })
  } catch (error) {
    checks.push({ id, passed: false, error: error.message })
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'research', '.git', '.github', 'ci'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const files = walk(ROOT)
const runtimeFiles = files.filter((file) => file.endsWith('.mjs') && !/\/test-[^/]+\.mjs$/.test(file) && !file.includes('/scripts/') && !file.includes('/eval/'))
const text = (file) => readFileSync(file, 'utf8')

/** 发行包实际包含的文件（目录条目展开）。绝对路径与密钥检查只看这些。 */
function shippedFiles() {
  const out = new Set()
  for (const entry of pkg.files ?? []) {
    if (entry.endsWith('/')) {
      const prefix = join(ROOT, entry)
      if (existsSync(prefix)) for (const file of walk(prefix)) out.add(file)
      continue
    }
    const full = join(ROOT, entry)
    if (existsSync(full) && statSync(full).isFile()) out.add(full)
  }
  return [...out]
}
/** 注入测试语料与安全测试里故意放的反例，不是真实凭据。 */
const fixtureAllowlist = (file) => /\/corpus\/|\/test-[^/]+\.mjs$|\/scripts\/security-check\.mjs$/.test(file)

check('dependencies', () => {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
  assert(Object.keys(deps).length === 0, `存在运行时依赖：${Object.keys(deps).join(',')}`)
  return 'zero runtime dependencies'
})

check('install-hooks', () => {
  const hooks = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublishOnly'].filter((name) => pkg.scripts?.[name] !== undefined)
  assert(hooks.length === 0, `存在安装/发布钩子：${hooks.join(',')}`)
  return 'no install hooks'
})

check('runtime-network', () => {
  const hits = []
  for (const file of runtimeFiles) {
    const body = text(file)
    if (/\bfetch\s*\(/.test(body) || /node:(http|https|net|tls)/.test(body) || /\.listen\s*\(/.test(body) || /new\s+WebSocket/.test(body)) hits.push(relative(ROOT, file))
  }
  assert(hits.length === 0, `运行时出现网络/监听面：${hits.join(',')}`)
  return `${runtimeFiles.length} 个运行时文件无网络调用`
})

check('runtime-exec', () => {
  const allowed = new Set(['restore.mjs', 'project-stores.mjs'])
  const hits = []
  for (const file of runtimeFiles) {
    if (!/child_process|\bexecSync\b|\bspawnSync\b/.test(text(file))) continue
    if (!allowed.has(relative(ROOT, file))) hits.push(relative(ROOT, file))
  }
  assert(hits.length === 0, `未登记的运行时子进程：${hits.join(',')}`)
  const restore = text(join(ROOT, 'restore.mjs'))
  assert(/spawnSync\('tar',\s*\[/.test(restore), 'restore.mjs 的子进程不是固定的 tar 参数调用')
  assert(!/shell:\s*true/.test(restore), 'restore.mjs 启用了 shell')
  const projects = text(join(ROOT, 'project-stores.mjs'))
  assert(/execFileSync\('git',\s*\['-C',\s*root,\s*'rev-parse',\s*'--path-format=absolute',\s*'--show-toplevel',\s*'--git-common-dir'\]/.test(projects), 'project-stores.mjs 的子进程不是固定的 git rev-parse 参数调用')
  assert(!/shell:\s*true/.test(projects) && !/\b(?:spawn|exec|execSync|spawnSync)\s*\(/.test(projects), 'project-stores.mjs 出现非允许的子进程调用')
  assert(/GIT_CONFIG_GLOBAL:\s*'\/dev\/null'/.test(projects) && /GIT_CONFIG_NOSYSTEM:\s*'1'/.test(projects) && /GIT_TERMINAL_PROMPT:\s*'0'/.test(projects), 'worktree 身份检查未隔离 Git 全局配置或交互')
  return 'restore 固定调用 tar；project-stores 固定调用 git rev-parse；均无 shell'
})

check('secrets-shipped', () => {
  const patterns = [/gho_[A-Za-z0-9]{20,}/, /npm_[A-Za-z0-9]{20,}/, /sk-[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/]
  const hits = []
  const shipped = shippedFiles().filter((file) => !fixtureAllowlist(file))
  for (const file of [...shipped, join(ROOT, '.github', 'workflows', 'publish.yml')]) {
    if (!existsSync(file) || !/\.(mjs|json|md|yml|yaml|js|txt)$/.test(file)) continue
    const body = text(file)
    for (const pattern of patterns) if (pattern.test(body)) hits.push(`${relative(ROOT, file)}:${pattern}`)
  }
  assert(hits.length === 0, `发行文件里发现密钥：${hits.slice(0, 5).join('；')}`)
  return `${shipped.length} 个发行文件无密钥（测试语料已列允许项）`
})

check('absolute-paths-shipped', () => {
  const pattern = /\/Users\/[a-z][^/\s"']+/
  const hits = shippedFiles().filter((file) => /\.(mjs|json|md|yml|yaml|js|txt)$/.test(file) && pattern.test(text(file)))
  assert(hits.length === 0, `发行文件含机器绝对路径：${hits.map((file) => relative(ROOT, file)).slice(0, 5).join(',')}`)
  return `${shippedFiles().length} 个发行文件无 /Users 绝对路径`
})

check('workflow-pins', () => {
  const file = join(ROOT, '.github', 'workflows', 'publish.yml')
  if (!existsSync(file)) return '未包含发布工作流'
  const body = text(file)
  const uses = [...body.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((match) => match[1])
  const unpinned = uses.filter((value) => !value.startsWith('./.github/workflows/') && !/@[0-9a-f]{40}$/.test(value))
  assert(unpinned.length === 0, `未按 commit pin 的 action：${unpinned.join(',')}`)
  assert(/permissions:\s*\n\s*contents:\s*read/.test(body), '工作流权限不是 contents: read')
  assert(!/secrets\.[A-Za-z0-9_]+/.test(body), '工作流引用了 secrets（优先 OIDC/可信发布）')
  assert(!/pull_request_target/.test(body), '工作流使用了 pull_request_target')
  return `${uses.length} 个 action 全部 pin 到 commit；contents: read；无 secrets`
})

check('package-contents', () => {
  const bad = (pkg.files ?? []).filter((entry) => /research|last-run|\.tgz|node_modules|\.env/.test(entry))
  assert(bad.length === 0, `发行包包含不该发布的条目：${bad.join(',')}`)
  assert(pkg.files.includes('LICENSE') || pkg.license === 'MIT', '发行包未声明 LICENSE')
  return `${pkg.files.length} 个发布条目，无研究目录/日志/tgz`
})

check('license', () => {
  assert(pkg.license === 'MIT', `license=${pkg.license}`)
  const body = text(join(ROOT, 'LICENSE'))
  assert(/MIT License/.test(body), 'LICENSE 不是 MIT 正文')
  return 'MIT'
})

check('engines', () => {
  assert(pkg.engines?.node, '缺少 node engines 声明')
  assert(pkg.engines?.dsh, '缺少 dsh engines 声明')
  return `node ${pkg.engines.node}；dsh ${pkg.engines.dsh}`
})

check('gitignore', () => {
  const body = existsSync(join(ROOT, '.gitignore')) ? text(join(ROOT, '.gitignore')) : ''
  const need = ['node_modules/', '*.tgz']
  const missing = need.filter((line) => !body.includes(line))
  assert(missing.length === 0, `.gitignore 缺：${missing.join(',')}`)
  return '.gitignore 覆盖 node_modules 与 tgz'
})

check('store-permissions-code', () => {
  const security = text(join(ROOT, 'security.mjs'))
  assert(/0o700/.test(security) && /0o600/.test(security), 'security.mjs 未显式设置 0700/0600')
  return 'store 目录 0700、文件 0600（由 soak 实测再次验证）'
})

const passed = checks.every((row) => row.passed)
const report = { passed, scope: 'mechanical pre-release checks; not an independent audit', version: pkg.version, checks }
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
else {
  for (const row of checks) console.log(`[${row.passed ? 'PASS' : 'FAIL'}] ${row.id}${row.passed ? ` · ${row.detail}` : ` · ${row.error}`}`)
  console.log(passed ? `安全自查通过（${checks.length} 项；机械项，不是独立审计）` : '安全自查未通过')
}
if (!passed) process.exitCode = 1
