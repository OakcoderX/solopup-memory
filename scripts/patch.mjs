#!/usr/bin/env node
/**
 * 把 dsh-memory 加进 / 移出某个 profile 的 cordis.patch.yml。
 *
 *   node scripts/patch.mjs install   --profile ~/.dsh/profiles/desktop [--plugin <绝对路径>] [--dry-run]
 *   node scripts/patch.mjs uninstall --profile ~/.dsh/profiles/desktop [--dry-run]
 *
 * 设计取舍：
 *   · 用显式标记块（>>> / <<<）而不是"找到 include 再删"，卸载只删自己写的那几行；
 *   · 幂等：已经装了再装一次不改文件；
 *   · 改之前先备份，备份名带时间戳；
 *   · 不做 YAML 解析（宿主没有内置解析器，为了一个 patch 引入依赖不值得），
 *     改成结构断言：标记成对、块内只有一条 insert。
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

// 检测按**前缀**，写入用完整说明——否则用户手写的短标记会被当成"没装过"再插一遍
const BEGIN_PREFIX = '# >>> dsh-memory'
const END_PREFIX = '# <<< dsh-memory'
const BEGIN = `${BEGIN_PREFIX} (managed block, do not edit between markers)`
const END = END_PREFIX

function expand(path) {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
}

function readPatch(file) {
  if (!existsSync(file)) throw new Error(`找不到 patch 文件：${file}`)
  return readFileSync(file, 'utf8')
}

const EMPTY_ORIGINAL = '# dsh-memory-original-empty:'
function isEmptyList(text) { return text.split('\n').map((line) => line.replace(/#.*/, '')).join('\n').trim() === '[]' }

function blockLines(pluginPath, original) {
  return [
    BEGIN,
    ...(original === undefined ? [] : [`${EMPTY_ORIGINAL}${Buffer.from(original).toString('base64')}`]),
    '- insert:',
    '    - id: memory',
    // 用 JSON.stringify 生成 YAML 双引号标量：路径里有引号或反斜杠时不会把 YAML 弄坏
    `      name: ${JSON.stringify(pathToFileURL(pluginPath).href)}`,
    END,
    '',
  ]
}

function splitBlock(text) {
  const start = text.indexOf(BEGIN_PREFIX)
  const end = text.indexOf(END_PREFIX)
  if (start < 0 && end < 0) return undefined
  if (start < 0 || end < 0 || end < start) {
    throw new Error('标记不成对：请手动检查 cordis.patch.yml 里的 dsh-memory 块')
  }
  const after = text.indexOf('\n', end)
  return { start, end: after < 0 ? text.length : after + 1 }
}

function backup(file) {
  const target = `${file}.bak-dsh-memory-${Date.now()}`
  copyFileSync(file, target)
  return target
}

function install({ profile, plugin, dryRun }) {
  const file = join(expand(profile), 'cordis.patch.yml')
  const pluginPath = resolve(expand(plugin))
  if (!existsSync(pluginPath)) throw new Error(`插件文件不存在：${pluginPath}`)

  const text = readPatch(file)
  const existing = splitBlock(text)
  if (existing !== undefined) {
    return { changed: false, reason: '已经装过（找到标记块），未改动' }
  }

  // 已经手工装过的 profile：不能因为"没有标记"就再插一个副本
  if (/^\s*-\s*id:\s*memory\s*$/m.test(text)) {
    throw new Error('已存在未托管的 memory 条目（没有标记块）。请先手动删除它，或把它包进标记块再重试。')
  }

  // A standalone YAML [] cannot be followed by block sequence entries.
  // Keep its exact original bytes inside the managed block for uninstall.
  const empty = isEmptyList(text)
  const block = blockLines(pluginPath, empty ? text : undefined).join('\n')
  const next = empty ? block : text.endsWith('\n') ? text + block : `${text}\n${block}`
  if (!dryRun) {
    const saved = backup(file)
    writeFileSync(file, next, 'utf8')
    return { changed: true, backup: saved, file }
  }
  return { changed: true, dryRun: true, preview: block }
}

function uninstall({ profile, dryRun }) {
  const file = join(expand(profile), 'cordis.patch.yml')
  const text = readPatch(file)
  const range = splitBlock(text)
  if (range === undefined) return { changed: false, reason: '没有找到 dsh-memory 标记块，未改动' }

  const block = text.slice(range.start, range.end)
  const originals = block.split('\n').filter((line) => line.startsWith(EMPTY_ORIGINAL))
  let restored = ''
  if (originals.length) {
    if (originals.length !== 1) throw new Error('空配置恢复标记损坏，未改动文件')
    const encoded = originals[0].slice(EMPTY_ORIGINAL.length)
    const bytes = Buffer.from(encoded, 'base64')
    restored = bytes.toString('utf8')
    if (bytes.toString('base64') !== encoded || !isEmptyList(restored)) throw new Error('空配置恢复标记损坏，未改动文件')
  }
  const next = text.slice(0, range.start) + restored + text.slice(range.end)
  if (!dryRun) {
    const saved = backup(file)
    writeFileSync(file, next, 'utf8')
    return { changed: true, backup: saved, file }
  }
  return { changed: true, dryRun: true, removed: text.slice(range.start, range.end) }
}

/** 解析命令行。导出供测试直接调用。 */
export function run(argv) {
  const [command, ...rest] = argv
  if (command !== 'install' && command !== 'uninstall') {
    throw new Error('用法：patch.mjs install|uninstall --profile <dir> [--plugin <path>] [--dry-run]')
  }
  const options = { dryRun: rest.includes('--dry-run') }
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--profile') options.profile = rest[i + 1]
    if (rest[i] === '--plugin') options.plugin = rest[i + 1]
  }
  if (options.profile === undefined) throw new Error('缺少 --profile')
  if (command === 'install' && options.plugin === undefined) {
    options.plugin = fileURLToPath(new URL('../index.mjs', import.meta.url))
  }
  return command === 'install' ? install(options) : uninstall(options)
}

// 必须比 basename：'test-patch.mjs'.endsWith('patch.mjs') 也是 true，会把测试当 CLI 跑
if (basename(process.argv[1] ?? '') === 'patch.mjs') {
  try {
    const result = run(process.argv.slice(2))
    if (result.changed === false) console.log(`未改动：${result.reason}`)
    else if (result.dryRun === true) console.log(`将要做（dry-run）：\n${result.preview ?? result.removed}`)
    else console.log(`已更新 ${result.file}\n备份：${result.backup}`)
  } catch (error) {
    console.error(`失败：${error.message}`)
    process.exit(1)
  }
}
