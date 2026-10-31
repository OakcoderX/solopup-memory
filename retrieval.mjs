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

export function rankLines(query, lines) {
  const needle = normalizeText(query).toLowerCase()
  if (!needle.trim()) return []
  const tokens = queryTokens(needle)
  const documents = lines.map((line) => ({ ...line, tokens: queryTokens(line.text) }))
  const weights = new Map([...tokens].map((token) => [token, 1 + Math.log((documents.length + 1) / (1 + documents.filter((d) => d.tokens.has(token)).length))]))
  const total = [...weights.values()].reduce((a, b) => a + b, 0)
  return documents.flatMap((doc, index) => {
    const matches = [...tokens].filter((token) => doc.tokens.has(token))
    const exact = normalizeText(doc.text).toLowerCase().includes(needle)
    const coverage = total === 0 ? 0 : matches.reduce((sum, token) => sum + weights.get(token), 0) / total
    if (!exact && (matches.length < 2 || coverage < 0.35)) return []
    const whole = normalizeText(doc.text).toLowerCase().trim() === needle.trim()
    return [{ file: doc.file, line: doc.line, text: doc.text, score: (whole ? 3 : exact ? 2 : 0) + coverage, index }]
  }).sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ file, line, text }) => ({ file, line, text }))
}
