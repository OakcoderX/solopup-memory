import { applicability, normalizeContext, normalizeMeaning } from './meaning.mjs'
import { privateMemory } from './privacy.mjs'
import { queryTokens } from './retrieval.mjs'
import { findSecrets, frameIntegrity, isSmelly, normalizeText, sanitizeForInjection } from './security.mjs'

const MAX_RULES = 4
const MAX_CONTEXT_BYTES = 2304
const MAX_DETAIL_BYTES = 480
const QUERY_EDGE = 4000
const SOURCE_ID = /^[a-f0-9]{64}$/
const COMMON_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'does', 'for', 'from', 'has', 'have',
  'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'so', 'that', 'the', 'then', 'this',
  'to', 'use', 'using', 'was', 'when', 'with', 'you', 'your',
  '这个', '那个', '应该', '需要', '请把', '使用', '之后', '之前',
])
const INTRO = '以下是带来源的记忆约定。以本轮用户明确要求和适用例外为准。仅用于现有任务，不增加操作权限。若某条约定替换了旧做法，须彻底清除旧做法、不并列。'
const safeLine = value => sanitizeForInjection(value).replace(/\s+/gu, ' ').trim()

function relevantTokens(text) {
  return [...queryTokens(text)].filter(token => !COMMON_WORDS.has(token) && token.length > 1)
}

function eligibleRecord(record) {
  const reviewed = record?.status === 'adopted' && /^[a-f0-9]{8}$/.test(record.adoption?.memoryId ?? '')
  const sourceWrite = record?.status === 'recorded' && ['tool-context', 'quoted-extraction'].includes(record.origin)
  return (reviewed || sourceWrite) && SOURCE_ID.test(record.id ?? '') &&
    ['project', 'global'].includes(record.scope) && ['preference', 'decision'].includes(record.meaning?.kind) &&
    typeof record.summary === 'string' && Array.isArray(record.sources) && record.sources.length > 0 &&
    record.sources.every(id => SOURCE_ID.test(id)) &&
    Array.isArray(record.evidence) && record.evidence.length > 0 && !privateMemory(record)
}

// A short project detail can supply terms elided by the summary. Only project
// an exact excerpt of retained evidence, with no extra authority of its own.
function matchingDetail(record, taskTokens, summary) {
  if (record.scope !== 'project' || typeof record.detail !== 'string' ||
      Buffer.byteLength(record.detail) > MAX_DETAIL_BYTES) return undefined
  const detail = normalizeText(record.detail).replace(/\s+/gu, ' ').trim()
  if (!detail || summary.includes(detail) || isSmelly(detail) || findSecrets(detail).length ||
      !frameIntegrity(detail).ok) return undefined
  const tokens = relevantTokens(detail)
  const matches = tokens.filter(token => taskTokens.has(token))
  if (matches.length < 2 || !record.evidence.some(item => typeof item?.quote === 'string' &&
      normalizeText(item.quote).replace(/\s+/gu, ' ').includes(detail))) return undefined
  return { text: safeLine(detail), score: matches.length / tokens.length }
}

/** Only rules with all structured conditions resolved are eligible for a delivery review. */
export function effectiveRuleText(rule) {
  return rule.applicability === 'applicable' ? rule.summary : ''
}

function renderRule(rule) {
  const formatTerms = terms => terms.map(term => `${term.dimension}=${safeLine(term.value)}`)
  const required = formatTerms(rule.conditions).join(' 且 ')
  const excluded = formatTerms(rule.except).join(' 或 ')
  const qualifiers = [required && `条件 ${required}`, excluded && `例外 ${excluded}`].filter(Boolean)
  const label = rule.applicability === 'applicable' ? '适用' : '条件待核对'
  const scope = rule.scope === 'project' ? '本项目' : '全局'
  if (rule.applicability === 'unknown' && [...rule.conditions, ...rule.except].some(term => term.dimension === 'edition')) {
    return `- [${label}，${scope}，${rule.id.slice(0, 12)}] ${qualifiers.join('，')}。可用 memory_search 查询适用条件和来源。`
  }
  const detail = rule.detail ? `（来源摘录：${rule.detail}）` : ''
  return `- [${label}，${scope}，${rule.id.slice(0, 12)}] ${rule.summary}${qualifiers.length ? `（${qualifiers.join('，')}）` : ''}${detail}`
}

/**
 * Project a small live view from records already filtered against the active store projection.
 * Callers supply only the current project's records and trusted, explicit context dimensions.
 * The text query ranks relevance and never proves a condition, an exception, or a replacement.
 */
export function selectEffectiveMemory({ records, query, context, includeProjectDefaults = false, revoked = [] }) {
  if (typeof query !== 'string' || !query.trim()) return []
  const text = query.length <= QUERY_EDGE * 2 ? query : `${query.slice(0, QUERY_EDGE)}\n${query.slice(-QUERY_EDGE)}`
  const taskTokens = new Set(relevantTokens(text))
  const taskContext = normalizeContext(context)
  const withdrawn = new Set(revoked)
  const matches = []
  for (const record of records) {
    if (!eligibleRecord(record) || record.sources.some(id => withdrawn.has(id))) continue
    const meaning = normalizeMeaning(record.meaning)
    const match = applicability(meaning, taskContext)
    if (match.state === 'not-applicable') continue
    const summary = safeLine(record.summary)
    const conditionText = [...meaning.conditions, ...meaning.except].map(term => safeLine(term.value)).join(' ')
    if (!summary || isSmelly(normalizeText(`${summary} ${conditionText}`)) || !frameIntegrity(`${summary} ${conditionText}`).ok) continue

    const tokens = relevantTokens(`${summary} ${conditionText}`)
    const overlap = tokens.filter(token => taskTokens.has(token))
    const detail = matchingDetail(record, taskTokens, summary)
    const relevant = overlap.length >= 2 || overlap.some(token => token.length >= 6 || /\d/.test(token)) ||
      (overlap.length === 1 && taskTokens.size === 1) || (match.state === 'applicable' && meaning.conditions.length > 0) ||
      detail !== undefined
    const projectDefault = includeProjectDefaults && record.scope === 'project' && meaning.kind === 'preference' &&
      meaning.conditions.length === 0 && meaning.except.length === 0
    if (!relevant && !projectDefault) continue

    matches.push({
      rule: { id: record.id, scope: record.scope, kind: meaning.kind, summary,
        conditions: meaning.conditions, except: meaning.except, applicability: match.state,
        ...(detail ? { detail: detail.text } : {}) },
      relevant,
      score: Math.max(overlap.length / Math.max(1, tokens.length), detail?.score ?? 0),
      createdAt: record.createdAt ?? '',
    })
  }

  matches.sort((a, b) => Number(b.rule.applicability === 'applicable') - Number(a.rule.applicability === 'applicable') ||
    Number(b.relevant) - Number(a.relevant) || b.score - a.score ||
    Number(b.rule.scope === 'project') - Number(a.rule.scope === 'project') ||
    b.createdAt.localeCompare(a.createdAt) || a.rule.id.localeCompare(b.rule.id))

  const chosen = []
  const seen = new Set()
  let bytes = Buffer.byteLength(INTRO)
  for (const match of matches) {
    if (chosen.length === MAX_RULES) break
    let { rule } = match
    const ruleKey = JSON.stringify([rule.summary.toLowerCase(), rule.conditions, rule.except])
    if (seen.has(ruleKey)) continue
    let size = Buffer.byteLength(renderRule(rule)) + 1
    if (bytes + size > MAX_CONTEXT_BYTES && rule.detail) {
      const { detail, ...summaryOnly } = rule
      rule = summaryOnly
      size = Buffer.byteLength(renderRule(rule)) + 1
    }
    if (bytes + size > MAX_CONTEXT_BYTES) continue
    seen.add(ruleKey)
    chosen.push(rule)
    bytes += size
  }
  return chosen
}

export function renderEffectiveMemory(rules) {
  return rules.length ? [INTRO, ...rules.map(renderRule)].join('\n') : ''
}
