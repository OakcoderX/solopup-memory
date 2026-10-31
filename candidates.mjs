/** Persistent, non-injected inference inbox. One atomic document under the store lock. */
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { readSafely, writeSafely, withLock, normalizeText, escapeFraming, findSecrets, entryId } from './security.mjs'
import { assertPublicationClear, commitPublication } from './publication.mjs'
import {managedRead,managedWrite,managedPolicy,managedCandidateView,rootsFor,requireManagedRoots,isManagedStore,installManagedCandidateInternals} from './managed-access.mjs'
import { SOURCE_LEDGER_BYTES, SOURCE_RECORD_LIMIT, RETIRED_SOURCE_LIMIT, PENDING_CANDIDATE_LIMIT, validateRetiredSource, prepareSourceRetirement } from './source-retirement.mjs'
import {text,proposal,toolProposal} from './source-record.mjs'
import {assertFieldLineageParent} from './field-lineage.mjs'
export { SOURCE_LEDGER_BYTES } from './source-retirement.mjs'

const FILE = '.candidates.json'
const MAX_BYTES = SOURCE_LEDGER_BYTES
const MAX_RECORDS = SOURCE_RECORD_LIMIT
const MAX_REVOKED = 1000
const TYPES = ['user', 'feedback', 'project', 'reference']
const SOURCE_ORIGINS = ['tool-context', 'quoted-extraction']
const hasSourceOrigin = record => SOURCE_ORIGINS.includes(record.origin)
const STATES = ['pending', 'rejected', 'withdrawn', 'adopted', 'recorded', 'superseded', 'retired']
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Build a candidate-ledger after-image under the caller's local publication lock. */
function prepareToolWriteLocal(dir, input, supersededLine, indexText) {
  const state = readState(dir), item = toolProposal(input)
  if(item.fieldLineage)assertFieldLineageParent(item,state.records.find(r=>r.id===item.fieldLineage.parentId),supersededLine)
  requireManagedRoots(dir,item.sources)
  if (item.sources.some(source => state.revoked.includes(source))) throw new Error('candidate-source-withdrawn')
  if (state.records.some(record => record.id === item.id)) throw new Error('candidate-tool-call-already-recorded')
  for (const record of state.records) {
    if (hasSourceOrigin(record) && record.status === 'recorded' && record.indexLine === supersededLine) {
      record.status = 'superseded'; record.supersededBy = item.id
    }
  }
  state.schema = Math.max(state.schema,item.fieldLineage?4:3)
  const record={...item,status:'recorded',createdAt:new Date().toISOString()};state.records.push(record)
  const topicWrites = prepareSourceRetirement(dir, state, { indexText })
  if (state.records.length > MAX_RECORDS) throw new Error('candidate-store-full')
  if (state.records.length > 200) state.schema = Math.max(state.schema,3)
  state.revision += 1
  const raw = JSON.stringify(state, null, 2) + '\n'
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('candidate-store-full')
  return { id: item.id, record, write: { name: FILE, text: raw }, topicWrites,
    additionalBytes: Math.max(0, Buffer.byteLength(raw) - Buffer.byteLength(readSafely(join(dir, FILE), { maxBytes: MAX_BYTES }) ?? '')) }
}

function readState(dir, capture) {
  assertPublicationClear(dir)
  const raw = readSafely(join(dir, FILE), { maxBytes: MAX_BYTES })
  if (capture) capture.raw = raw
  if (raw === undefined) return { schema: 1, revision: 0, records: [], retired: [], revoked: [], rejectedIds: [], withdrawnLines: [], withdrawnMemoryIds: [], withdrawnCandidateIds: [], withdrawnBlocks: [], managedWithdrawnSources: [] }
  let state
  try { state = JSON.parse(raw) } catch { throw new Error('candidate-corrupt-json') }
  if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error('candidate-corrupt-state')
  state.retired ??= []
  if (!Array.isArray(state.retired) || state.retired.length > RETIRED_SOURCE_LIMIT || ![3,4].includes(state.schema) && state.retired.length) throw new Error('candidate-corrupt-retired-source')
  state.rejectedIds ??= []
  state.withdrawnLines ??= []
  state.withdrawnMemoryIds ??= []
  state.withdrawnCandidateIds ??= []
  state.withdrawnBlocks ??= []
  state.managedWithdrawnSources ??= []
  for (const name of ['withdrawnLines', 'withdrawnMemoryIds', 'withdrawnCandidateIds', 'managedWithdrawnSources']) {
    const size = name === 'withdrawnMemoryIds' ? 8 : 64
    if (!Array.isArray(state[name]) || state[name].length > MAX_REVOKED || !state[name].every((v) => typeof v === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(v))) throw new Error('candidate-corrupt-policy')
  }
  if (!Array.isArray(state.withdrawnBlocks) || state.withdrawnBlocks.length > MAX_REVOKED || !state.withdrawnBlocks.every((b) => /^[a-f0-9]{64}$/.test(b?.id) && /^[a-f0-9]{64}$/.test(b?.hash) && Number.isSafeInteger(b.length) && b.length > 0 && b.length < 6000)) throw new Error('candidate-corrupt-policy')
  if (![1, 2, 3, 4].includes(state?.schema) || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Array.isArray(state.records) || state.records.length > ([3,4].includes(state.schema) ? MAX_RECORDS : 200) ||
      !Array.isArray(state.revoked) || state.revoked.length > MAX_REVOKED ||
      !state.revoked.every((key) => /^[a-f0-9]{64}$/.test(key)) ||
      !Array.isArray(state.rejectedIds) || state.rejectedIds.length > MAX_REVOKED ||
      !state.rejectedIds.every((key) => /^[a-f0-9]{64}$/.test(key))) throw new Error('candidate-corrupt-state')
  const ids = new Set()
  state.records = state.records.map((record) => {
    if (!record || record.status === 'retired' || !STATES.includes(record.status) || ids.has(record.id)) throw new Error('candidate-corrupt-record')
    ids.add(record.id)
    if (hasSourceOrigin(record)) {
      if (state.schema < 2) throw new Error('candidate-tool-format-needs-schema2')
      if(record.fieldLineage&&state.schema<4)throw new Error('candidate-field-format-needs-schema4')
      if (!['recorded', 'superseded'].includes(record.status)) throw new Error('candidate-context-only-status')
      const validated = toolProposal(record)
      if (validated.id !== record.id || JSON.stringify(validated.sources) !== JSON.stringify(record.sources) || typeof record.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.createdAt)) throw new Error('candidate-corrupt-tool-identity')
      const result = { ...validated, status: record.status, createdAt: record.createdAt,
        ...(record.status === 'superseded' ? { supersededBy: record.supersededBy } : {}) }
      if (record.status === 'superseded' && !/^[a-f0-9]{64}$/.test(record.supersededBy) || Object.keys(record).sort().join('|') !== Object.keys(result).sort().join('|')) throw new Error('candidate-corrupt-tool-record')
      return result
    }
    if (['recorded', 'superseded'].includes(record.status)) throw new Error('candidate-corrupt-record')
    if (record.status !== 'withdrawn') {
      const validated = proposal(record)
      if (validated.id !== record.id || JSON.stringify(validated.sources) !== JSON.stringify(record.sources)) throw new Error('candidate-corrupt-identity')
      if (typeof record.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.createdAt)) throw new Error('candidate-corrupt-time')
      let adoption
      if (record.status === 'adopted') {
        const a = record.adoption
        if (!a || !/^[a-f0-9]{8}$/.test(a.memoryId) || !/^[a-f0-9]{64}$/.test(a.reviewedIndex) ||
            typeof a.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(a.at)) throw new Error('candidate-corrupt-adoption')
        if (a.lineHash !== undefined && !/^[a-f0-9]{64}$/.test(a.lineHash)) throw new Error('candidate-corrupt-adoption')
        adoption = { memoryId: a.memoryId, reviewedIndex: a.reviewedIndex, at: a.at, ...(a.lineHash === undefined ? {} : { lineHash: a.lineHash }) }
      }
      return { ...validated, status: record.status, createdAt: record.createdAt, ...(adoption ? { adoption } : {}) }
    }
    if (!/^[a-f0-9]{64}$/.test(record.id) || !Array.isArray(record.sources) || !record.sources.every((s) => /^[a-f0-9]{64}$/.test(s))) throw new Error('candidate-corrupt-tombstone')
    return { id: record.id, status: record.status, sources: record.sources }
  })
  state.retired = state.retired.map(record => { const validated = validateRetiredSource(record); if (ids.has(record.id)) throw new Error('candidate-corrupt-retired-source'); ids.add(record.id); return validated })
  return state
}

function save(dir, state) {
  const topicWrites = prepareSourceRetirement(dir, state)
  if (state.records.length > MAX_RECORDS) throw new Error('candidate-store-full')
  if (state.records.length > 200) state.schema = Math.max(state.schema,3)
  state.revision += 1
  const raw = JSON.stringify(state, null, 2) + '\n'
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('candidate-store-full')
  commitPublication(dir, [...topicWrites, { name: FILE, text: raw }])
}

function stageCandidateLocal(dir, input) {
  const item = proposal(input)
  return withLock(dir, () => {
    const state = readState(dir)
    if (item.sources.some((source) => state.revoked.includes(source))) return { id: item.id, status: 'withdrawn', duplicate: true }
    if (state.rejectedIds.includes(item.id)) return { id: item.id, status: 'rejected', duplicate: true }
    const existing = state.records.find((r) => r.id === item.id)
    if (existing) return { id: item.id, status: existing.status, duplicate: true }
    if (state.records.filter(record => record.status === 'pending').length >= PENDING_CANDIDATE_LIMIT) throw new Error('candidate-store-full')
    state.records.push({ ...item, status: 'pending', createdAt: new Date().toISOString() })
    save(dir, state)
    return { id: item.id, status: 'pending', duplicate: false }
  })
}

/** No mkdir/write on list. Candidate text is never a memory context provider. */
function listCandidatesLocal(dir, { status = 'pending', limit = 20 } = {}) {
  if (status !== 'all' && !STATES.includes(status)) throw new Error('candidate-invalid-status')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('candidate-invalid-limit')
  const state = readState(dir)
  const records = managedCandidateView(dir,{records:[...state.records,...state.retired]}).records.filter((r) => status === 'all' || r.status === status)
  return { revision: state.revision, total: records.length, records: records.slice(-limit), truncated: records.length > limit }
}

function rejectCandidateLocal(dir, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('candidate-invalid-id')
  return withLock(dir, () => {
    const state = readState(dir)
    const item = state.records.find((r) => r.id === id)
    if (!item && state.rejectedIds.includes(id)) return { id, status: 'rejected' }
    if (!item) throw new Error('candidate-not-found')
    if (item.status === 'pending') { item.status = 'rejected'; save(dir, state) }
    return { id, status: item.status }
  })
}

/** Withdrawal is scoped to this candidate inbox, not the effective memory store. */
function withdrawSourceLocal(dir, sessionId, messageId) {
  const source = digest([text(sessionId, 250, 'session'), text(messageId, 300, 'message')])
  return withLock(dir, () => {
    const state = readState(dir)
    if (state.revoked.includes(source)) return { withdrawn: 0, duplicate: true }
    if (state.records.some((r) => ['adopted', 'recorded', 'superseded'].includes(r.status) && r.sources.includes(source)) || state.retired.some(record => record.sources.includes(source))) throw new Error('candidate-adopted-needs-effective-withdrawal')
    if (state.revoked.length >= MAX_REVOKED) throw new Error('candidate-revocations-full')
    state.revoked.push(source)
    let withdrawn = 0
    state.records = state.records.map((r) => {
      if (!r.sources.includes(source) || r.status === 'withdrawn') return r
      withdrawn += 1
      return { id: r.id, status: 'withdrawn', sources: r.sources }
    })
    save(dir, state)
    return { withdrawn, duplicate: false }
  })
}

/** Explicit cleanup recovers capacity without dropping rejection/source tombstones. */
function pruneCandidatesLocal(dir, { apply = false } = {}) {
  if (typeof apply !== 'boolean') throw new Error('candidate-invalid-apply')
  const plan = (state) => {
    const removable = state.records.filter((r) => r.status === 'rejected' || r.status === 'withdrawn')
    const rejectedIds = [...new Set([...state.rejectedIds, ...removable.filter((r) => r.status === 'rejected').map((r) => r.id)])]
    if (rejectedIds.length > MAX_REVOKED) throw new Error('candidate-rejections-full')
    return { removable, rejectedIds }
  }
  if (!apply) {
    const state = readState(dir)
    return { removed: plan(state).removable.length, applied: false, revision: state.revision }
  }
  return withLock(dir, () => {
    const state = readState(dir)
    const { removable, rejectedIds } = plan(state)
    if (removable.length) {
      state.records = state.records.filter((r) => ['pending', 'adopted', 'recorded', 'superseded'].includes(r.status))
      state.rejectedIds = rejectedIds
      save(dir, state)
    }
    return { removed: removable.length, applied: true, revision: state.revision }
  })
}

function candidateReviewLocal(dir, id, scope) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('candidate-invalid-id')
  const state = readState(dir)
  const record = state.records.find((r) => r.id === id)
  if (!record || record.status === 'withdrawn' || record.status === 'rejected') throw new Error('candidate-not-reviewable')
  if (hasSourceOrigin(record)) throw new Error('candidate-context-only-needs-independent-review')
  if (record.scope !== scope) throw new Error('candidate-review-scope-mismatch')
  return { candidateRevision: state.revision, candidate: record }
}

/** Writer must include the returned candidate after-image in the same publication. */
function publishReviewedCandidateLocal(dir, id, options, writer) {
  return withLock(dir, () => {
    const state = readState(dir)
    const view = candidateReview(dir, id, options.scope)
    requireManagedRoots(dir, view.candidate.sources)
    if (view.candidate.status === 'adopted') return { id, status: 'adopted', duplicate: true, memoryId: view.candidate.adoption.memoryId }
    if (!Number.isSafeInteger(options.candidateRevision) || state.revision !== options.candidateRevision) throw new Error('candidate-stale-review')
    if (!/^[a-f0-9]{64}$/.test(options.reviewedIndex) || !/^[a-f0-9]{8}$/.test(options.memoryId) || !/^[a-f0-9]{64}$/.test(options.lineHash)) throw new Error('candidate-invalid-review')
    const record = state.records.find((r) => r.id === id)
    if (record.sources.some((key) => state.revoked.includes(key))) throw new Error('candidate-source-withdrawn')
    record.status = 'adopted'
    // A new explicit review may reaffirm identical text from fresh, non-revoked roots.
    state.withdrawnLines = state.withdrawnLines.filter((line) => line !== options.lineHash)
    state.withdrawnMemoryIds = state.withdrawnMemoryIds.filter((memoryId) => memoryId !== options.memoryId)
    record.adoption = { memoryId: options.memoryId, reviewedIndex: options.reviewedIndex, lineHash: options.lineHash, at: new Date().toISOString() }
    state.revision += 1
    const raw = JSON.stringify(state, null, 2) + '\n'
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('candidate-store-full')
    writer(view.candidate, { name: FILE, text: raw })
    return { id, status: 'adopted', duplicate: false, memoryId: options.memoryId }
  })
}

/** One bounded validated ledger read. The raw document is never returned. */
function candidateSnapshotLocal(dir, scope) {
  if (!['global', 'project'].includes(scope)) throw new Error('candidate-review-scope-mismatch')
  const capture = {}, state = readState(dir, capture)
  if ([...state.records, ...state.retired].some(record => record.status !== 'withdrawn' && record.scope !== scope)) throw new Error('candidate-review-scope-mismatch')
  return { candidateRevision: state.revision, fingerprint: digest(capture.raw ?? null),
    records: [...state.records, ...state.retired], retiredCount: state.retired.length, revoked: state.revoked, managedWithdrawnSources: state.managedWithdrawnSources }
}

function sourceWithdrawalReviewKeyLocal(dir, source, scope) {
  if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(source)) throw new Error('candidate-invalid-source-key')
  const snapshot = candidateSnapshot(dir, scope)
  return { candidateRevision: snapshot.candidateRevision, source,
    affected: snapshot.records.filter(record => record.sources.includes(source) && record.status !== 'withdrawn'),
    independent: snapshot.records.filter(record => ['adopted', 'recorded'].includes(record.status) && !record.sources.includes(source)),
    alreadyWithdrawn: snapshot.managedWithdrawnSources.includes(source) }
}

function sourceWithdrawalReviewLocal(dir, sessionId, messageId, scope) {
  return sourceWithdrawalReviewKey(dir, digest([text(sessionId, 250, 'session'), text(messageId, 300, 'message')]), scope)
}

function publishSourceWithdrawalLocal(dir, sessionId, messageId, options, build) {
  return publishSourceWithdrawalKey(dir, digest([text(sessionId, 250, 'session'), text(messageId, 300, 'message')]), options, build)
}

function publishSourceWithdrawalKeyLocal(dir, source, options, build) {
  return withLock(dir, () => {
    const view = sourceWithdrawalReviewKey(dir, source, options.scope)
    if (view.alreadyWithdrawn) return { withdrawn: 0, duplicate: true }
    const state = readState(dir)
    if (!Number.isSafeInteger(options.candidateRevision) || state.revision !== options.candidateRevision) throw new Error('candidate-stale-review')
    const plan = build(view.affected, view.independent)
    if (!state.revoked.includes(view.source)) {
      if (state.revoked.length >= MAX_REVOKED) throw new Error('candidate-revocations-full')
      state.revoked.push(view.source)
    }
    if (state.managedWithdrawnSources.length >= MAX_REVOKED) throw new Error('candidate-revocations-full')
    state.managedWithdrawnSources.push(view.source)
    for (const [name, values] of [['withdrawnLines', plan.lineHashes], ['withdrawnMemoryIds', plan.memoryIds], ['withdrawnCandidateIds', plan.candidateIds]]) {
      state[name] = [...new Set([...state[name], ...values])]
      if (state[name].length > MAX_REVOKED) throw new Error('candidate-revocations-full')
    }
    const blocks = new Map([...state.withdrawnBlocks, ...plan.blocks].map((b) => [b.id, b]))
    state.withdrawnBlocks = [...blocks.values()]
    if (state.withdrawnBlocks.length > MAX_REVOKED) throw new Error('candidate-revocations-full')
    state.records = state.records.map((r) => r.sources.includes(view.source) ? { id: r.id, sources: r.sources, status: 'withdrawn' } : r)
    state.retired = state.retired.filter(record => !record.sources.includes(view.source))
    state.revision += 1
    const raw = JSON.stringify(state, null, 2) + '\n'
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('candidate-store-full')
    commitPublication(dir, [...plan.writes, { name: FILE, text: raw }], { fault: options.publicationFault })
    return { withdrawn: view.affected.length, effectiveRemoved: plan.effectiveRemoved, duplicate: false }
  })
}

/** A labelled prior version may be returned only while its source remains valid. */
function toolSupersessionLineLocal(dir, memoryId) {
  const state = readState(dir), revoked = managedPolicy(dir, { revoked: state.revoked }).revoked, current = state.records.filter(record => hasSourceOrigin(record) && record.status === 'recorded' && entryId(record.indexLine) === memoryId && !record.sources.some(source => revoked.includes(source)))
  if (current.length > 1) throw new Error('candidate-ambiguous-tool-memory')
  if (!current.length) return undefined
  const prior = state.records.filter(record => hasSourceOrigin(record) && record.status === 'superseded' && record.supersededBy === current[0].id && !record.sources.some(source => revoked.includes(source)))
  if (prior.length > 1) throw new Error('candidate-ambiguous-tool-history')
  return prior[0]?.indexLine
}

const policyCache = new Map()
function withdrawalPolicyLocal(dir) {
  assertPublicationClear(dir)
  let stat
  try { stat = lstatSync(join(dir, FILE), { bigint: true }) } catch (error) { if (error.code === 'ENOENT') return { lineHashes: [], memoryIds: [], candidateIds: [], blocks: [], revoked: [] }; throw error }
  const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}`
  const cached = policyCache.get(dir)
  if (cached?.stamp === stamp) return cached.policy
  const state = readState(dir)
  const reaffirmed = new Set(state.records.filter(record => record.status === 'adopted' && record.adoption.lineHash && !record.sources.some(source => state.revoked.includes(source))).map(record => record.adoption.lineHash))
  const superseded = state.records.filter(record => hasSourceOrigin(record) && record.status === 'superseded' && !reaffirmed.has(createHash('sha256').update(normalizeText(record.indexLine).trim()).digest('hex')))
  const retiredLines = state.retired.filter(record => !reaffirmed.has(record.lineHash))
  const policy = Object.freeze({ lineHashes: Object.freeze([...new Set([...state.withdrawnLines, ...retiredLines.map(record => record.lineHash), ...superseded.map(record => createHash('sha256').update(normalizeText(record.indexLine).trim()).digest('hex'))])]),
    memoryIds: Object.freeze([...new Set([...state.withdrawnMemoryIds, ...retiredLines.map(record => record.memoryId), ...superseded.map(record => entryId(record.indexLine))])]),
    candidateIds: Object.freeze([...new Set([...state.withdrawnCandidateIds, ...state.retired.map(record => record.id), ...superseded.map(record => record.id)])]),
    blocks: Object.freeze([...state.withdrawnBlocks, ...state.retired.filter(record => record.block).map(record => record.block), ...superseded.filter(record => record.detail !== undefined).map(record => { const text = `[candidate:${record.id}]\n${record.detail}`; return { id: record.id, length: text.length, hash: createHash('sha256').update(text).digest('hex') } })]), revoked: Object.freeze(state.revoked) })
  if (policyCache.size > 128) policyCache.clear()
  policyCache.set(dir, { stamp, policy })
  return policy
}

function evidenceWithdrawnLocal(dir, sessionId, evidence) {
  if (!sessionId || !Array.isArray(evidence)) return false
  const policy = managedPolicy(dir, withdrawalPolicyLocal(dir))
  return rootsFor(sessionId,evidence).some(source=>policy.revoked.includes(source))
}

/** Counts only: status remains inspectable when provenance needs repair. */
function sourceLedgerStatusLocal(dir) {
  const limits = { fullLimit: MAX_RECORDS, pendingLimit: PENDING_CANDIDATE_LIMIT, retiredLimit: RETIRED_SOURCE_LIMIT, byteLimit: MAX_BYTES }
  try {
    const captured = {}, state = readState(dir, captured)
    return { available: true, ...limits, fullRecords: state.records.length, retiredRecords: state.retired.length, pending: state.records.filter(record => record.status === 'pending').length, bytes: Buffer.byteLength(captured.raw ?? '') }
  } catch { return { available: false, ...limits, reason: 'source-ledger-unavailable' } }
}

installManagedCandidateInternals({candidateSnapshot:candidateSnapshotLocal,withdrawalPolicy:withdrawalPolicyLocal,sourceWithdrawalReviewKey:sourceWithdrawalReviewKeyLocal,SOURCE_LEDGER_BYTES})
export function listCandidates(dir,...args){return managedRead(dir,()=>managedCandidateView(dir,listCandidatesLocal(dir,...args)))}
export function candidateReview(dir,...args){return managedRead(dir,()=>{const value=managedCandidateView(dir,candidateReviewLocal(dir,...args));if(value.candidate?.status==='withdrawn')throw Error('managed-memory-candidate-source-revoked');return value})}
export function candidateSnapshot(dir,...args){return managedRead(dir,()=>managedCandidateView(dir,candidateSnapshotLocal(dir,...args)))}
export function sourceWithdrawalReviewKey(dir,...args){if(isManagedStore(dir))throw Error('managed-memory-use-global-withdrawal');return managedRead(dir,()=>sourceWithdrawalReviewKeyLocal(dir,...args))}
export function sourceWithdrawalReview(dir,...args){if(isManagedStore(dir))throw Error('managed-memory-use-global-withdrawal');return managedRead(dir,()=>sourceWithdrawalReviewLocal(dir,...args))}
export function toolSupersessionLine(dir,...args){return managedRead(dir,()=>toolSupersessionLineLocal(dir,...args))}
export function withdrawalPolicy(dir,...args){return managedRead(dir,()=>managedPolicy(dir,withdrawalPolicyLocal(dir,...args)))}
export function evidenceWithdrawn(dir,...args){return managedRead(dir,()=>evidenceWithdrawnLocal(dir,...args))}
export function sourceLedgerStatus(dir,...args){return managedRead(dir,()=>sourceLedgerStatusLocal(dir,...args))}
export function prepareToolWrite(dir,input,...args){return managedWrite(dir,()=>prepareToolWriteLocal(dir,input,...args),{sources:rootsFor(input?.sessionId,input?.evidence)})}
export function stageCandidate(dir,input,...args){return managedWrite(dir,()=>stageCandidateLocal(dir,input,...args),{sources:rootsFor(input?.sessionId,input?.evidence)})}
export function rejectCandidate(dir,...args){return managedWrite(dir,()=>rejectCandidateLocal(dir,...args))}
export function withdrawSource(dir,...args){if(isManagedStore(dir))throw Error('managed-memory-use-global-withdrawal');return managedWrite(dir,()=>withdrawSourceLocal(dir,...args))}
export function pruneCandidates(dir,...args){return managedWrite(dir,()=>pruneCandidatesLocal(dir,...args))}
export function publishReviewedCandidate(dir,...args){return managedWrite(dir,()=>publishReviewedCandidateLocal(dir,...args))}
export function publishSourceWithdrawal(dir,...args){if(isManagedStore(dir))throw Error('managed-memory-use-global-withdrawal');return managedWrite(dir,()=>publishSourceWithdrawalLocal(dir,...args))}
export function publishSourceWithdrawalKey(dir,...args){if(isManagedStore(dir))throw Error('managed-memory-use-global-withdrawal');return managedWrite(dir,()=>publishSourceWithdrawalKeyLocal(dir,...args))}
