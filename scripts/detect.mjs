#!/usr/bin/env node
/**
 * 记忆层检测 CLI（L0 不变量层）。只读，不调用模型。
 *
 *   node scripts/detect.mjs                 # 检查 ~/.dsh/memory
 *   node scripts/detect.mjs --root DIR      # 指定记忆根
 *   node scripts/detect.mjs --json          # 机器可读
 *   node scripts/detect.mjs --check         # 有 error 则退出码 1（CI 门禁）
 *   node scripts/detect.mjs --verbose       # 连 info 一起打印
 */

import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { detectRoot } from '../detect.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

const root = resolve(option('--root') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory'))
if (!existsSync(root)) {
  console.error(`[detect] 记忆根不存在：${root}`)
  process.exit(2)
}

const report = detectRoot(root)
if (flag('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} else {
  const lines = []
  lines.push(`SoloPup 记忆检测 v${report.version} · ${report.generatedAt}`)
  lines.push(`根目录：${report.root}`)
  lines.push(`总计：error ${report.summary.errors} · warning ${report.summary.warnings} · info ${report.summary.infos}`)
  for (const store of report.stores) {
    const label = store.scope === 'global' ? 'global' : 'project'
    const metrics = store.metrics
    lines.push('')
    lines.push(`== ${label}：${store.dir}`)
    if (metrics) {
      lines.push(
        `   索引 ${metrics.indexLines}/${metrics.limitLines} 行、${metrics.indexBytes}/${metrics.limitBytes} 字节；` +
          `有效记录 ${metrics.activeRecords}、待审 ${metrics.pendingRecords}、过期行 ${metrics.expiredIndexLines}；` +
          `库占用 ${(metrics.storeBytes / 1024).toFixed(1)}K/${metrics.storeLimitBytes / 1024}K`,
      )
    }
    if (store.findings.length === 0) {
      lines.push('   [ok] 未发现问题（“未发现”不等于“没有问题”，语义质量见 L2）')
      continue
    }
    for (const finding of store.findings) {
      if (finding.severity === 'info' && !flag('--verbose')) continue
      const refs = (finding.refs ?? []).map((item) => (item.line === undefined ? item.file : `${item.file}:${item.line}`)).join(' ')
      lines.push(`   [${finding.severity}] ${finding.id} ${finding.message}${refs ? ` (${refs})` : ''}`)
      if (finding.fixHint && flag('--verbose')) lines.push(`          修复：${finding.fixHint}`)
    }
  }
  for (const finding of report.crossFindings) {
    if (finding.severity === 'info' && !flag('--verbose')) continue
    lines.push(`   [${finding.severity}] ${finding.id} ${finding.message}`)
  }
  process.stdout.write(lines.join('\n') + '\n')
}

if (flag('--check') && report.summary.errors > 0) process.exit(1)
