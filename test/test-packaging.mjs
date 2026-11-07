/**
 * 打包完整性。跑法：node --test ~/.dsh/plugins/memory/test/test-packaging.mjs
 *
 * 发布前最容易漏的四件事：版本两处不一致、manifest 字段缺失、files 漏了运行时文件、
 * 文档里指向不存在的文件。这些都是机械可查的，不该靠人记得。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { probeEnvironment } from '../scripts/probe-env.mjs'

import { VERSION } from '../version.mjs'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))

test('版本单点：package.json 与 version.mjs 一致', () => {
  assert.equal(pkg.version, VERSION)
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/)
})

test('manifest：官方 bundle 配置层和宿主版本约束均存在', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(HERE, pkg.dsh.bundle.patch)))
  assert.equal(typeof pkg.engines?.dsh, 'string')
  assert.match(pkg.engines.dsh, /[<>]=?\s*\d+\.\d+/)
  assert.match(pkg.engines.node, />=24/)
})

test('入口文件存在且是 ESM', () => {
  assert.equal(pkg.type, 'module')
  assert.ok(existsSync(join(HERE, pkg.main)))
  for (const entry of Object.values(pkg.exports)) {
    assert.ok(existsSync(join(HERE, entry)), `exports 指向不存在的文件：${entry}`)
  }
})

test('files 覆盖运行时必需文件', () => {
  const files = pkg.files ?? []
  for (const required of ['field-lineage.mjs', 'source-record.mjs', 'index.mjs', 'security.mjs', 'version.mjs', 'tool-inputs.mjs', 'source-retirement.mjs', 'belief-revision.mjs', 'tool-observations.mjs', 'capture-diagnostics.mjs', 'snapshots.mjs', 'restore.mjs', 'restoration-lock.mjs', 'scripts/backup.mjs', 'runtime-startup.mjs', 'managed-activation.mjs', 'scripts/control.mjs', 'managed-access.mjs', 'managed-policy.mjs', 'managed-hooks.mjs', 'store-lock-guard.mjs', 'capture-llm.mjs', 'capture-evidence.mjs', 'capture-jobs.mjs', 'capture-inputs.mjs', 'context-history.mjs', 'retrieval.mjs', 'candidates.mjs', 'publication.mjs', 'withdrawal.mjs', 'managed-logs.mjs', 'plugin-config.mjs', 'host-services.mjs', 'project-stores.mjs', 'service-readiness.mjs', 'scripts/projects.mjs', 'cordis.patch.yml', 'README.md', 'SECURITY.md', 'LICENSE', 'COMPATIBILITY.md', 'scripts/']) {
    assert.ok(files.some(entry => entry === required || entry.endsWith('/') && required.startsWith(entry)), `files 漏了 ${required}`)
    assert.ok(existsSync(join(HERE, required)), `发布目录缺少 ${required}`)
  }
})

test('文档齐全且不提不存在的东西', () => {
  for (const doc of ['README.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(existsSync(join(HERE, doc)), `缺 ${doc}`)
  }
  const readme = readFileSync(join(HERE, 'README.md'), 'utf8')
  assert.match(readme, /SECURITY\.md/)
  assert.match(readme, /scripts\/verify\.mjs/, 'README 应给出可执行的门禁命令')
  const security = readFileSync(join(HERE, 'SECURITY.md'), 'utf8')
  assert.match(security, /不.*防护|不防护|明确/, '安全文档必须写清不防什么')
})

test('没有绝对路径泄漏进 package.json', () => {
  const text = readFileSync(join(HERE, 'package.json'), 'utf8')
  assert.doesNotMatch(text, /\/Users\//)
  assert.doesNotMatch(text, /file:\/\//)
})

test('npm scripts 指向真实存在的测试文件', () => {
  const script = pkg.scripts?.test ?? ''
  const files = script.split(/\s+/).filter((token) => token.endsWith('.mjs'))
  assert.ok(files.length >= 8, `test 脚本只覆盖 ${files.length} 个文件`)
  for (const file of files) assert.ok(existsSync(join(HERE, file)), `脚本引用了不存在的 ${file}`)
})

test('测试集中在 test/，命令与发布清单完整覆盖同一集合', () => {
  const isSuite = name => /^test(?:-[a-z0-9-]+)?\.mjs$/.test(name)
  assert.deepEqual(readdirSync(HERE).filter(isSuite), [], '根目录不应再有测试入口')
  const suites = readdirSync(join(HERE, 'test')).filter(isSuite).map(name => `test/${name}`).sort()
  const declared = pkg.scripts.test.split(/\s+/).filter(token => token.endsWith('.mjs')).sort()
  assert.deepEqual(declared, suites, 'npm test 应覆盖全部测试且没有重复项')
  for (const suite of suites) assert.ok(pkg.files.includes(suite), `files 漏了 ${suite}`)
})

test('LICENSE 与 package.json 的 license 字段一致', () => {
  assert.equal(pkg.license, 'MIT')
  assert.match(readFileSync(join(HERE, 'LICENSE'), 'utf8'), /MIT License/)
})

test('宿主/安装包探针环境只取 PATH，父环境中的凭据、代理和加载钩子不继承', () => {
  const parent = { PATH: process.env.PATH, HOME: '/unrelated-home', DSH_HOME: '/unrelated-dsh',
    OPENAI_API_KEY: 'synthetic-key', DEEPSEEK_API_KEY: 'synthetic-key', AWS_ACCESS_KEY_ID: 'synthetic-key',
    HTTP_PROXY: 'http://invalid', NODE_OPTIONS: '--require=/missing-hook', ELECTRON_RUN_AS_NODE:'0',
    NPM_CONFIG_USERCONFIG:'/unrelated-npmrc', UNRECOGNIZED_PROVIDER_SECRET:'synthetic-key' }
  const env = probeEnvironment('/isolated-probe', parent)
  assert.deepEqual(Object.keys(env).sort(), ['PATH','HOME','USERPROFILE','DSH_HOME','TMPDIR','TMP','TEMP','ELECTRON_RUN_AS_NODE','NO_COLOR'].sort())
  assert.equal(env.PATH,parent.PATH);assert.equal(env.HOME,'/isolated-probe/home')
  assert.equal(env.ELECTRON_RUN_AS_NODE,'1');assert.equal(parent.ELECTRON_RUN_AS_NODE,'0')
})

test('真实探针子进程看不到合成凭据或 NODE_OPTIONS，home/tmp 均定位到私有根', () => {
  const root=mkdtempSync(join(tmpdir(),'dsh-probe-env-'))
  try {
    const env=probeEnvironment(root,{...process.env,OPENAI_API_KEY:'synthetic-key',HTTP_PROXY:'http://invalid',NODE_OPTIONS:'--require=/missing-hook',UNRECOGNIZED_PROVIDER_SECRET:'synthetic-key'})
    mkdirSync(env.HOME);mkdirSync(env.TMPDIR)
    const child=spawnSync(process.execPath,['--input-type=module','-e',`console.log(JSON.stringify({keys:Object.keys(process.env),home:process.env.HOME,tmp:process.env.TMPDIR}))`],{env,encoding:'utf8',timeout:5000})
    assert.equal(child.status,0,child.stderr);const seen=JSON.parse(child.stdout)
    for(const key of ['OPENAI_API_KEY','HTTP_PROXY','NODE_OPTIONS','UNRECOGNIZED_PROVIDER_SECRET'])assert.equal(seen.keys.includes(key),false)
    assert.equal(seen.home,env.HOME);assert.equal(seen.tmp,env.TMPDIR)
    assert.doesNotMatch(child.stdout,/synthetic-key/)
  } finally {rmSync(root,{recursive:true,force:true})}
})

// This executes from both the source tree and the extracted npm archive.
test('随包示例执行真实处理器，保留来源并隔离不同项目（非真实模型验收）', () => {
  const child = spawnSync(process.execPath, [join(HERE, 'scripts/demo-source-recall.mjs'), '--json'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(child.status, 0, child.stderr)
  const receipt = JSON.parse(child.stdout)
  assert.equal(receipt.kind, 'synthetic-scripted-host-mechanics')
  assert.equal(receipt.realDshHost, false)
  assert.equal(receipt.realModel, false)
  assert.equal(receipt.networkRequests, 0)
  assert.equal(receipt.isolatedTemporaryHome, true)
  assert.equal(receipt.separateProcesses, 3)
  assert.equal(receipt.phases.write.result.status, 'recorded')
  assert.equal(receipt.phases.recall.current.hits.length, 1)
  assert.equal(receipt.phases.recall.history.hits.length, 1)
  assert.equal(receipt.phases['other-project'].current.hits.length, 0)
  assert.equal(receipt.phases['other-project'].history.hits.length, 0)
})
