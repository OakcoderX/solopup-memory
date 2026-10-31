import {createHash} from 'node:crypto'
import {normalizeText,escapeFraming,findSecrets} from './security.mjs'
import {normalizeObservationCertificate,observationRoots} from './tool-observations.mjs'
import {meaningForScope} from './meaning.mjs'
import {normalizeFieldLineage,inheritedRoots} from './field-lineage.mjs'
const TYPES=['user','feedback','project','reference'],SOURCE_ORIGINS=['tool-context','quoted-extraction']
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function text(value, max, label) {
  if (typeof value !== 'string') throw new Error(`candidate-invalid-${label}`)
  const clean = normalizeText(value).trim()
  if (!clean || clean.length > max || findSecrets(clean).length) throw new Error(`candidate-invalid-${label}`)
  return escapeFraming(clean)
}

function proposal(input, minimumQuoteLength = 8) {
  if (!input || !TYPES.includes(input.type) || !['global', 'project'].includes(input.scope)) throw new Error('candidate-invalid-kind')
  if (input.type === 'project' && input.scope !== 'project') throw new Error('candidate-project-scope')
  const sessionId = text(input.sessionId, 250, 'session')
  const summary = text(input.summary, 200, 'summary')
  if (!/^[a-f0-9]{64}$/.test(input.indexRevision)) throw new Error('candidate-invalid-revision')
  if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 3) throw new Error('candidate-invalid-evidence')
  const evidence = input.evidence.map((e) => {
    if (!e || !/^[a-f0-9]{64}$/.test(e.hash)) throw new Error('candidate-invalid-hash')
    const quote = text(e.quote, 500, 'quote')
    if (quote.length < minimumQuoteLength) throw new Error('candidate-short-quote')
    return { messageId: text(e.messageId, 300, 'message'), hash: e.hash, quote }
  })
  const sources = [...new Set(evidence.map((e) => digest([sessionId, e.messageId])))].sort()
  const meaning=meaningForScope(input.meaning,input.scope)
  const id = digest([input.type, input.scope, summary, sources,...(meaning===undefined?[]:[meaning])])
  return { id, type: input.type, scope: input.scope, summary,
    ...(meaning===undefined?{}:{meaning}),
    ...(input.detail === undefined ? {} : { detail: text(input.detail, 4000, 'detail') }),
    sessionId, evidence, sources, indexRevision: input.indexRevision }
}

/** Source-linked effective writes retain origin without becoming independently reviewed facts. */
function toolProposal(input) {
  const origin = input.origin ?? 'tool-context'
  if (!SOURCE_ORIGINS.includes(origin)) throw new Error('candidate-invalid-source-origin')
  const base = proposal(input, origin === 'tool-context' ? 1 : 8)
  const observation=input.observation===undefined?undefined:normalizeObservationCertificate(input.observation,input.sessionId)
  const fieldLineage=normalizeFieldLineage(input.fieldLineage,{scope:base.scope,meaning:base.meaning,ownSources:base.sources,observation,expires:input.expires})
  if(observation&&(origin!=='tool-context'||base.meaning?.kind!=='episode'||observation.outcome!=='succeeded'&&base.meaning.relations?.length))throw Error('candidate-invalid-observation-role')
  if (typeof input.callHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.callHash)) throw new Error('candidate-invalid-tool-call')
  let expiry = ''
  if (input.expires !== undefined) {
    if (typeof input.expires !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(input.expires) || !Number.isFinite(Date.parse(input.expires)) || new Date(input.expires).toISOString().slice(0, 10) !== input.expires) throw new Error('candidate-invalid-tool-expiry')
    expiry = ` (exp:${input.expires})`
  }
  const expected = `- [${base.type}] ${base.summary} — ${base.detail === undefined ? '索引摘要' : base.type + '.md'}${expiry}`
  if (input.indexLine !== expected) throw new Error('candidate-tool-line-mismatch')
  const id = digest([origin, base.id, expected, input.callHash,...observation===undefined?[]:[observation],...fieldLineage===undefined?[]:[fieldLineage]])
  return { ...base, id, ...(fieldLineage?{fieldLineage,sources:[...new Set([...base.sources,...inheritedRoots(fieldLineage)])].sort()}:{}),...(observation?{observation,sources:[...new Set([...base.sources,...observationRoots(observation)])].sort()}:{}), origin, callHash: input.callHash, indexLine: expected,
    ...(input.expires === undefined ? {} : { expires: input.expires }) }
}


export {text,proposal,toolProposal}
