/** Deterministic admission for a single owner-authored value correction. */
import { createHash } from 'node:crypto'
import { compileValueRevision, inheritedRoots } from './field-lineage.mjs'
import { privateMemory } from './privacy.mjs'
import { escapeFraming, findSecrets, normalizeText } from './security.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const digest = value => hash(JSON.stringify(value))
const nonFinal = /(?:暂不|暂勿|暂定|试行|试用|试跑|试试|试验阶段|试点|演练|假设|临时|待确认|未确认|未批准|不要记|不用记|别记|禁止写入|不要写入|只供|仅供|仅这次|仅本次|只限本次|\b(?:trial|tentative|provisional|hypothetical|draft only|one[- ]time|do not|don't|unapproved|pending approval)\b)/iu
const applicability = /[，,；;：:！？!?。\n\r]|\.(?!\d)|(?:如若|如果|只在|仅在|只对|仅对|除非|否则|若[是需要]|之前|之后|以前|以后|前提|例外|范围|签字|签批|签署|审批|批准|核准|同意|授权|放行|许可|门槛|阈值|审核通过|\b(?:if|unless|until|except|before|after|approval|approved|scope|permission|authorized|threshold|only)\b)/iu
const valuePrefix = /(?:为|用|采用|使用|设为|选定|定为|\b(?:is|are|use|uses|set to|defaults? to)) *$/iu
// The primary value can have units or an unchanged trailing clause. A change
// inside a trailing clause fails because its prefix contains the delimiter.
const valueSuffix = /^ *(?:集|章|分钟|秒|帧|页|字|个|份|条|天|小时|倍|%|px|ms|s|min|episodes?|pages?|frames?|minutes?|hours?)? *(?:[，,；;] *\S.*|[.。])?$/iu
const scalars = [
  /(?<![\w./-])v\d+(?:\.\d+){0,3}(?![\w/-]|\.\w)/giu,
  /(?<![\w./+-])\d+(?:\.\d+)?(?![\w/-]|\.\w)/gu,
  /中文|英文|日文|法文|德文|(?<![\w.-])(?:Chinese|English|Japanese|French|German)(?![\w/-]|\.\w)/gu,
  /(?<![\w.-])(?:PDF|DOCX|PPTX|XLSX|TXT|CSV|JSON|PNG|JPG|MP4|WAV)(?![\w/-]|\.\w)/gu,
]

function explicitCorrection(text) {
  if (typeof text !== 'string' || text.length > 500 || /[\r\n\u2028\u2029]/u.test(text) || nonFinal.test(text) ||
      normalizeText(text).trim() !== text || escapeFraming(text) !== text || privateMemory(text) || findSecrets(text).length) return
  const match = /^(?:更正)[：:]? *「([^「」]{2,200})」 *(?:→|->) *「([^「」]{2,200})」$/u.exec(text) ??
    /^Correction: *"([^"\n]{2,200})" *-> *"([^"\n]{2,200})"$/iu.exec(text)
  if (!match) return
  const [, before, after] = match
  const slot = changedValueSlot(before, after)
  if (before.trim() !== before || after.trim() !== after || !slot || !valuePrefix.test(slot.prefix) ||
      !valueSuffix.test(slot.suffix) || applicability.test(slot.prefix)) return
  return { before, after }
}

function changedValueSlot(before, after) {
  for (const pattern of scalars) {
    const left = [...before.matchAll(pattern)], right = [...after.matchAll(pattern)]
    for (const old of left) {
      const prefix = before.slice(0, old.index), suffix = before.slice(old.index + old[0].length)
      const next = right.find(next => old.index === next.index && old[0] !== next[0] &&
        prefix === after.slice(0, next.index) && suffix === after.slice(next.index + next[0].length))
      if (next) return { prefix, suffix, oldValue: old[0], newValue: next[0] }
    }
  }
}

export const sameDreamValueSlot = (before, after) => Boolean(changedValueSlot(before, after))

/** The proposal must agree with the source verbatim. Neither generates the other's authority. */
export function planDreamCorrection({ report, input, proof }) {
  const corrections = report.items.filter(row => row.verdict === 'propose-correction')
  if (corrections.length !== 1) return
  const [row] = corrections
  const item = input.items.find(candidate => candidate.id === row.id)
  const pointers = proof.pointers[row.id] ?? []
  const sources = proof.additionalEvidenceByTarget?.[row.id] ?? []
  if (!item || item.incompleteEvidence || row.evidenceDigest !== digest(item) || row.pointerDigest !== digest(pointers) ||
      pointers.length !== 1 || sources.length !== 1 || !item.recordedAt || !item.meaning ||
      item.sources.some(source => source.kind === 'related-record' || !row.sourceIds.includes(source.id)) ||
      row.sourceIds.length !== item.sources.length) return
  const [source] = sources, [pointer] = pointers
  if (source.wholeOwnerMessage !== true || !Number.isSafeInteger(source.liveCursor) ||
      source.projectId !== report.projectId || source.role !== 'user' || !source.sourceComplete ||
      source.sessionId !== pointer.sessionId || source.messageId !== `${pointer.sessionId}:${pointer.seq}` ||
      source.text !== source.quote || source.hash !== pointer.hash || source.hash !== hash(source.text) ||
      !(Date.parse(source.occurredAt) > Date.parse(item.recordedAt))) return
  const correction = explicitCorrection(source.text)
  const sourceId = digest([source.sessionId, source.messageId])
  if (!correction || correction.before !== item.summary || correction.after !== row.proposedSummary ||
      !item.sources.some(entry => entry.kind === 'additional-user-message' && entry.id === sourceId && entry.hash === source.hash) ||
      !item.sources.some(entry => entry.kind === 'original') ||
      item.sources.some(entry => entry.kind === 'original' && nonFinal.test(entry.quote))) return
  return {
    targetId: row.id, projectId: report.projectId, storeRevision: report.storeRevision,
    operationId: digest(['solopup-dream-owner-value-correction-v1', report.projectId, row.id, sourceId, source.hash]),
    sourceId, source, ...correction,
  }
}

export function prepareDreamCorrection(plan, parent) {
  if (!parent || parent.id !== plan.targetId || parent.scope !== 'project' || parent.summary !== plan.before ||
      !parent.indexLine || parent.detail !== undefined || parent.sources.includes(plan.sourceId)) return
  try {
    const compiled = compileValueRevision(parent, parent.meaning, parent.scope, parent.expires)
    if (new Set([plan.sourceId, ...inheritedRoots(compiled.fieldLineage)]).size > 3) return
    const slot = changedValueSlot(plan.before, plan.after)
    if (!slot || [...compiled.meaning.conditions, ...compiled.meaning.except].some(({ dimension, value }) =>
      [slot.oldValue, slot.newValue].some(scalar => `${dimension} ${value}`.toLowerCase().includes(scalar.toLowerCase())))) return
    return compiled
  } catch (error) {
    if (!error?.code?.startsWith('memory-revision-')) throw error
  }
}
