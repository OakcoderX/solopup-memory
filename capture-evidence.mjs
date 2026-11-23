/** Host-validated capture evidence. No probability or semantic-truth claims. */
import { createHash } from 'node:crypto'
import { normalizeText, redactSecrets, escapeFraming } from './security.mjs'
import {privateMemory} from './privacy.mjs'
import {meaningForScope,assertMeaningSatisfiable} from './meaning.mjs'

export const MAX_OWNER_MESSAGE_BYTES = 8 * 1024

export function captureMessage(event, id) {
  const message = event?.data?.message ?? event?.data
  const source = message?.source?.kind
  // Unknown provenance is not owner testimony. Real v4 events carry data.source.
  if (event?.type === 'user/message' && (source !== 'user' || message.source.principal !== undefined)) return undefined
  const role = event?.type === 'user/message' ? 'user' : event?.type === 'assistant/message' ? 'assistant' : undefined
  if (role === undefined || !Array.isArray(message?.content)) return undefined
  const normalized = redactSecrets(normalizeText(message.content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n'))).trim()
  const tooLong = role === 'user' && Buffer.byteLength(normalized) > MAX_OWNER_MESSAGE_BYTES
  const text = role === 'assistant' || tooLong ? normalized.slice(0, 2000) : normalized
  if (!text) return undefined
  return { id, role, text, hash: createHash('sha256').update(text).digest('hex'), ...(tooLong ? { sourceComplete: false } : {}) }
}

// Preserve the printed heading and byline only when a quote belongs to one
// unambiguous speaker. Two separated excerpts must never become one fake quote.
const printedDate = /(?:[12]\d{3}年\d{1,2}月\d{1,2}日|[12]\d{3}-\d{2}-\d{2})/gu
const minutesHeader = /(?:纪要|记录|交接|备忘|会议|访谈|笔记|minutes|handoff|meeting|interview|notes)[\s，,。：:·|—–(（-]*$/iu
const speakerLine = /^([\p{L}][\p{L}\p{M} .·'-]{0,36})[：:]\s*/u

export function bindDatedQuotation(candidate, owner) {
  if (candidate.type !== 'project' || candidate.scope !== 'project' || candidate.basis !== 'explicit' ||
      typeof candidate.summary !== 'string' || candidate.supersedes || candidate.evidence?.length !== 1 || !owner || owner.role !== 'user' ||
      owner.sourceComplete === false || privateMemory(owner.text) || owner.text.includes('[REDACTED:')) return candidate
  const ref = candidate.evidence[0]
  if (ref.messageId !== owner.id || typeof ref.quote !== 'string' || ref.quote.length < 8 || ref.quote.length > 500) return candidate
  const [header, line, ...rest] = owner.text.split(/\r?\n/u)
  if (!header || header.length > 160 || !line || rest.length) return candidate
  const dates = Array.from(header.matchAll(printedDate))
  if (dates.length !== 1) return candidate
  const date = dates[0][0], start = dates[0].index
  if (!minutesHeader.test(header.slice(0,start)) || !/^[\s。.)）]*$/u.test(header.slice(start+date.length))) return candidate
  const label = speakerLine.exec(line)
  if (!label || /[:：]/u.test(line.slice(label[0].length))) return candidate
  const speaker = label[1].trim(), bodyAt = owner.text.length-line.length
  const at = owner.text.indexOf(ref.quote)
  if (at < bodyAt || at !== owner.text.lastIndexOf(ref.quote)) return candidate
  // Only extend across the byline itself. Unquoted speech before the cited
  // passage stays out of the stored quote, including when the message is short.
  const span = owner.text.slice(start, at+ref.quote.length)
  const quote = at <= bodyAt+label[0].length && span.length <= 500 ? span : ref.quote
  if (privateMemory(quote) || escapeFraming(quote)!==quote || redactSecrets(quote)!==quote) return candidate
  const tagged = candidate.summary.includes(date) && candidate.summary.includes(speaker)
    ? candidate.summary : '〔'+date+' · '+speaker+'〕'+candidate.summary
  // The original, owner-bound evidence and summary remain valid when full.
  const summary = tagged.length <= 200 ? tagged : candidate.summary
  return {...candidate, summary, evidence:[{...ref,quote}]}
}

/** Quotes establish occurrence, not entailment, durability, or authorization. */
export function assessCandidate(candidate, messages, hasProject) {
  if(messages.some(m=>m.role==='user'&&m.sourceComplete===false))return{status:'rejected',reason:'incomplete-user-source'}
  try { assertMeaningSatisfiable(meaningForScope(candidate.meaning,candidate.scope)) } catch { return {status:'rejected',reason:'invalid-meaning'} }
  const scope = candidate.scope
  if (scope !== 'global' && scope !== 'project') return { status: 'rejected', reason: 'missing-scope' }
  if (candidate.type === 'project' && scope !== 'project') return { status: 'rejected', reason: 'project-global' }
  if (scope === 'project' && !hasProject) return { status: 'rejected', reason: 'missing-project' }
  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0 || candidate.evidence.length > 3) {
    return { status: 'rejected', reason: 'missing-evidence' }
  }
  const evidence = []
  const seen = new Set()
  for (const ref of candidate.evidence) {
    const message = messages.find((m) => m?.id === ref?.messageId)
    const quote = typeof ref?.quote === 'string' ? normalizeText(ref.quote).trim() : ''
    if (!message || message.role !== 'user' || quote.length < 8 || quote.length > 500 || !message.text.includes(quote)) {
      return { status: 'rejected', reason: 'invalid-user-evidence' }
    }
    if (!seen.has(message.id)) {
      evidence.push({ messageId: message.id, hash: message.hash, quote: escapeFraming(quote) })
      seen.add(message.id)
    }
  }
  if (['explicit','inferred'].includes(candidate.basis) && candidate.meaning === undefined) return { status: 'rejected', reason: 'invalid-meaning' }
  if (candidate.basis === 'explicit') return { status: 'eligible', scope, evidence }
  if (candidate.basis === 'inferred') return { status: 'candidate', scope, evidence, reason: 'inference-needs-review' }
  return { status: 'rejected', reason: 'missing-basis' }
}
