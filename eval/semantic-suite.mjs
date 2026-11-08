#!/usr/bin/env node
/**
 * L2 语义套件的**管道保真**层（确定性，不调用模型）。
 *
 * 它回答的问题是：假设抽取器给出了正确的候选（或故意错误的候选），
 * 后续的机械闸门、写入、投影、检索会不会把它弄丢、弄错、放宽。
 *
 * 它**不回答**：真实模型会不会抽出正确候选。那需要 --live 主机适配器，
 * 目前只能在真实 DSH 宿主里录一次基线再回放；不得把本套件通过写成语义验收通过。
 *
 *   node eval/semantic-suite.mjs            # 人类可读
 *   node eval/semantic-suite.mjs --json     # 机器可读
 *   node eval/semantic-suite.mjs --verbose  # 逐例输出
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { assessCandidate } from '../capture-evidence.mjs'
import { normalizeMeaning } from '../meaning.mjs'
import { normalizeText } from '../security.mjs'
import { candidateSnapshot } from '../candidates.mjs'
import { indexLine, searchStore, writeMemory } from '../index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CASES = JSON.parse(readFileSync(join(HERE, 'semantic', 'cases.json'), 'utf8'))
const hash = (text) => createHash('sha256').update(text).digest('hex')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function runCase(testCase, room) {
  const dir = join(room, testCase.gold.scope === 'project' ? 'project' : 'global')
  mkdirSync(dir, { recursive: true })

  for (const setup of testCase.setup ?? []) {
    writeMemory({ type: setup.type, dir, line: setup.line })
  }

  const messages = testCase.messages.map((message) => {
    const text = normalizeText(message.text).trim()
    return { id: message.id, role: message.role ?? 'user', text, hash: hash(text) }
  })
  const evidence = testCase.gold.evidence ?? [{ messageId: messages[0].id, quote: messages[0].text.slice(0, Math.min(60, messages[0].text.length)) }]
  const candidate = { ...testCase.gold, evidence }
  const expect = testCase.expect ?? {}
  const hasProject = candidate.scope === 'project'
  const assessment = assessCandidate(candidate, messages, hasProject)

  if (expect.status !== 'eligible') {
    assert(assessment.status === expect.status, `期望 ${expect.status}，实际 ${assessment.status}`)
    if (expect.reason !== undefined) assert(assessment.reason === expect.reason, `期望原因 ${expect.reason}，实际 ${assessment.reason}`)
    assert(assessment.status !== 'eligible', '非 eligible 的用例不应该被写入')
    return { assertions: 1 }
  }

  assert(assessment.status === 'eligible', `期望 eligible，实际 ${assessment.status}${assessment.reason ? `（${assessment.reason}）` : ''}`)
  const detail = typeof candidate.detail === 'string' && candidate.detail.trim().length > 0 ? candidate.detail : undefined
  const line = indexLine(candidate.type, candidate.summary, candidate.expires, detail !== undefined)
  const written = writeMemory({
    type: candidate.type,
    dir,
    line,
    summary: candidate.summary,
    scope: candidate.scope,
    detail,
    meaning: candidate.meaning,
    expires: candidate.expires,
    supersedes: testCase.supersedes,
    provenance: { basis: 'tool-context', sessionId: `semantic-suite:${testCase.id}`, callHash: hash(testCase.id), evidence: assessment.evidence },
  })
  let assertions = 1

  assert(written.indexLine === line, `写入行不一致：${written.indexLine}`)
  const indexText = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  for (const needle of expect.indexContains ?? []) assert(indexText.includes(needle), `索引缺少：${needle}`)
  for (const needle of expect.indexExcludes ?? []) assert(!indexText.includes(needle), `索引不应包含：${needle}`)
  if (expect.superseded === true) assert(written.superseded !== undefined, '期望返回被取代的旧行')
  if (expect.detailContains) {
    const topic = readFileSync(join(dir, `${candidate.type}.md`), 'utf8')
    for (const needle of expect.detailContains) assert(topic.includes(needle), `正文缺少：${needle}`)
  }
  if (expect.meaningMatches === true) {
    const snapshot = candidateSnapshot(dir, candidate.scope)
    const record = snapshot.records.find((row) => row.indexLine === written.indexLine)
    assert(record !== undefined, '账本里找不到刚写入的记录')
    assert(JSON.stringify(record.meaning) === JSON.stringify(normalizeMeaning(candidate.meaning)), '认识层/条件在写入后发生变化')
  }
  for (const probe of expect.search ?? []) {
    const hits = searchStore(dir, probe.query, {
      ...(probe.context === undefined ? {} : { context: probe.context }),
      ...(probe.task === undefined ? {} : { task: probe.task }),
    }).hits
    assert(hits.length === probe.hits, `检索「${probe.query}」期望 ${probe.hits} 条，实际 ${hits.length} 条`)
    assertions += 1
  }
  return { assertions }
}

export function runSuite(cases = CASES) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-semantic-suite-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const results = []
  const startedAt = Date.now()
  try {
    for (const testCase of cases) {
      const room = join(root, testCase.id)
      mkdirSync(room, { recursive: true })
      const begin = Date.now()
      try {
        const outcome = runCase(testCase, room)
        results.push({ id: testCase.id, tags: testCase.tags ?? [], ok: true, assertions: outcome.assertions, ms: Date.now() - begin })
      } catch (error) {
        results.push({ id: testCase.id, tags: testCase.tags ?? [], ok: false, error: error.message, ms: Date.now() - begin })
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(root, { recursive: true, force: true })
  }
  const failed = results.filter((row) => !row.ok)
  return {
    kind: 'semantic-pipeline',
    mode: 'pipeline',
    semanticTruthEvaluated: false,
    cases: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    assertions: results.reduce((sum, row) => sum + (row.assertions ?? 0), 0),
    ms: Date.now() - startedAt,
    results,
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const report = runSuite()
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else {
    const lines = [
      `L2 语义套件（管道保真层）· ${report.cases} 例 · 通过 ${report.passed} · 失败 ${report.failed} · ${report.assertions} 项断言 · ${report.ms}ms`,
      '说明：通过只表示“管道不会弄丢/弄错已给出的候选”，不表示真实模型的抽取质量。',
    ]
    for (const row of report.results) {
      if (!row.ok || argv.includes('--verbose')) lines.push(`  ${row.ok ? '✔' : '✖'} ${row.id}${row.ok ? `（${row.assertions} 项）` : `：${row.error}`}`)
    }
    process.stdout.write(lines.join('\n') + '\n')
  }
  if (report.failed > 0) process.exit(1)
}
