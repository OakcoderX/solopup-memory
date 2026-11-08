#!/usr/bin/env node
/**
 * 做梦 P0：只读的 op 计划生成器（影子报告）。
 *
 * 它读 L0 检测 findings 与 L3 遥测，把“该整理什么”写成可审计的 op 列表，
 * **不写任何文件、不调用模型、不 apply**。真正的应用在 P1 之后，必须人工确认。
 *
 *   node scripts/dream.mjs                # 人类可读
 *   node scripts/dream.mjs --json         # 机器可读
 *   node scripts/dream.mjs --check        # 有 high 风险 op 时退出码 1
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { detectRoot, detectStore } from '../detect.mjs'
import { pruneStore } from '../index.mjs'
import { collect as collectTelemetry } from './telemetry.mjs'

const KIND_BY_FINDING = {
  'I3-record-missing-from-index': { kind: 'align-projection', risk: 'auto', why: '账本有效记录没有投影到索引' },
  'I3-detail-topic-missing': { kind: 'align-projection', risk: 'auto', why: '记录正文文件缺失' },
  'I3-detail-mismatch': { kind: 'align-projection', risk: 'auto', why: '正文与账本不一致' },
  'I2-missing-topic-file': { kind: 'repair-reference', risk: 'auto', why: '索引指向不存在的主题文件' },
  'I2-missing-anchor': { kind: 'repair-reference', risk: 'auto', why: '索引锚点在主题文件里找不到' },
  'I5-withdrawal-residue': { kind: 'republish-withdrawal', risk: 'auto', why: '撤回没有传播到索引' },
  'I6-duplicate-line': { kind: 'merge-duplicate', risk: 'human', why: '完全重复的索引行' },
  'I6-near-duplicate': { kind: 'merge-duplicate', risk: 'human', why: '相似度 ≥0.9 的近重复' },
  'I7-conflict': { kind: 'arbitrate-conflict', risk: 'human', why: '同一属性并存多个取值' },
  'I8-budget-lines': { kind: 'compact-index', risk: 'auto', why: '索引行数超限' },
  'I8-budget-bytes': { kind: 'compact-index', risk: 'auto', why: '索引字节超限' },
  'I8-budget-store': { kind: 'compact-index', risk: 'auto', why: '库占用超限' },
  'I10-version-mention': { kind: 'review-stale', risk: 'human', why: '记忆提到与当前版本不同的版本号' },
  'I14-truncated-paragraph': { kind: 'repair-topic-truncation', risk: 'human', why: '主题段落像被截断' },
  'I15-heading-without-index': { kind: 'link-heading', risk: 'auto', why: '标题没有索引指向' },
}

function opId(store, kind, evidence) {
  return createHash('sha256').update(`${store}|${kind}|${evidence.join(',')}`).digest('hex').slice(0, 12)
}

export function planDream(root) {
  const detection = detectRoot(root)
  const telemetry = collectTelemetry(root)
  const ops = []
  for (const store of detection.stores) {
    const storeName = store.dir === root ? 'global' : store.dir
    for (const finding of store.findings) {
      const mapping = KIND_BY_FINDING[finding.id]
      if (mapping === undefined) continue
      const evidence = [`${store.scope}:${finding.id}`, ...(finding.refs ?? []).map((ref) => `${ref.file}${ref.line === undefined ? '' : ':' + ref.line}`)]
      ops.push({
        opId: opId(storeName, mapping.kind, evidence),
        kind: mapping.kind,
        risk: mapping.risk,
        store: storeName,
        why: mapping.why,
        evidence,
      })
    }
  }
  for (const finding of detection.crossFindings) {
    if (finding.id !== 'X2-duplicate-store') continue
    ops.push({
      opId: opId('root', 'dedupe-store', [finding.message]),
      kind: 'dedupe-store',
      risk: 'human',
      store: 'root',
      why: '内容完全相同的库（遗留副本）',
      evidence: [finding.id, finding.message],
    })
  }
  for (const warning of telemetry.warnings) {
    if (!['T1-low-capture-success', 'T2-zero-output', 'T3-short-sessions'].includes(warning.id)) continue
    ops.push({
      opId: opId('root', 'inspect-capture', [warning.id]),
      kind: 'inspect-capture',
      risk: 'human',
      store: 'root',
      why: warning.message,
      evidence: [warning.id],
    })
  }
  const summary = {
    total: ops.length,
    auto: ops.filter((op) => op.risk === 'auto').length,
    human: ops.filter((op) => op.risk === 'human').length,
    byKind: Object.fromEntries([...new Set(ops.map((op) => op.kind))].sort().map((kind) => [kind, ops.filter((op) => op.kind === kind).length])),
  }
  return {
    kind: 'dream-plan',
    phase: 'P0-shadow',
    readOnly: true,
    applySupported: false,
    modelCalls: 0,
    generatedAt: new Date().toISOString(),
    root,
    summary,
    ops,
    detectionSummary: detection.summary,
    telemetrySummary: { capture: telemetry.capture, output: telemetry.output, warnings: telemetry.warnings.length },
  }
}

/** P1 只自动执行确定性与可回滚的整理；其余 op 明确留给人工。 */
const AUTO_KINDS = new Set(['compact-index'])

export function planHash(plan) {
  return createHash('sha256')
    .update(JSON.stringify({ root: plan.root, ops: plan.ops.map((op) => ({ opId: op.opId, kind: op.kind, store: op.store, evidence: op.evidence })) }))
    .digest('hex')
}

function storeDir(root, store) {
  return store === 'global' ? root : store
}

function backupStore(root, dir, stamp) {
  const target = join(root, '.dream', 'backups', stamp, dir === root ? 'global' : dir.slice(dir.lastIndexOf('/') + 1))
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    copyFileSync(join(dir, entry.name), join(target, entry.name))
  }
  return target
}

export function applyDream(plan, reviewed) {
  if (reviewed !== planHash(plan)) throw new Error('dream-review-hash-mismatch')
  const applyOps = plan.ops.filter((op) => AUTO_KINDS.has(op.kind))
  const skipped = plan.ops.filter((op) => !AUTO_KINDS.has(op.kind)).map((op) => ({ opId: op.opId, kind: op.kind, reason: 'needs-human' }))
  if (applyOps.length === 0) return { applied: 0, skipped, results: [], backup: null }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dirs = [...new Set(applyOps.map((op) => storeDir(plan.root, op.store)))]
  const before = dirs.map((dir) => detectStore(dir, { scope: dir === plan.root ? 'global' : 'project' }))
  const backup = {}
  for (const dir of dirs) backup[dir] = backupStore(plan.root, dir, stamp)
  const results = []
  for (const dir of dirs) {
    const result = pruneStore(dir, { apply: true })
    results.push({ dir, before: result.before, after: result.after, removed: result.removed, archived: result.archived })
  }
  const verification = dirs.map((dir, index) => {
    const after = detectStore(dir, { scope: dir === plan.root ? 'global' : 'project' })
    return { dir, errorsBefore: before[index].summary.errors, errorsAfter: after.summary.errors, ok: after.summary.errors <= before[index].summary.errors }
  })
  const applied = results.reduce((sum, row) => sum + (row.removed.expired + row.removed.duplicate + row.removed.overCap > 0 ? 1 : 0), 0)
  return { applied: results.length, skipped, results, backup, verification }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const option = (name) => {
    const at = argv.indexOf(name)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const root = resolve(option('--root') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory'))
  if (!existsSync(root)) {
    console.error(`[dream] 记忆根不存在：${root}`)
    process.exit(2)
  }
  const plan = planDream(root)
  if (argv.includes('--apply')) {
    const reviewed = option('--reviewed')
    if (reviewed === undefined) {
      console.error('[dream] --apply 需要 --reviewed <planHash>；先看 `--json` 输出的完整计划')
      process.exit(2)
    }
    let result
    try {
      result = applyDream(plan, reviewed)
    } catch (error) {
      console.error(`[dream] 应用失败：${error.message}`)
      process.exit(2)
    }
    if (argv.includes('--json')) process.stdout.write(JSON.stringify({ planHash: planHash(plan), ...result }, null, 2) + '\n')
    else {
      const lines = [
        `做梦 P1 应用 · ${new Date().toISOString()}`,
        `planHash：${planHash(plan)}`,
        `执行 ${result.applied} 个自动 op；跳过 ${result.skipped.length} 个（需人工）。`,
      ]
      for (const row of result.results) lines.push(`  ${row.dir}：${row.before.lines} → ${row.after.lines} 行，remove expired ${row.removed.expired} / duplicate ${row.removed.duplicate} / overCap ${row.removed.overCap}`)
      for (const row of result.verification ?? []) lines.push(`  验证 ${row.dir}：error ${row.errorsBefore} → ${row.errorsAfter} ${row.ok ? 'OK' : '恶化，请用备份回滚'}`)
      if (result.backup !== null) lines.push(`  备份：${Object.values(result.backup).join('、')}`)
      process.stdout.write(lines.join('\n') + '\n')
    }
    process.exit((result.verification ?? []).every((row) => row.ok) ? 0 : 1)
  }
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
  else {
    const lines = [
      `做梦 P0（影子报告，只读）· ${plan.generatedAt}`,
      `根目录：${plan.root}`,
      `op 总数 ${plan.summary.total}（自动可执行候选 ${plan.summary.auto}、需人工确认 ${plan.summary.human}）`,
      `分类：${Object.entries(plan.summary.byKind).map(([kind, count]) => `${kind} ${count}`).join('、') || '无'}`,
      '边界：不写文件、不调用模型；apply 未实现。',
    ]
    for (const op of plan.ops) lines.push(`  [${op.risk}] ${op.kind} · ${op.why}${op.evidence.length ? `（${op.evidence.slice(0, 3).join('；')}）` : ''}`)
    process.stdout.write(lines.join('\n') + '\n')
  }
  if (argv.includes('--check') && plan.summary.human > 0) process.exit(1)
}
