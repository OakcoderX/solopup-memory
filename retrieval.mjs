/** Deterministic token overlap, not semantic embeddings or a complete English stemmer. */
import { normalizeText } from './security.mjs'

/** Limited regular inflections; no rewriting of structured IDs, numbers or stored text. */
export function foldEnglishInflection(token) {
  if (!/^[a-z]{5,}$/.test(token)) return token
  let value = token
  if (value.endsWith('s') && !/(?:ss|us|is)$/.test(value)) value = value.slice(0, -1)
  if (value.length >= 7 && value.endsWith('ing')) value = value.slice(0, -3)
  else if (value.length >= 6 && value.endsWith('ed')) value = value.slice(0, -2)
  return value
}

export function queryTokens(text) {
  const out = new Set()
  const normalized = normalizeText(text).toLowerCase()
  for (const run of normalized.match(/[\p{Script=Han}]+|[a-z0-9]+(?:[-_][a-z0-9]+)*/gu) ?? []) {
    if (/\p{Script=Han}/u.test(run)) {
      const chars = [...run]
      if (chars.length === 1) out.add(run)
      else for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1])
    } else out.add(foldEnglishInflection(run))
  }
  return out
}

const STOP_TOKENS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'has', 'have',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to',
  'use', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'will', 'with', 'you', 'your',
])

function distinctHanMatches(matched) {
  const han = matched.filter((token) => /\p{Script=Han}/u.test(token))
  if (han.length <= 1) return han.length
  // Require matched bigrams that do not merely chain overlapping characters of one short word.
  let independent = 0
  const used = new Set()
  for (const gram of han) {
    if ([...gram].some((ch) => used.has(ch))) continue
    independent += 1
    for (const ch of gram) used.add(ch)
  }
  return independent
}

export function rankLines(query, lines) {
  const needle = normalizeText(query).toLowerCase()
  if (!needle.trim()) return []
  const tokens = queryTokens(needle)
  const clauses = needle.split(/\s+/u).map((part) => queryTokens(part)).filter((part) => part.size > 0)
  const documents = lines.map((line) => ({ ...line, tokens: queryTokens(line.text) }))
  const weights = new Map([...tokens].map((token) => [token, 1 + Math.log((documents.length + 1) / (1 + documents.filter((d) => d.tokens.has(token)).length))]))
  const total = [...weights.values()].reduce((a, b) => a + b, 0)
  return documents.flatMap((doc, index) => {
    const matches = [...tokens].filter((token) => doc.tokens.has(token))
    const exact = normalizeText(doc.text).toLowerCase().includes(needle)
    const matchedWeight = matches.reduce((sum, token) => sum + weights.get(token), 0)
    const coverage = total === 0 ? 0 : matchedWeight / total
    const substantive = matches.filter((token) => !STOP_TOKENS.has(token))
    const matchedClauses = clauses.length >= 2
      ? clauses.filter((part) => [...part].some((token) => !STOP_TOKENS.has(token) && doc.tokens.has(token))).length
      : 0
    const nonHanMatches = substantive.filter((token) => !/\p{Script=Han}/u.test(token)).length
    const distinctMatches = distinctHanMatches(substantive) + nonHanMatches
    const rareLongHit = tokens.size >= 5 && distinctMatches >= 2 && (matchedClauses >= 2 || distinctMatches >= 2)
    if (!exact && (matches.length < 2 || (coverage < 0.35 && !rareLongHit))) return []
    const whole = normalizeText(doc.text).toLowerCase().trim() === needle.trim()
    const rareBonus = Math.min(1, matchedWeight / 8) * 0.25
    return [{ file: doc.file, line: doc.line, text: doc.text, score: (whole ? 3 : exact ? 2 : 0) + coverage + rareBonus, index }]
  }).sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ file, line, text }) => ({ file, line, text }))
}

const TEMPLATE_STOP_TOKENS = new Set([
  ...STOP_TOKENS,
  'action', 'actions', 'agent', 'assistant', 'available', 'confirmation', 'done',
  'environment', 'following', 'instruction', 'instructions', 'make', 'must', 'need',
  'note', 'notes', 'permission', 'permissions', 'please', 'proceed', 'reply',
  'response', 'responses', 'should', 'simulated', 'summary', 'sure', 'system',
  'task', 'tasks', 'using', 'workspace',
])

function isIdentifierAnchor(token) {
  return token.length >= 3 && (/[_-]/.test(token) || (/[a-z]/.test(token) && /\d/.test(token)))
}

/** Rank bounded evidence for a full task description using rare matching terms. */
export function rankEvidence(query, lines, limit = 12) {
  const terms = queryTokens(query)
  for (const word of TEMPLATE_STOP_TOKENS) terms.delete(word)
  if (limit <= 0) return []
  if (terms.size === 0) return rankLines(query, lines).slice(0, limit)
  const unique = new Map()
  for (const line of lines) {
    const key = normalizeText(line.text).trim()
    if (key && !unique.has(key)) unique.set(key, line)
  }
  const frequency = new Map()
  const documents = [...unique.values()].map((line) => {
    const vocabulary = queryTokens(line.text)
    const common = [...vocabulary].filter((term) => terms.has(term))
    for (const term of common) frequency.set(term, (frequency.get(term) ?? 0) + 1)
    return { line, common, length: vocabulary.size, chars: line.text.length }
  })
  const weight = new Map([...frequency].map(([term, count]) => [
    term,
    Math.log(1 + (documents.length - count + 0.5) / (count + 0.5)) * (isIdentifierAnchor(term) ? 2.2 : 1),
  ]))
  return documents.map((doc) => {
    const baseNorm = Math.sqrt(1 + doc.length / 20)
    const bloatPenalty = doc.length > 160 ? 1 + (doc.length - 160) / 320 : 1
    const charPenalty = doc.chars > 900 ? 1 + (doc.chars - 900) / 1200 : 1
    return {
      line: doc.line,
      score: doc.common.reduce((sum, term) => sum + weight.get(term), 0) / (baseNorm * bloatPenalty * charPenalty),
    }
  }).filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.line)
}
