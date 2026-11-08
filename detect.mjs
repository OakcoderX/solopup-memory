/**
 * 记忆层检测框架 · L0 不变量层。
 *
 * 只读：不改任何记忆数据，不调用模型。输出结构化 findings，供 CLI、测试与人工复核共用。
 * 设计原则：每一条“我们踩过的坑”都必须有一个可复现的检查项；查不出来就明说“未知”，
 * 不把“没发现”写成“没问题”。
 *
 * 分层约定（完整框架见 DETECTION.md）：
 *   L0 不变量（本文件，确定性、毫秒级）
 *   L1 管道行为（脚本模型，确定性）
 *   L2 真实语义（真模型，冻结留出集，按需）
 *   L3 长期观测（遥测：捕获成功率、零产出天数、待审年龄）
 *   L4 安全与隐私（生成式对抗集 + 隐私覆盖）
 *   L5 性能与容量
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { candidateSnapshot, withdrawalPolicy } from './candidates.mjs'
import { filterWithdrawn } from './withdrawal.mjs'
import { privateMemory } from './privacy.mjs'
import { VERSION } from './version.mjs'
import { SIMILARITY, TYPES, conflictSignature, isExpired, similarity, summaryOf } from './index.mjs'

const INDEX_LINE = /^- \[(user|feedback|project|reference)\] /
const TOPIC_REF = /\s—\s([A-Za-z0-9._-]+\.md)(?:#(.+))?$/
const SUMMARY_MAX = 200
const LIMITS = { indexMaxLines: 300, indexMaxBytes: 25 * 1024, storeMaxBytes: 2 * 1024 * 1024 }
const VERSION_TOKEN = /\bv\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/g

/** 索引里的锚点是人写的，标题是带标点的；比较前统一折叠空白与标点。 */
function foldAnchor(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\-_·、，。；：！？（）()【】\[\]《》〈〉「」『』"'“”‘’/\\|]+/g, '')
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function active(records) {
  return records.filter((record) => ['recorded', 'adopted'].includes(record.status))
}

function storeBytes(dir) {
  let total = 0
  const walk = (current, depth) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (depth === 0 && entry.name === 'projects') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          /* 读不到就不计 */
        }
      }
    }
  }
  try {
    walk(dir, 0)
  } catch {
    /* 目录不存在按 0 算 */
  }
  return total
}

function bySeverity(findings, severity) {
  return findings.filter((item) => item.severity === severity).length
}

/**
 * 检测单个库（全局库或项目库）。
 * @param {string} dir - 库目录。
 * @param {{scope?: 'global'|'project', now?: number, root?: string}} options
 */
export function detectStore(dir, options = {}) {
  const scope = options.scope ?? 'global'
  const now = options.now ?? Date.now()
  const findings = []
  const ref = (file, line) => (line === undefined ? { file } : { file, line })
  const add = (id, severity, message, refs = [], fixHint) =>
    findings.push({ id, severity, message, ...(refs.length ? { refs } : {}), ...(fixHint ? { fixHint } : {}) })

  const indexText = readText(join(dir, 'MEMORY.md'))
  const hasIndex = indexText !== undefined
  const text = indexText ?? ''
  const rawLines = text.replace(/\n$/, '').split(/\r?\n/)
  const entries = []
  rawLines.forEach((line, index) => {
    if (line.trim().startsWith('- [')) entries.push({ line: line.trim(), lineNo: index + 1, raw: line })
  })

  // I1 索引行格式：类型、摘要长度、期限语法
  for (const entry of entries) {
    if (!INDEX_LINE.test(entry.line)) {
      add('I1-invalid-index-line', 'error', '索引行类型不合法，宿主与检索都不会把它当条目', [ref('MEMORY.md', entry.lineNo)], '改成 - [user|feedback|project|reference] 摘要 — 文件')
      continue
    }
    if (summaryOf(entry.line).length > SUMMARY_MAX) {
      add('I1-summary-too-long', 'warning', `摘要超过 ${SUMMARY_MAX} 字（${summaryOf(entry.line).length}）`, [ref('MEMORY.md', entry.lineNo)])
    }
    if (entry.line.includes('(exp:') && !/\(exp:\d{4}-\d{2}-\d{2}\)/.test(entry.line)) {
      add('I1-invalid-expiry', 'error', '期限标记语法错误，过期判断会静默失效', [ref('MEMORY.md', entry.lineNo)])
    }
  }

  // I2 索引指向的正文与锚点必须存在
  const topicCache = new Map()
  const topicText = (name) => {
    if (!topicCache.has(name)) topicCache.set(name, readText(join(dir, name)))
    return topicCache.get(name)
  }
  for (const entry of entries) {
    if (/—\s*索引摘要(?: \(exp:\d{4}-\d{2}-\d{2}\))?$/.test(entry.line)) continue
    const match = TOPIC_REF.exec(entry.line)
    if (match === null) {
      if (!argLooksLegacy(entry.line)) {
        add('I2-unresolvable-topic-ref', 'warning', '索引行既没有正文引用，也没有“索引摘要”标记', [ref('MEMORY.md', entry.lineNo)])
      }
      continue
    }
    const file = match[1]
    const topic = topicText(file)
    if (topic === undefined) {
      add('I2-missing-topic-file', 'error', `索引指向的 ${file} 不存在`, [ref('MEMORY.md', entry.lineNo)], '补回主题文件或改成“— 索引摘要”')
      continue
    }
    if (match[2] !== undefined) {
      const wanted = foldAnchor(match[2])
      const headings = [...topic.matchAll(/^#{2,6}\s*(.+)$/gm)].map((heading) => foldAnchor(heading[1]))
      if (!headings.some((heading) => heading === wanted || heading.includes(wanted) || wanted.includes(heading))) {
        add('I2-missing-anchor', 'warning', `锚点在 ${file} 中找不到：${match[2]}`, [ref('MEMORY.md', entry.lineNo)], '改锚点或补标题')
      }
    }
  }

  // 账本
  let snapshot = null
  try {
    snapshot = candidateSnapshot(dir, scope)
  } catch (error) {
    // 项目库可能以另一作用域登记；只报告，不猜。
    add('I0-snapshot-error', 'error', `候选账本不可读：${error.message}`)
  }
  const records = snapshot?.records ?? []
  const current = active(records)
  const pending = records.filter((record) => record.status === 'pending')

  // I3 有效记录必须出现在索引里（投影不丢条目）
  for (const record of current) {
    const line = (record.indexLine ?? `- [${record.type}] ${record.summary}`).trim()
    if (!entries.some((entry) => entry.line === line)) {
      add('I3-record-missing-from-index', 'error', `有效记录未投影到索引：${record.id}`, [], '从账本重建索引，或确认该记录已过期')
    }
    if (record.detail !== undefined) {
      const topic = topicText(`${record.type}.md`)
      if (topic === undefined) {
        add('I3-detail-topic-missing', 'error', `记录 ${record.id} 的正文文件 ${record.type}.md 不存在`)
      } else if (!topic.includes(`[candidate:${record.id}]\n${record.detail}`)) {
        add('I3-detail-mismatch', 'error', `记录 ${record.id} 的正文与账本不一致（索引会指向错误内容）`, [ref(`${record.type}.md`)], '以账本为准重建正文块')
      }
    }
  }

  // I4 索引行是否有账本依据（手工条目允许，但必须可见）
  const knownLines = new Set(current.map((record) => (record.indexLine ?? `- [${record.type}] ${record.summary}`).trim()))
  let unclassified = 0
  for (const entry of entries) {
    if (!knownLines.has(entry.line)) unclassified += 1
  }
  if (unclassified > 0) {
    add('I4-index-without-ledger', 'info', `${unclassified} 条索引没有对应账本记录（手工或旧格式，不能当已审查证据）`)
  }

  // I5 撤回必须传播到索引
  try {
    const policy = withdrawalPolicy(dir)
    if (filterWithdrawn(text, policy, true) !== text) {
      add('I5-withdrawal-residue', 'error', '索引里仍有已撤回内容', [], '重新发布撤回或修复投影')
    }
  } catch (error) {
    add('I5-withdrawal-unreadable', 'warning', `撤回策略不可读：${error.message}`)
  }

  // I6 重复与近重复
  const seen = new Map()
  for (const entry of entries) {
    const key = entry.line
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [line, count] of seen) if (count > 1) add('I6-duplicate-line', 'warning', `完全重复的索引行 ×${count}：${line.slice(0, 60)}`)
  // 相似度对是 O(n²)：索引上限 300 行时约 4.5 万次比较，可接受；
  // 超过 400 行只比前 400 条，并显式说明，避免把检测器变成慢查询。
  const PAIR_LIMIT = 400
  if (entries.length > PAIR_LIMIT) {
    add('I6-similarity-truncated', 'info', `索引 ${entries.length} 行，相似度比对只覆盖前 ${PAIR_LIMIT} 条（全量重复检查仍覆盖全部）`)
  }
  const pairEntries = entries.slice(0, PAIR_LIMIT)
  for (let i = 0; i < pairEntries.length; i += 1) {
    for (let j = i + 1; j < pairEntries.length; j += 1) {
      const score = similarity(summaryOf(pairEntries[i].line), summaryOf(pairEntries[j].line))
      if (score >= SIMILARITY.reject) {
        add('I6-near-duplicate', 'warning', `疑似重复（相似度 ${score.toFixed(2)}）：MEMORY.md:${pairEntries[i].lineNo} 与 :${pairEntries[j].lineNo}`, [], '用 supersedes 合并，不要并排堆两条')
      }
    }
  }

  // I7 冲突签名：同一属性的不同取值同时有效
  const signatures = new Map()
  for (const entry of entries) {
    const sig = conflictSignature(summaryOf(entry.line))
    if (sig.values.length === 0) continue
    if (!signatures.has(sig.signature)) signatures.set(sig.signature, [])
    signatures.get(sig.signature).push(entry)
  }
  for (const [signature, group] of signatures) {
    if (group.length > 1) {
      add('I7-conflict', 'warning', `同一属性有 ${group.length} 个并存取值（${signature.slice(0, 40)}）：` + group.map((entry) => `MEMORY.md:${entry.lineNo}`).join('、'), [], '确认哪个现行，用 supersedes 收敛')
    }
  }

  // I8 预算
  const indexBytes = Buffer.byteLength(text, 'utf8')
  if (entries.length > LIMITS.indexMaxLines) add('I8-budget-lines', 'error', `索引 ${entries.length} 行，超过 ${LIMITS.indexMaxLines} 行上限`, [], '运行 memory_prune 或把细节移到主题文件')
  if (indexBytes > LIMITS.indexMaxBytes) add('I8-budget-bytes', 'error', `索引 ${indexBytes} 字节，超过 ${LIMITS.indexMaxBytes} 上限`)
  const bytes = storeBytes(dir)
  if (bytes > LIMITS.storeMaxBytes) add('I8-budget-store', 'error', `库占用 ${bytes} 字节，超过 ${LIMITS.storeMaxBytes} 上限`)

  // I9 作用域
  for (const record of current) {
    if (record.scope !== scope) add('I9-scope-mismatch', 'error', `记录 ${record.id} 的作用域是 ${record.scope}，不应出现在 ${scope} 库`)
  }

  // I10 版本/规则漂移：只能提示，不能自动判定哪边是真相
  const versions = [...new Set((text.match(VERSION_TOKEN) ?? []).map((token) => token.replace(/^v/, '')))]
  const stale = versions.filter((token) => token !== VERSION)
  if (stale.length > 0) add('I10-version-mention', 'info', `索引提到与当前版本（${VERSION}）不同的版本号：${stale.join('、')}`, [], '确认是否已过时，过时就 supersedes')

  // I11 隐私：只报告暴露面，不做“已保护”的假承诺
  const privateRecords = current.filter((record) => privateMemory(record))
  if (privateRecords.length > 0) add('I11-private-records', 'info', `${privateRecords.length} 条记录按隐私规则只在按需检索时返回；主题文件与账本仍是明文`)

  // I12 历史账本
  if (entries.length > 0 && !existsSync(join(dir, '.episodes.json'))) {
    add('I12-no-history-ledger', 'info', '有索引但没有历史账本，无法回答“当时怎么记的”')
  }

  // 主题文件反向检查：正文块必须有索引行
  const anchorsByFile = new Map()
  for (const entry of entries) {
    const match = TOPIC_REF.exec(entry.line)
    if (match === null) continue
    if (!anchorsByFile.has(match[1])) anchorsByFile.set(match[1], new Set())
    if (match[2] !== undefined) anchorsByFile.get(match[1]).add(foldAnchor(match[2]))
  }
  for (const type of TYPES) {
    const file = `${type}.md`
    const topic = topicText(file)
    if (topic === undefined) continue
    for (const match of topic.matchAll(/\[candidate:([0-9a-f]{8,64})\]/g)) {
      const id = match[1]
      const record = records.find((item) => item.id === id)
      if (record === undefined) {
        add('I13-detail-without-record', 'warning', `正文块 ${id} 在账本里不存在（孤立正文）`, [ref(file)])
      } else if (!['recorded', 'adopted'].includes(record.status)) {
        add('I13-detail-by-inactive-record', 'warning', `正文块 ${id} 对应的记录状态是 ${record.status}`, [ref(file)])
      }
    }
    // I14 结构：正文块必须在某个 ## 标题之下；文件末行不能是半句。
    const lines = topic.split(/\r?\n/)
    let sawHeading = false
    lines.forEach((line, index) => {
      if (/^#{2,6}\s+/.test(line)) sawHeading = true
      else if (line.includes('[candidate:') && !sawHeading) {
        add('I14-candidate-without-heading', 'warning', '正文块出现在任何 ## 标题之前，按标题读取时会被漏掉', [ref(file, index + 1)])
      }
    })
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) return
      const next = lines[index + 1]
      const isParagraphEnd = next === undefined || next.trim().length === 0
      if (!isParagraphEnd) return
      if (!/[，、：；,;]$/.test(trimmed)) return
      const isBullet = /^([-*]|\d+\.)\s/.test(trimmed)
      // 非列表行以冒号结尾、下一段是列表：这是引导句，不是截断。
      const nextNonEmpty = lines.slice(index + 1).find((item) => item.trim().length > 0)
      const leadIn = !isBullet && /[：:]$/.test(trimmed) && (nextNonEmpty?.trim().startsWith('- ') ?? false)
      if (leadIn) return
      add('I14-truncated-paragraph', 'warning', `段落以未完成标点结尾，像被截断：${trimmed.slice(-40)}`, [ref(file, index + 1)])
    })
    // I15 标题与索引锚点的对应：只有该文件已经使用锚点引用时才检查，避免把旧格式误报。
    const used = anchorsByFile.get(file)
    if (used !== undefined && used.size > 0) {
      for (const match of topic.matchAll(/^#{2,6}\s*(.+)$/gm)) {
        const heading = foldAnchor(match[1])
        if (heading.length === 0) continue
        if (![...used].some((anchor) => anchor === heading || heading.includes(anchor) || anchor.includes(heading))) {
          add('I15-heading-without-index', 'info', `标题没有索引指向：${match[1].trim().slice(0, 40)}`, [ref(file)])
        }
      }
    }
  }

  return {
    kind: 'store',
    version: VERSION,
    dir,
    scope,
    generatedAt: new Date().toISOString(),
    summary: { errors: bySeverity(findings, 'error'), warnings: bySeverity(findings, 'warning'), infos: bySeverity(findings, 'info') },
    metrics: {
      indexExists: hasIndex,
      indexLines: entries.length,
      indexBytes,
      limitLines: LIMITS.indexMaxLines,
      limitBytes: LIMITS.indexMaxBytes,
      storeBytes: bytes,
      storeLimitBytes: LIMITS.storeMaxBytes,
      activeRecords: current.length,
      pendingRecords: pending.length,
      privateRecords: privateRecords.length,
      unclassifiedIndexLines: unclassified,
      expiredIndexLines: entries.filter((entry) => isExpired(entry.line, now)).length,
    },
    findings,
  }
}

/** 旧格式索引行常见形态：以“— 文件名”之外的破折号结尾，例如手工补的说明。 */
function argLooksLegacy(line) {
  return /—\s*[^\s].*[，。；,;]$/.test(line) || !line.includes('—')
}

function hashPolicy(dir) {
  const parts = []
  for (const name of ['MEMORY.md', ...TYPES.map((type) => `${type}.md`)]) {
    const text = readText(join(dir, name))
    if (text !== undefined) parts.push(`${name}\n${text}`)
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex')
}

/**
 * 检测整棵记忆根目录：全局库 + 各项目库，并做跨库检查。
 * @param {string} root - 记忆根（通常是 ~/.dsh/memory）。
 */
export function detectRoot(root, options = {}) {
  const stores = []
  const globalReport = detectStore(root, { ...options, scope: 'global' })
  stores.push(globalReport)

  const projectsDir = join(root, 'projects')
  let names = []
  try {
    names = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    names = []
  }

  const crossFindings = []
  const hashes = new Map()
  const hashStore = (dir, name) => {
    const digest = hashPolicy(dir)
    if (!hashes.has(digest)) hashes.set(digest, [])
    hashes.get(digest).push(name)
  }
  if (globalReport.metrics.indexLines > 0) hashStore(root, 'global')
  const emptyStores = []
  const legacyNamed = []
  for (const name of names) {
    const dir = join(projectsDir, name)
    let scope = 'project'
    let report
    try {
      report = detectStore(dir, { ...options, scope })
    } catch (error) {
      report = {
        kind: 'store', version: VERSION, dir, scope, generatedAt: new Date().toISOString(),
        summary: { errors: 1, warnings: 0, infos: 0 }, metrics: null,
        findings: [{ id: 'I0-detect-error', severity: 'error', message: error.message }],
      }
      report.findings[0].refs = []
    }
    stores.push(report)
    if (report.metrics && report.metrics.indexLines === 0 && report.metrics.activeRecords === 0) emptyStores.push(name)
    if (report.metrics && report.metrics.indexLines === 0 && report.metrics.activeRecords === 0) legacyNamed.push(name)
    if (report.metrics.indexLines > 0) hashStore(dir, name)
  }
  for (const name of emptyStores) {
    crossFindings.push({ id: 'X1-empty-project-store', severity: 'info', message: `空项目库：${name}`, refs: [] })
  }
  for (const [digest, namesWithSame] of hashes) {
    if (namesWithSame.length > 1) {
      crossFindings.push({ id: 'X2-duplicate-store', severity: 'warning', message: `内容完全相同的库：${namesWithSame.join('、')}（sha256 ${digest.slice(0, 12)}…）`, refs: [] })
    }
  }
  if (names.length > 0) {
    // 项目库数量与真实工作区数量不必相等，但空库/测试夹具必须显式可见。
    crossFindings.push({ id: 'X3-project-store-count', severity: 'info', message: `项目库 ${names.length} 个，其中空库 ${emptyStores.length} 个`, refs: [] })
  }

  const totals = stores.reduce(
    (acc, store) => ({
      errors: acc.errors + store.summary.errors,
      warnings: acc.warnings + store.summary.warnings,
      infos: acc.infos + store.summary.infos,
    }),
    { errors: 0, warnings: 0, infos: 0 },
  )
  for (const finding of crossFindings) totals[finding.severity === 'error' ? 'errors' : finding.severity === 'warning' ? 'warnings' : 'infos'] += 1

  return {
    kind: 'root',
    version: VERSION,
    root,
    generatedAt: new Date().toISOString(),
    summary: totals,
    stores,
    crossFindings,
  }
}

export { LIMITS as DETECT_LIMITS }
