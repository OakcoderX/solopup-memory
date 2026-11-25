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
const sentenceBoundary = /[。！？.!?\r\n]/u
const trialCue = /先试(?!听)|仅试(?!听)|试留|拟试行|仅作试行|暂定|尚待定案|尚未定案/u
const trialWording = /先试(?!听)|仅试(?!听)|试留|试行|试运行|暂定|待定|未定案/u
const approvalCue = /(?:现已|已经|已)(?:正式)?(?:签字|签批|签署|批准|拍板|定案)/u
const finalApprovalCue = /已(?:经)?(?:签字(?:并)?(?:批准|同意)?|批准|拍板(?:决定)?)\s*正式(?:采用|保留|执行|生效|选用)/u
const beforeSignoffCue = /签字(?:\s*之)?前/u
const pendingSignoffCue = /签字(?:\s*之)?前|(?:尚未|还未|未)签字/u

// Recover qualifiers immediately around a uniquely located quotation. The
// neighboring sentences remain separate evidence, even in a single message.
function quoteContext({messageId, quote}, messages) {
  const source = messages.find(message => message.role === 'user' && message.id === messageId)?.text
  const at = source?.indexOf(quote) ?? -1
  if (at < 0 || at !== source.lastIndexOf(quote)) return quote
  const start = source.slice(0, at).split(sentenceBoundary).at(-1)
  const end = source.slice(at + quote.length).split(sentenceBoundary)[0]
  return start + quote + (sentenceBoundary.test(quote.at(-1)) ? '' : end)
}

/** Narrow capture checks for explicit trial and signature qualifiers, not general entailment. */
export function captureQualifierIssues(candidate, messages, evidence = candidate.evidence) {
  if (candidate.type !== 'project' || candidate.scope !== 'project') return []
  const issues = new Set()
  const {kind, conditions = []} = candidate.meaning ?? {}
  const wording = `${candidate.summary}\n${candidate.detail ?? ''}`
  const settledRule = kind === 'decision' || kind === 'preference'
  if (settledRule && trialCue.test(candidate.summary) && !approvalCue.test(candidate.summary)) issues.add('meaning')
  for (const ref of evidence) {
    const sentences = quoteContext(ref, messages).split(sentenceBoundary).filter(sentence => sentence.trim())
    // A broad excerpt spanning several subjects must not transfer a qualifier
    // from one sentence to an unrelated proposal in another.
    const anchors = sentences.length > 1 ? [...candidate.summary.matchAll(/(?=([\p{Script=Han}]{4}))/gu)].map(match => match[1]) : []
    for (const source of sentences) {
      if (sentences.length > 1 && !anchors.some(anchor => source.includes(anchor))) continue
      if (trialCue.test(source) && !finalApprovalCue.test(source)) {
        if (settledRule) issues.add('meaning')
        if (!trialWording.test(candidate.summary) || finalApprovalCue.test(wording)) issues.add('wording')
      }
      const pending = source.search(beforeSignoffCue)
      if (pending >= 0 && source.search(approvalCue) <= pending) {
        if (!pendingSignoffCue.test(candidate.summary)) issues.add('wording')
        if (!conditions.some(({dimension,value}) => (dimension === 'signoff' && value === 'pending') || pendingSignoffCue.test(value))) issues.add('applicability')
      }
    }
  }
  return [...issues]
}

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
  if (captureQualifierIssues(candidate, messages, evidence).length) return { status: 'rejected', reason: 'candidate-rejected' }
  if (candidate.basis === 'explicit') return { status: 'eligible', scope, evidence }
  if (candidate.basis === 'inferred') return { status: 'candidate', scope, evidence, reason: 'inference-needs-review' }
  return { status: 'rejected', reason: 'missing-basis' }
}
