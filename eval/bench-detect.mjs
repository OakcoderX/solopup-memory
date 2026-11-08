#!/usr/bin/env node
/**
 * 对比实验：L0 检测器 vs 人工审计基线 + 各门禁环节的耗时。
 *
 * 基线来自 2026-11-08 的人工只读审计（data-audit 报告）。每一条都标了归属层：
 *   detect = 应由 L0 检测器抓到；blind-spot = 已知 L0 抓不到（语义/跨措辞）；
 *   telemetry = 属于 L3；doc = 文档/引用一致性；accepted = 设计上允许。
 *
 *   node eval/bench-detect.mjs            # 人类可读
 *   node eval/bench-detect.mjs --json     # 机器可读
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { collect as collectTelemetry } from '../scripts/telemetry.mjs'
import { detectRoot, detectStore } from '../detect.mjs'

const ROOT = process.env.SOLOPUP_MEMORY_ROOT ?? process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`
const MEMORY_ROOT = ROOT.endsWith('memory') ? ROOT : `${ROOT}/memory`

export const BASELINE = [
  { id: 'duplicate-popscriptH-store', layer: 'detect', find: (report) => report.crossFindings.some((row) => row.id === 'X2-duplicate-store') },
  { id: 'fixture-stores-duplicated', layer: 'accepted', find: () => false },
  { id: 'empty-project-stores', layer: 'detect', find: (report) => report.crossFindings.some((row) => row.id === 'X1-empty-project-store') },
  { id: 'stale-version-v0.2.0', layer: 'detect', find: (report) => report.stores.some((store) => store.findings.some((row) => row.id === 'I10-version-mention')) },
  { id: 'truncated-paragraph-user-md', layer: 'detect', find: (report) => report.stores.some((store) => store.findings.some((row) => row.id === 'I14-truncated-paragraph' && row.refs?.[0]?.file === 'user.md')) },
  { id: 'orphan-heading-without-index', layer: 'detect', find: (report) => report.stores.some((store) => store.findings.some((row) => row.id === 'I15-heading-without-index')) },
  { id: 'private-plaintext-exposure', layer: 'detect', find: (report) => report.stores.some((store) => store.findings.some((row) => row.id === 'I11-private-records')) },
  { id: 'numeric-contradiction-5/5-vs-6/6', layer: 'blind-spot', find: () => false },
  { id: 'rule-conflict-100-vs-200-lines', layer: 'blind-spot', find: () => false },
  { id: 'pending-candidate-8-days', layer: 'telemetry', find: () => false },
  { id: 'state-field-lastCaptureAt-missing', layer: 'doc', find: () => false },
  { id: 'index-summary-without-detail', layer: 'accepted', find: () => false },
]

function bench(fn, rounds = 20) {
  const times = []
  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now()
    fn()
    times.push(performance.now() - started)
  }
  times.sort((left, right) => left - right)
  return { medianMs: Number(times[Math.floor(times.length / 2)].toFixed(2)), minMs: Number(times[0].toFixed(2)), maxMs: Number(times.at(-1).toFixed(2)) }
}

function syntheticStore(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-scale-'))
  const lines = ['# 索引', '', '## project', '']
  for (let index = 0; index < entries; index += 1) lines.push(`- [project] 规模测试条目 ${index} 编号 ${index} — project.md`)
  writeFileSync(join(dir, 'MEMORY.md'), lines.join('\n') + '\n')
  writeFileSync(join(dir, 'project.md'), '# project\n')
  return dir
}

export function run() {
  const report = detectRoot(MEMORY_ROOT)
  const findings = report.stores.flatMap((store) => store.findings.map((row) => ({ store: store.scope, ...row })))
  const rows = BASELINE.map((item) => ({ id: item.id, layer: item.layer, detected: item.find(report) }))
  const detectable = rows.filter((row) => row.layer === 'detect')
  const detected = detectable.filter((row) => row.detected)
  return {
    root: MEMORY_ROOT,
    generatedAt: new Date().toISOString(),
    recall: {
      detectable: detectable.length,
      detected: detected.length,
      rate: detected.length / detectable.length,
      missed: detectable.filter((row) => !row.detected).map((row) => row.id),
    },
    blindSpots: rows.filter((row) => row.layer === 'blind-spot').map((row) => row.id),
    otherLayers: rows.filter((row) => ['telemetry', 'doc', 'accepted'].includes(row.layer)).map((row) => ({ id: row.id, layer: row.layer })),
    detector: { findings: findings.length, errors: report.summary.errors, warnings: report.summary.warnings, infos: report.summary.infos, ...bench(() => detectRoot(MEMORY_ROOT)) },
    telemetry: { ...bench(() => collectTelemetry(MEMORY_ROOT)) },
    scale: (() => {
      const rooms = { 300: syntheticStore(300), 1000: syntheticStore(1000) }
      try {
        return {
          300: { ...bench(() => detectStore(rooms[300], { scope: 'project' }), 10) },
          1000: { ...bench(() => detectStore(rooms[1000], { scope: 'project' }), 5) },
        }
      } finally {
        for (const dir of Object.values(rooms)) rmSync(dir, { recursive: true, force: true })
      }
    })(),
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const result = run()
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  else {
    const lines = [
      `对比实验 · ${result.generatedAt}`,
      `根目录：${result.root}`,
      `检测器召回（只算“应由 L0 抓”的项）：${result.recall.detected}/${result.recall.detectable} = ${(result.recall.rate * 100).toFixed(0)}%${result.recall.missed.length ? '；漏：' + result.recall.missed.join('、') : ''}`,
      `已知盲区（不冒充已覆盖）：${result.blindSpots.join('、') || '无'}`,
      `其他层：${result.otherLayers.map((row) => `${row.id}[${row.layer}]`).join('、') || '无'}`,
      `L0 检测耗时（20 次）：中位 ${result.detector.medianMs}ms，范围 ${result.detector.minMs}–${result.detector.maxMs}ms；存储级 findings ${result.detector.findings} 条（error ${result.detector.errors} / warning ${result.detector.warnings} / info ${result.detector.infos}）`,
      `L3 遥测耗时（20 次）：中位 ${result.telemetry.medianMs}ms，范围 ${result.telemetry.minMs}–${result.telemetry.maxMs}ms`,
      `规模对照：300 行索引中位 ${result.scale[300].medianMs}ms；1000 行中位 ${result.scale[1000].medianMs}ms（相似度对上限 400）`,
    ]
    process.stdout.write(lines.join('\n') + '\n')
  }
}
