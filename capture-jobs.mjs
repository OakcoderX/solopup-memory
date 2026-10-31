/** Durable invocation metadata. No prompts, message bodies, routes or model output. */
import {normalizeCaptureDiagnostic,captureDiagnosticOutcome,CAPTURE_DIAGNOSTIC_SCHEMA} from './capture-diagnostics.mjs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readSafely, writeSafely, withLock } from './security.mjs'

const FILE = '.capture-jobs.json'
const LIMIT = 256
const MAX_BYTES = 256 * 1024
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^[a-f0-9-]{36}$/
const STATES = ['running', 'succeeded', 'failed', 'uncertain', 'abandoned']
const OUTCOMES = ['ok', 'partial', 'error', 'rejected']
const REASONS = ['capture-parser-rejected','capture-partial-extraction','capture-invalid-envelope','capture-response-too-large','capture-too-many-items', 'capture-all-rejected', 'capture-invalid-json', 'capture-empty-response', 'capture-max-tokens', 'capture-provider-error', 'capture-timeout', 'capture-model-capability', 'capture-failed', 'capture-write-failed', 'lease-expired', 'operator-abandoned']
const COUNT_KEYS = ['proposed', 'inserted', 'staged', 'rejected']
const time = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15
const fail = () => { throw new Error('capture-jobs-corrupt') }
const sameKeys = (value, keys) => Object.keys(value).every((key) => keys.includes(key))

function load(dir) {
  const path = join(dir, FILE)
  if (!existsSync(path)) return { schema: 1, revision: 0, jobs: [] }
  let state
  try {
    const text = readSafely(path)
    if (Buffer.byteLength(text) > MAX_BYTES) fail()
    state = JSON.parse(text)
  } catch { fail() }
  if (!state || state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !sameKeys(state, ['schema', 'revision', 'jobs']) || !Array.isArray(state.jobs) || state.jobs.length > LIMIT) fail()
  const seen = new Set()
  for (const job of state.jobs) {
    if (!job || typeof job.id !== 'string' || !HASH.test(job.id) || seen.has(job.id) || !STATES.includes(job.status) ||
      !time(job.at) || !time(job.updatedAt) || !time(job.expiresAt) || job.expiresAt <= job.at ||
      job.updatedAt < job.at || job.expiresAt - job.at < 1000 || job.expiresAt - job.at > 120_000 ||
      !sameKeys(job, ['id', 'status', 'at', 'updatedAt', 'expiresAt', 'token', 'outcome', 'reason', 'counts','diagnostic'])) fail()
    if (job.status === 'running' ? typeof job.token !== 'string' || !TOKEN.test(job.token) : job.token !== undefined) fail()
    if (job.outcome !== undefined && !OUTCOMES.includes(job.outcome)) fail()
    if (job.reason !== undefined && !REASONS.includes(job.reason)) fail()
    if (job.reason === 'operator-abandoned' && job.status !== 'abandoned') fail()
    if (job.counts !== undefined && (!job.counts || typeof job.counts !== 'object' || Array.isArray(job.counts) ||
      !sameKeys(job.counts, COUNT_KEYS) || Object.values(job.counts).some((n) => !Number.isInteger(n) || n < 0 || n > 1000))) fail()
    if(job.diagnostic!==undefined){try{job.diagnostic=normalizeCaptureDiagnostic(job.diagnostic)}catch{fail()};if(!['succeeded','failed'].includes(job.status)||captureDiagnosticOutcome(job.diagnostic)!==job.outcome||!job.counts||job.counts.proposed!==job.diagnostic.responseItems||job.counts.inserted!==job.diagnostic.inserted||job.counts.staged!==job.diagnostic.staged||job.counts.rejected!==job.diagnostic.parserRejected+job.diagnostic.admissionRejected)fail()}
    if (job.status === 'running' && (job.outcome !== undefined || job.reason !== undefined || job.counts !== undefined)) fail()
    if (job.status === 'uncertain' && (job.reason !== 'lease-expired' || job.outcome !== undefined || job.counts !== undefined)) fail()
    if (job.status === 'abandoned' && (job.reason !== 'operator-abandoned' || job.outcome !== undefined || job.counts !== undefined)) fail()
    if (['succeeded', 'failed'].includes(job.status) && (!job.counts || !OUTCOMES.includes(job.outcome) ||
      (job.status === 'succeeded') !== (job.outcome === 'ok'))) fail()
    seen.add(job.id)
  }
  return state
}

function save(dir, state) {
  state.revision += 1
  if (!Number.isSafeInteger(state.revision)) throw new Error('capture-jobs-revision-full')
  const text = JSON.stringify(state)
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('capture-jobs-full')
  writeSafely(join(dir, FILE), text)
}

function expire(state, now) {
  let expired = 0
  for (const job of state.jobs) if (job.status === 'running' && job.expiresAt <= now) {
    job.status = 'uncertain'; job.reason = 'lease-expired'; job.updatedAt = now; delete job.token; expired += 1
  }
  return expired
}

function publicJob(job) { const { token, ...value } = job; return structuredClone(value) }

export function listCaptureJobs(dir, { now = Date.now() } = {}) {
  if (!time(now)) throw new Error('capture-jobs-invalid-time')
  const state = load(dir)
  // Read-only view can identify expired work without creating or changing files.
  expire(state, now)
  return { revision: state.revision, jobs: state.jobs.map(publicJob) }
}

export function recoverCaptureJobs(dir, { now = Date.now() } = {}) {
  if (!time(now)) throw new Error('capture-jobs-invalid-time')
  return withLock(dir, () => {
    const state = load(dir); const expired = expire(state, now)
    if (expired) save(dir, state)
    return { expired, uncertain: state.jobs.filter((job) => job.status === 'uncertain').length }
  })
}

/** Operator closes waiting, not the unknown remote outcome. Never invokes a model. */
export function abandonCaptureJob(dir, id, { apply = false, expectedRevision, now = Date.now() } = {}) {
  if (typeof id !== 'string' || !HASH.test(id) || typeof apply !== 'boolean' || !time(now) ||
    expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('capture-jobs-invalid-abandon')
  const inspect = (state) => {
    const job = state.jobs.find((item) => item.id === id)
    if (!job) throw new Error('capture-jobs-not-found')
    if (now < job.updatedAt) throw new Error('capture-jobs-invalid-time')
    if (!['uncertain', 'abandoned'].includes(job.status)) throw new Error('capture-jobs-not-uncertain')
    return job
  }
  const result = (state, job, applied) => ({ applied, revision: state.revision, job: publicJob(job),
    externalOutcome: 'unknown', modelRequestResent: false, publishedMemoryRolledBack: false })
  if (!apply) {
    const state = load(dir); expire(state, now)
    return result(state, inspect(state), false)
  }
  if (expectedRevision === undefined) throw new Error('capture-jobs-review-required')
  return withLock(dir, () => {
    const state = load(dir)
    if (state.revision !== expectedRevision) throw new Error('capture-jobs-review-stale')
    expire(state, now)
    const job = inspect(state)
    if (job.status === 'abandoned') return result(state, job, false)
    job.status = 'abandoned'; job.reason = 'operator-abandoned'; job.updatedAt = now
    save(dir, state)
    return result(state, job, true)
  })
}

/** Fingerprint contains only an upstream-computed hash of the complete frozen input. */
export function claimCaptureJob(dir, fingerprint, { now = Date.now(), leaseMs = 60_000 } = {}) {
  if (typeof fingerprint !== 'string' || !HASH.test(fingerprint) || !time(now) || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120_000 || !time(now + leaseMs)) throw new Error('capture-jobs-invalid-claim')
  const id = createHash('sha256').update(`capture-v1:${fingerprint}`).digest('hex')
  return withLock(dir, () => {
    const state = load(dir); const expired = expire(state, now)
    const previous = state.jobs.find((job) => job.id === id)
    if (previous) {
      if (expired) save(dir, state)
      return { claimed: false, ...publicJob(previous) }
    }
    if (state.jobs.length === LIMIT) {
      // Unknown work stays unless an operator explicitly closes waiting. This is
      // bounded deduplication: any aged-out identity can be claimed again later.
      const index = state.jobs.findIndex((job) => ['succeeded', 'failed', 'abandoned'].includes(job.status))
      if (index < 0) throw new Error('capture-jobs-full')
      state.jobs.splice(index, 1)
    }
    const job = { id, status: 'running', at: now, updatedAt: now, expiresAt: now + leaseMs, token: randomUUID() }
    state.jobs.push(job); save(dir, state)
    return { claimed: true, ...structuredClone(job) }
  })
}

function claimed(state, claim, now) {
  const job = state.jobs.find((job) => job.id === claim?.id)
  if (!job || job.status !== 'running' || job.token !== claim?.token || typeof claim?.token !== 'string' || !TOKEN.test(claim.token) || job.expiresAt <= now || now < job.at) throw new Error('capture-jobs-stale-claim')
  return job
}

export function assertCaptureClaim(dir, claim, { now = Date.now() } = {}) {
  if (!time(now)) throw new Error('capture-jobs-invalid-time')
  claimed(load(dir), claim, now)
}

export function finishCaptureJob(dir, claim, { outcome, reason, counts = {},diagnostic }, { now = Date.now() } = {}) {
  if (!time(now) || !OUTCOMES.includes(outcome) || !counts || typeof counts !== 'object' || Array.isArray(counts) ||
    !sameKeys(counts, COUNT_KEYS) || Object.values(counts).some((n) => !Number.isInteger(n) || n < 0 || n > 1000)) throw new Error('capture-jobs-invalid-result')
  if(diagnostic!==undefined){try{diagnostic=normalizeCaptureDiagnostic(diagnostic)}catch{throw Error('capture-jobs-invalid-result')}}
  if(diagnostic&&(captureDiagnosticOutcome(diagnostic)!==outcome||counts.proposed!==diagnostic.responseItems||counts.inserted!==diagnostic.inserted||counts.staged!==diagnostic.staged||counts.rejected!==diagnostic.parserRejected+diagnostic.admissionRejected))throw Error('capture-jobs-invalid-result')
  return withLock(dir, () => {
    const state = load(dir); const job = claimed(state, claim, now)
    if(diagnostic!==undefined)job.diagnostic=diagnostic
    job.status = outcome === 'ok' ? 'succeeded' : 'failed'; job.outcome = outcome; job.updatedAt = now
    job.counts = { ...counts }; delete job.token
    // Never copy exception/provider text into this file.
    if (reason !== undefined) job.reason = REASONS.includes(reason) && reason !== 'operator-abandoned' ? reason : 'capture-failed'
    save(dir, state)
    return publicJob(job)
  })
}

/** Only a typed failure before acquiring the store lock is safe to retry. */
export async function retryBusyWrite(operation, { beforeAttempt = () => {}, maxAttempts = 3, delayMs = 50 } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('capture-invalid-retry')
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    beforeAttempt()
    try { return operation() }
    catch (error) {
      if (error?.code !== 'memory-lock-busy' || attempt + 1 === maxAttempts) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/** Read-only global scheduler metadata. Absence/corruption is not a claim about recall. */
export function captureJobStatus(dir){
 const boundary={coverage:'retained-global-jobs-only',semanticCompletenessVerified:false}
 try{const s=JSON.parse(readSafely(join(dir,'.capture-state.json'),{maxBytes:16384}));if(s.lastOutcome==='blocked'&&s.lastError==='capture-input-source-incomplete'&&typeof s.lastCaptureAt==='string'&&s.lastCaptureAt.length<=32&&Number.isFinite(Date.parse(s.lastCaptureAt)))boundary.blockedInput={reason:'source-incomplete',at:s.lastCaptureAt}}catch{}

 try{
  const {jobs}=listCaptureJobs(dir),latest=[...jobs].sort((a,b)=>b.updatedAt-a.updatedAt||(b.counts?.proposed??0)-(a.counts?.proposed??0)||b.at-a.at).at(0)
  return{available:true,...boundary,retained:jobs.length,running:jobs.filter(job=>job.status==='running').length,failed:jobs.filter(job=>job.status==='failed').length,uncertain:jobs.filter(job=>job.status==='uncertain').length,legacy:jobs.filter(job=>['succeeded','failed'].includes(job.status)&&!job.diagnostic).length,...latest?{latest:{jobId:latest.id,status:latest.status,...latest.outcome?{outcome:latest.outcome}:{},...latest.reason?{reason:latest.reason}:{},...latest.diagnostic?{diagnostic:latest.diagnostic}:{}}}:{}}
 }catch{return{available:false,...boundary,reason:'capture-ledger-unavailable'}}
}
export const CAPTURE_STATUS_SCHEMA={type:'object',additionalProperties:false,required:['available','coverage','semanticCompletenessVerified'],properties:{available:{type:'boolean'},coverage:{type:'string',enum:['retained-global-jobs-only']},semanticCompletenessVerified:{type:'boolean'},blockedInput:{type:'object',additionalProperties:false,required:['reason','at'],properties:{reason:{type:'string',enum:['source-incomplete']},at:{type:'string'}}},reason:{type:'string',enum:['capture-ledger-unavailable']},retained:{type:'integer'},running:{type:'integer'},failed:{type:'integer'},uncertain:{type:'integer'},legacy:{type:'integer'},latest:{type:'object',additionalProperties:false,required:['jobId','status'],properties:{jobId:{type:'string'},status:{type:'string',enum:STATES},outcome:{type:'string',enum:OUTCOMES},reason:{type:'string',enum:REASONS},diagnostic:CAPTURE_DIAGNOSTIC_SCHEMA}}}}
