/**
 * 安装/卸载脚本。跑法：node --test ~/.dsh/plugins/memory/test/test-patch.mjs
 *
 * 这类脚本最容易在"用户的文件"上出事：删多了、重复插、覆盖掉别人的配置。
 * 所以测试重点不是"能不能装上"，而是"只动自己那几行"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, copyFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { run } from '../scripts/patch.mjs'

const OTHER = `# 用户自己的配置
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- insert:
    - id: mcp-godot
      name: "@deepseek-ai/dsh-mcp-client"
`

function sandbox(patch = OTHER) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mem-patch-'))
  const profile = join(root, 'profile')
  mkdirSync(profile, { recursive: true })
  const file = join(profile, 'cordis.patch.yml')
  writeFileSync(file, patch, 'utf8')
  return {
    root,
    profile,
    file,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('插件路径不存在时拒绝安装，且不改动文件', () => {
  const box = sandbox()
  try {
    const before = readFileSync(box.file, 'utf8')
    assert.throws(
      () => run(['install', '--profile', box.profile, '--plugin', '/tmp/does-not-exist/index.mjs']),
      /插件文件不存在/,
    )
    assert.equal(readFileSync(box.file, 'utf8'), before)
    assert.equal(readdirSync(box.profile).filter((n) => n.includes('.bak-')).length, 0)
  } finally {
    box.cleanup()
  }
})

test('安装：真实路径下写入块，且原有条目一行不少', () => {
  const box = sandbox()
  try {
    const plugin = fileURLToPath(new URL('../index.mjs', import.meta.url))
    const result = run(['install', '--profile', box.profile, '--plugin', plugin])
    assert.equal(result.changed, true)

    const text = readFileSync(box.file, 'utf8')
    for (const line of OTHER.split('\n')) {
      if (line.trim().length === 0) continue
      assert.ok(text.includes(line), `丢了用户配置：${line}`)
    }
    assert.match(text, /# >>> dsh-memory/)
    assert.match(text, /- id: memory/)
    assert.match(text, /file:\/\/.*index\.mjs/)
    const backups = readdirSync(box.profile).filter((name) => name.includes('.bak-dsh-memory-'))
    assert.equal(backups.length, 1, '应留一份备份')
  } finally {
    box.cleanup()
  }
})

test('幂等：装两次不产生第二个块', () => {
  const box = sandbox()
  try {
    const plugin = fileURLToPath(new URL('../index.mjs', import.meta.url))
    run(['install', '--profile', box.profile, '--plugin', plugin])
    const first = readFileSync(box.file, 'utf8')

    const second = run(['install', '--profile', box.profile, '--plugin', plugin])
    assert.equal(second.changed, false)
    assert.equal(readFileSync(box.file, 'utf8'), first)
    assert.equal((first.match(/# >>> dsh-memory/g) ?? []).length, 1)
  } finally {
    box.cleanup()
  }
})

test('卸载：只删自己的块，用户配置逐字保留', () => {
  const box = sandbox()
  try {
    const plugin = fileURLToPath(new URL('../index.mjs', import.meta.url))
    run(['install', '--profile', box.profile, '--plugin', plugin])
    const result = run(['uninstall', '--profile', box.profile])
    assert.equal(result.changed, true)

    const after = readFileSync(box.file, 'utf8')
    assert.doesNotMatch(after, /dsh-memory/)
    // 用户原始内容完整回来（允许尾部空行差异）
    assert.equal(after.trimEnd(), OTHER.trimEnd())
  } finally {
    box.cleanup()
  }
})

test('卸载：没装过时不动文件', () => {
  const box = sandbox()
  try {
    const before = readFileSync(box.file, 'utf8')
    const result = run(['uninstall', '--profile', box.profile])
    assert.equal(result.changed, false)
    assert.equal(readFileSync(box.file, 'utf8'), before)
  } finally {
    box.cleanup()
  }
})

test('dry-run 不落盘', () => {
  const box = sandbox()
  try {
    const plugin = fileURLToPath(new URL('../index.mjs', import.meta.url))
    const before = readFileSync(box.file, 'utf8')
    const result = run(['install', '--profile', box.profile, '--plugin', plugin, '--dry-run'])
    assert.equal(result.dryRun, true)
    assert.equal(readFileSync(box.file, 'utf8'), before)
    assert.equal(readdirSync(box.profile).filter((n) => n.includes('.bak-')).length, 0)
  } finally {
    box.cleanup()
  }
})

test('标记不成对时拒绝操作（不猜）', () => {
  const box = sandbox(`${OTHER}# >>> dsh-memory\n- insert:\n`)
  try {
    assert.throws(() => run(['install', '--profile', box.profile, '--plugin', fileURLToPath(new URL('../index.mjs', import.meta.url))]), /标记不成对/)
    assert.throws(() => run(['uninstall', '--profile', box.profile]), /标记不成对/)
  } finally {
    box.cleanup()
  }
})

test('缺少 --profile 时报错而不是猜默认值', () => {
  assert.throws(() => run(['install', '--plugin', '/tmp/x']), /缺少 --profile/)
})

test('已有未托管的 memory 条目时拒绝安装（不制造副本）', () => {
  const manual = `${OTHER}- insert:
    - id: memory
      name: "file:///somewhere/index.mjs"
`
  const box = sandbox(manual)
  try {
    const before = readFileSync(box.file, 'utf8')
    assert.throws(
      () => run(['install', '--profile', box.profile, '--plugin', fileURLToPath(new URL('../index.mjs', import.meta.url))]),
      /未托管的 memory 条目/,
    )
    assert.equal(readFileSync(box.file, 'utf8'), before, '拒绝时不应改动文件')
  } finally {
    box.cleanup()
  }
})

test('全新空列表配置可安装，卸载逐字恢复注释与空白', () => {
  const original = '# clean profile\n  [] # intentional empty\n\n'
  const box = sandbox(original)
  try {
    run(['install', '--profile', box.profile, '--plugin', fileURLToPath(new URL('../index.mjs', import.meta.url))])
    const installed = readFileSync(box.file, 'utf8')
    assert.doesNotMatch(installed, /^\s*\[\]/m)
    assert.match(installed, /^- insert:/m)
    run(['uninstall', '--profile', box.profile])
    assert.equal(readFileSync(box.file, 'utf8'), original)
  } finally { box.cleanup() }
})

test('恢复空列表时保留托管块以外的新注释，损坏恢复标记则拒绝', () => {
  const box = sandbox('[]\n')
  try {
    run(['install', '--profile', box.profile, '--plugin', fileURLToPath(new URL('../index.mjs', import.meta.url))])
    const installed = readFileSync(box.file, 'utf8')
    writeFileSync(box.file, '# newer outside comment\n' + installed)
    run(['uninstall', '--profile', box.profile])
    assert.equal(readFileSync(box.file, 'utf8'), '# newer outside comment\n[]\n')
    writeFileSync(box.file, installed.replace(/# dsh-memory-original-empty:[^\n]+/, '# dsh-memory-original-empty:aW52YWxpZA=='))
    const broken = readFileSync(box.file, 'utf8')
    assert.throws(() => run(['uninstall', '--profile', box.profile]), /恢复标记损坏/)
    assert.equal(readFileSync(box.file, 'utf8'), broken)
  } finally { box.cleanup() }
})

test('插件路径中的空格、中文与井号使用有效 file URL', () => {
  const box = sandbox()
  try {
    const plugin = join(box.root, '含 空格#?.mjs'); writeFileSync(plugin, 'export const name="fixture"')
    run(['install', '--profile', box.profile, '--plugin', plugin])
    const line = readFileSync(box.file, 'utf8').split('\n').find((line) => line.trim().startsWith('name:'))
    const names = readFileSync(box.file, 'utf8').split('\n').filter((line) => line.trim().startsWith('name:'))
    const href = JSON.parse(names.at(-1).split('name:')[1].trim())
    assert.equal(fileURLToPath(href), plugin)
    assert.ok(href.includes('%23')); assert.ok(href.includes('%20')); assert.ok(line)
  } finally { box.cleanup() }
})


test('default plugin path installs correctly from a Unicode directory with spaces and URL metacharacters',()=>{
 const box=sandbox()
 try{
  const local=join(box.root,'插件 空间#'),scripts=join(local,'scripts');mkdirSync(scripts,{recursive:true});writeFileSync(join(local,'index.mjs'),'export function apply() {}\n');const file=join(scripts,'patch.mjs');copyFileSync(fileURLToPath(new URL('../scripts/patch.mjs',import.meta.url)),file)
  const result=spawnSync(process.execPath,[file,'install','--profile',box.profile],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const body=readFileSync(box.file,'utf8'),href=JSON.parse(body.split('\n').filter(line=>line.trim().startsWith('name:')).at(-1).split('name:')[1].trim());assert.equal(realpathSync(fileURLToPath(href)),realpathSync(join(local,'index.mjs')));assert.ok(href.includes('%20')&&href.includes('%23'));assert.ok(body.includes('id: mcp-godot'))
 }finally{box.cleanup()}
})
