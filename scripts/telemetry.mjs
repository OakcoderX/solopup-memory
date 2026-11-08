#!/usr/bin/env node
/**
 * L3 长期观测：把账本原料汇成“管道是否在产出”的指标。只读，不调用模型。
 *
 *   node scripts/telemetry.mjs            # 人类可读
 *   node scripts/telemetry.mjs --json     # 机器可读
 *   node scripts/telemetry.mjs --check    # 有 error 级告警时退出码 1
 *
 * 这些指标是“做梦”调度的输入：没有变更、没有产出、待审积压时，不该启动整理。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const { candidateSnapshot } = await import(join(HERE, '..', 'candidates.mjs'))

const DAY = 86_400_000

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function indexEntryCount(dir) {
  const text = readText(join(dir, 'MEMORY.md')) ?? ''
  return text.split(/\r?\n/).filter((line) => line.trim().startsWith('- [')).length
}

function snapshot(dir, scope) {
  try {
    return candidateSnapshot(dir, scope)
  } catch {
    return undefined
  }
}

function pendingStats(snapshot, now) {
  const pending = (snapshot?.records ?? []).filter((record) => record.status === 'pending')
  let oldest = null
  for (const record of pending) {
    const stamp = Date.parse(record.createdAt ?? '')
    if (Number.isFinite(stamp) && (oldest === null || stamp < oldest)) oldest = stamp
  }
  return { count: pending.length, oldestDays: oldest === null ? null : Math.floor((now - oldest) / DAY) }
}

export function collect(root, now = Date.now()) {
  const stores = []
  const globalSnapshot = snapshot(root, 'global')
  stores.push({ scope: 'global', dir: root, indexLines: indexEntryCount(root), ...pendingStats(globalSnapshot, now) })
  let projectNames = []
  try {
    projectNames = readdirSync(join(root, 'projects'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    projectNames = []
  }
  for (const name of projectNames) {
    const dir = join(root, 'projects', name)
    const snap = snapshot(dir, 'project')
    stores.push({ scope: 'project', name, dir, indexLines: indexEntryCount(dir), ...pendingStats(snap, now) })
  }

  // 审计账本：只看 capture 与 write，不推断“没记 = 没发生”。
  const auditText = readText(join(root, '.audit.jsonl')) ?? ''
  const events = []
  for (const line of auditText.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 坏行不算 */
    }
  }
  const captures = events.filter((event) => event.op === 'capture')
  const skipping = captures.filter((event) => event.reason === 'short-session-below-threshold')
  const byOutcome = (outcome) => captures.filter((event) => event.outcome === outcome).length
  const lastCaptureAt = captures.map((event) => Date.parse(event.at ?? '')).filter(Number.isFinite).sort().at(-1) ?? null
  const inserts = captures.filter((event) => Number(event.inserted) > 0 && Number.isFinite(Date.parse(event.at ?? '')))
  const lastInsertAt = inserts.map((event) => Date.parse(event.at)).sort().at(-1) ?? null

  const jobState = readJson(join(root, '.capture-jobs.json'))
  const jobs = Array.isArray(jobState?.jobs) ? jobState.jobs : []
  const jobByStatus = {}
  for (const job of jobs) jobByStatus[job.status] = (jobByStatus[job.status] ?? 0) + 1
  const lastJobAt = jobs.map((job) => Number(job.updatedAt ?? job.at)).filter(Number.isFinite).sort().at(-1) ?? null

  const state = readJson(join(root, '.capture-state.json'))
  const candidates = (globalSnapshot?.records ?? [])
  const lastRecordAt = candidates.map((record) => Date.parse(record.createdAt ?? '')).filter(Number.isFinite).sort().at(-1) ?? null
  const lastOutputAt = Math.max(lastInsertAt ?? 0, lastRecordAt ?? 0) || null
  const zeroOutputDays = lastOutputAt === null ? null : Math.floor((now - lastOutputAt) / DAY)

  const warnings = []
  if (captures.length >= 5) {
    const success = byOutcome('ok') / captures.length
    if (success < 0.5) warnings.push({ id: 'T1-low-capture-success', severity: 'warning', message: `捕获成功率 ${(success * 100).toFixed(1)}%（${byOutcome('ok')}/${captures.length}）` })
  }
  if (zeroOutputDays !== null && zeroOutputDays >= 3) {
    warnings.push({ id: 'T2-zero-output', severity: zeroOutputDays >= 7 ? 'error' : 'warning', message: `已 ${zeroOutputDays} 天没有新记忆入库` })
  }
  if (skipping.length >= 3) {
    warnings.push({ id: 'T3-short-sessions', severity: 'warning', message: `${skipping.length} 次捕获因会话过短被跳过（每 ${state?.everyTurns ?? 4} 轮才触发）` })
  }
  for (const store of stores) {
    if (store.scope === 'project' && store.oldestDays !== null && store.oldestDays >= 7) {
      warnings.push({ id: 'T4-pending-stale', severity: 'warning', message: `待审候选已挂 ${store.oldestDays} 天（${store.name}）` })
    }
  }
  if (stores.every((store) => store.indexLines === 0)) {
    warnings.push({ id: 'T5-no-memory', severity: 'info', message: '所有库都没有索引条目' })
  }

  return {
    root,
    generatedAt: new Date(now).toISOString(),
    stores,
    capture: {
      total: captures.length,
      ok: byOutcome('ok'),
      error: byOutcome('error'),
      rejected: byOutcome('rejected'),
      partial: byOutcome('partial'),
      skipped: skipping.length,
      successRate: captures.length === 0 ? null : byOutcome('ok') / captures.length,
      lastAt: lastCaptureAt === null ? null : new Date(lastCaptureAt).toISOString(),
    },
    jobs: { total: jobs.length, byStatus: jobByStatus, lastAt: lastJobAt === null ? null : new Date(lastJobAt).toISOString() },
    output: {
      lastInsertAt: lastInsertAt === null ? null : new Date(lastInsertAt).toISOString(),
      lastRecordAt: lastRecordAt === null ? null : new Date(lastRecordAt).toISOString(),
      zeroOutputDays,
      captureState: state === undefined ? null : { at: state.at ?? null, turns: state.turns ?? null, everyTurns: state.everyTurns ?? null, running: state.running === true },
    },
    warnings,
  }
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(option('--root') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory'))
  if (!existsSync(root)) {
    console.error(`[telemetry] 记忆根不存在：${root}`)
    process.exit(2)
  }
  const report = collect(root)
  if (flag('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else {
    const pct = (value) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)
    const lines = [
      `SoloPup 长期观测 · ${report.generatedAt}`,
      `根目录：${report.root}`,
      `捕获：${report.capture.total} 次（ok ${report.capture.ok}、error ${report.capture.error}、rejected ${report.capture.rejected}、partial ${report.capture.partial}、跳过短会话 ${report.capture.skipped}），成功率 ${pct(report.capture.successRate)}`,
      `作业：${report.jobs.total} 个（${Object.entries(report.jobs.byStatus).map(([status, count]) => `${status} ${count}`).join('、') || '无'}）`,
      `最后一次入库：${report.output.lastInsertAt ?? '从未'}；零产出 ${report.output.zeroOutputDays ?? '—'} 天`,
    ]
    for (const store of report.stores) {
      const label = store.scope === 'global' ? 'global' : `project ${store.name}`
      lines.push(`库 ${label}：索引 ${store.indexLines} 条；待审 ${store.count}（最老 ${store.oldestDays ?? '—'} 天）`)
    }
    for (const warning of report.warnings) lines.push(`   [${warning.severity}] ${warning.id} ${warning.message}`)
    process.stdout.write(lines.join('\n') + '\n')
  }
  if (flag('--check') && report.warnings.some((warning) => warning.severity === 'error')) process.exit(1)
}
