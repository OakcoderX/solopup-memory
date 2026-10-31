/** Host-validated capture evidence. No probability or semantic-truth claims. */
import { createHash } from 'node:crypto'
import { normalizeText, redactSecrets, escapeFraming } from './security.mjs'
import {meaningForScope,assertMeaningSatisfiable} from './meaning.mjs'

export function captureMessage(event, id) {
  const message = event?.data?.message ?? event?.data
  const source = message?.source?.kind
  // Unknown provenance is not owner testimony. Real v4 events carry data.source.
  if (event?.type === 'user/message' && source !== 'user') return undefined
  const role = event?.type === 'user/message' ? 'user' : event?.type === 'assistant/message' ? 'assistant' : undefined
  if (role === undefined || !Array.isArray(message?.content)) return undefined
  const normalized = redactSecrets(normalizeText(message.content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n'))).trim()
  const text=normalized.slice(0,2000)
  if (!text) return undefined
  return { id, role, text, hash: createHash('sha256').update(text).digest('hex'),...role==='user'&&normalized.length>2000?{sourceComplete:false}:{} }
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
