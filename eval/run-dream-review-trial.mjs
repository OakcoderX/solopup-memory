#!/usr/bin/env node
/** Resumable operator trial. Running this file directly prints the plan and makes zero model calls. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dreamReviewMessages, DREAM_REVIEW_LIMITS } from '../dream-review.mjs'
import { findSecrets, normalizeText, readSafely, withLock, writeSafely } from '../security.mjs'
import {
  DREAM_REVIEW_FIXTURE_SHA256, DREAM_REVIEW_FIXTURE_VERSION, DREAM_REVIEW_PROMPT_SHA256,
  dreamEvalBatches, gradeDreamReviewBatch,
} from './dream-review-cases.mjs'

const MODES = ['ordinary', 'superagent']
const HARD_LIMITS = Object.freeze({ calls: 40, inputTokens: 150_000, outputTokens: 25_000 })
const BATCH_CAPS = Object.freeze({ calls: 4, inputTokens: 32_000, outputTokens: 3600 })
const STATES = ['queued', 'dispatching', 'completed', 'failed', 'uncertain']
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/
const HASH = /^[a-f0-9]{64}$/
const LABEL = /^[a-f0-9-]{36}$/
const METADATA_KEYS = ['candidateSha256', 'hostVersion', 'nodeVersion', 'platform', 'profile', 'prototypeCommit', 'bridgeVersion']
const RECEIPT = 'receipt.json'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const integer = value => Number.isSafeInteger(value) && value >= 0
const identifier = value => typeof value === 'string' && IDENTIFIER.test(value) && !value.includes('://') && !findSecrets(value).length
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function fail(reason) {
  const error = Error(`dream-trial-${reason}`)
  error.code = error.message
  throw error
}

function budget(value, caps, reason) {
  if (!plain(value) || Object.keys(value).length !== Object.keys(caps).length ||
      Object.keys(caps).some(key => !integer(value[key]) || value[key] < 1 || value[key] > caps[key])) fail(reason)
  return Object.fromEntries(Object.keys(caps).map(key => [key, value[key]]))
}

function routeOf(route) {
  if (!plain(route) || Object.keys(route).length !== 2 || !identifier(route.provider) || !identifier(route.model)) fail('invalid-route')
  return { provider: route.provider, model: route.model }
}

function metadataOf(metadata) {
  if (!plain(metadata) || Object.keys(metadata).some(key => !METADATA_KEYS.includes(key)) ||
      Object.values(metadata).some(value => !identifier(value)) ||
      (metadata.candidateSha256 !== undefined && !HASH.test(metadata.candidateSha256)) ||
      (metadata.prototypeCommit !== undefined && !/^[a-f0-9]{40}$/.test(metadata.prototypeCommit))) fail('invalid-metadata')
  return Object.fromEntries(METADATA_KEYS.filter(key => Object.hasOwn(metadata, key)).map(key => [key, metadata[key]]))
}

function matrix() {
  return dreamEvalBatches().flatMap(batch => {
    const messages = dreamReviewMessages(batch.input)
    const inputSha256 = digest(messages)
    return MODES.map(mode => ({ mode, batchId: batch.id, input: batch.input, messages, inputSha256 }))
  })
}

function planFor(jobs, limits, batchCaps) {
  return {
    fixtureVersion: DREAM_REVIEW_FIXTURE_VERSION,
    fixtureSha256: DREAM_REVIEW_FIXTURE_SHA256,
    promptSha256: DREAM_REVIEW_PROMPT_SHA256,
    limits, batchCaps, generation: { maxTokens: Math.min(1800, batchCaps.outputTokens), reasoningEffort: 'off' },
    jobs: jobs.map(({ mode, batchId, inputSha256, input }) => ({ mode, batchId, inputSha256, cases: input.items.length })),
  }
}

function privateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error?.code !== 'EEXIST') throw error }
  const info = lstatSync(path)
  if (!info.isDirectory() || (info.mode & 0o077)) fail('unsafe-directory')
  return realpathSync(path)
}

function readJson(path) {
  let info
  try { info = lstatSync(path) } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error }
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077)) fail('unsafe-receipt')
  try { return JSON.parse(readSafely(path, { maxBytes: 64 * 1024 })) } catch { fail('invalid-receipt') }
}

const storeJson = (path, value) => writeSafely(path, JSON.stringify(value, null, 2) + '\n')

function checkedState(state, signature, jobs, blindDir) {
  if (!plain(state) || state.schema !== 1 || state.signature !== signature || !LABEL.test(state.trialId) ||
      digest({ plan: state.plan, route: state.route, metadata: state.metadata, transportKind: state.transportKind, timeoutMs: state.timeoutMs }) !== signature ||
      !Array.isArray(state.jobs) || state.jobs.length !== jobs.length) fail('resume-mismatch')
  const labels = new Set()
  for (const [index, job] of state.jobs.entries()) {
    const expected = jobs[index]
    if (!plain(job) || job.mode !== expected.mode || job.batchId !== expected.batchId || job.inputSha256 !== expected.inputSha256 ||
        !LABEL.test(job.label) || labels.has(job.label) || !STATES.includes(job.status)) fail('invalid-receipt')
    labels.add(job.label)
    if (job.status === 'queued') {
      if (job.reserved !== undefined || job.usage !== undefined || job.outputSha256 !== undefined) fail('invalid-receipt')
    } else {
      budget(job.reserved, HARD_LIMITS, 'invalid-receipt')
    }
    if (job.status === 'dispatching' && (!Number.isSafeInteger(job.ownerPid) || job.ownerPid < 1)) fail('invalid-receipt')
    if (job.usage !== undefined && !readUsage(job.usage)) fail('invalid-receipt')
    if (job.status === 'completed' && !HASH.test(job.outputSha256)) fail('invalid-receipt')
    if (job.outputSha256 !== undefined) {
      const saved = readJson(join(blindDir, `${job.label}.json`))
      if (!plain(saved) || saved.label !== job.label || saved.batchId !== job.batchId || !Object.hasOwn(saved, 'output') ||
          digest(saved.output) !== job.outputSha256) fail('output-changed')
    }
  }
  return state
}

function readUsage(raw) {
  if (!plain(raw) || !Number.isSafeInteger(raw.calls) || raw.calls < 1 || !integer(raw.inputTokens) || !integer(raw.outputTokens)) return undefined
  return { calls: raw.calls, inputTokens: raw.inputTokens, outputTokens: raw.outputTokens }
}

function totals(state) {
  const used = { calls: 0, inputTokens: 0, outputTokens: 0 }
  let unknownBatches = 0
  for (const job of state.jobs) {
    if (!job.reserved) continue
    const charge = job.usage ?? job.reserved
    if (!job.usage) unknownBatches += 1
    for (const key of Object.keys(used)) used[key] += charge[key]
  }
  return { ...used, unknownBatches }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
}

function waitForTransport(transport, request, signal, timeoutMs) {
  const controller = new AbortController()
  const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(Error('dream-trial-timed-out')), timeoutMs)
  let rejectOnAbort
  const stopped = new Promise((_, reject) => {
    rejectOnAbort = () => reject(linked.reason)
    if (linked.aborted) rejectOnAbort()
    else linked.addEventListener('abort', rejectOnAbort, { once: true })
  })
  return Promise.race([stopped, Promise.resolve().then(() => {
    linked.throwIfAborted()
    return transport.execute({ ...request, signal: linked })
  })]).finally(() => {
    clearTimeout(timer)
    linked.removeEventListener('abort', rejectOnAbort)
  })
}

function safeOutput(value) {
  if (typeof value !== 'string' && !plain(value)) return { issue: 'invalid-output' }
  let raw
  try { raw = typeof value === 'string' ? value : JSON.stringify(value) } catch { return { issue: 'invalid-output' } }
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > DREAM_REVIEW_LIMITS.outputBytes) return { issue: 'invalid-output' }
  let decoded
  try { decoded = JSON.stringify(JSON.parse(raw)) } catch { /* A malformed model response may still be saved. */ }
  if (findSecrets(normalizeText(raw)).length || (decoded && findSecrets(normalizeText(decoded)).length)) return { issue: 'sensitive-output' }
  return { output: typeof value === 'string' ? raw : JSON.parse(raw) }
}

/** A caller-supplied transport must enforce its per-batch budget and report total use, including orchestration. */
export async function runDreamReviewTrial({ dir, route, transport, metadata = {}, limits = HARD_LIMITS, batchCaps = BATCH_CAPS,
  modes = MODES, maxBatches = 4, timeoutMs = 120_000, signal } = {}) {
  const jobs = matrix()
  limits = budget(limits, HARD_LIMITS, 'invalid-limits')
  batchCaps = budget(batchCaps, HARD_LIMITS, 'invalid-batch-caps')
  const plan = planFor(jobs, limits, batchCaps)
  if (transport === undefined) return { status: 'dry-run', semanticTruthEvaluated: false, ...plan }
  if (typeof dir !== 'string' || !dir || !['scripted', 'real-model'].includes(transport?.kind) || typeof transport.execute !== 'function' ||
      !Array.isArray(modes) || !modes.length || !modes.every(mode => MODES.includes(mode)) || new Set(modes).size !== modes.length ||
      !Number.isSafeInteger(maxBatches) || maxBatches < 0 || maxBatches > jobs.length ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) fail('invalid-run-options')
  const requestedRoute = routeOf(route)
  const provenance = metadataOf(metadata)
  const binding = { plan, route: requestedRoute, metadata: provenance, transportKind: transport.kind, timeoutMs }
  const signature = digest(binding)
  const root = privateDirectory(resolve(dir))
  const blindDir = privateDirectory(join(root, 'blind'))
  const receiptPath = join(root, RECEIPT)
  const now = () => new Date().toISOString()

  const transaction = operation => withLock(root, () => {
    const existing = readJson(receiptPath)
    const state = existing === undefined ? {
      schema: 1, signature, trialId: randomUUID(), createdAt: now(), ...binding,
      semanticTruthEvaluated: false, jobs: plan.jobs.map(job => ({ ...job, label: randomUUID(), status: 'queued' })),
    } : checkedState(existing, signature, jobs, blindDir)
    const result = operation(state)
    state.totals = totals(state)
    storeJson(receiptPath, state)
    return { state, result }
  })

  let status = 'paused'
  for (let count = 0; count < maxBatches; count += 1) {
    if (signal?.aborted) break
    const { result: claim } = transaction(state => {
      const active = state.jobs.find(job => job.status === 'dispatching')
      if (active) {
        if (alive(active.ownerPid)) return { reason: 'busy' }
        active.status = 'uncertain'
        active.reason = 'owner-lost'
        delete active.ownerPid
      }
      if (state.jobs.some(job => job.status === 'failed' || job.status === 'uncertain')) return { reason: 'needs-review' }
      const index = state.jobs.findIndex(job => job.status === 'queued' && modes.includes(job.mode))
      if (index === -1) return { reason: 'selection-complete' }
      const spent = totals(state)
      const minimumInput = Buffer.byteLength(JSON.stringify(jobs[index].messages))
      if (batchCaps.inputTokens < minimumInput || Object.keys(limits).some(key => limits[key] - spent[key] < batchCaps[key])) {
        return { reason: 'budget-exhausted' }
      }
      const reserved = { ...batchCaps }
      const job = state.jobs[index]
      Object.assign(job, { status: 'dispatching', reserved, ownerPid: process.pid, startedAt: now() })
      return { index, label: job.label, reserved }
    })
    if (claim.reason) { status = claim.reason; break }

    const job = jobs[claim.index]
    let outcome, uncertain = false
    try {
      outcome = await waitForTransport(transport, { mode: job.mode, runId: claim.label, input: structuredClone(job.input),
        messages: structuredClone(job.messages), route: { ...requestedRoute }, generation: { ...plan.generation },
        budget: { ...claim.reserved } }, signal, timeoutMs)
    } catch { uncertain = true }

    const { result: resultStatus } = transaction(state => {
      const row = state.jobs[claim.index]
      if (row.label !== claim.label || row.ownerPid !== process.pid || row.status !== 'dispatching') fail('claim-changed')
      row.finishedAt = now()
      delete row.ownerPid
      if (uncertain) {
        row.status = 'uncertain'
        row.reason = 'transport-unconfirmed'
        return 'needs-review'
      }
      const usage = readUsage(outcome?.usage)
      if (usage) row.usage = usage
      const routeMatches = outcome?.route?.provider === requestedRoute.provider && outcome?.route?.model === requestedRoute.model
      const checked = safeOutput(outcome?.output)
      const grade = checked.output === undefined ? undefined : gradeDreamReviewBatch(job.batchId, checked.output)
      if (checked.output !== undefined) {
        const outputPath = join(blindDir, `${claim.label}.json`)
        if (readJson(outputPath) !== undefined) fail('output-already-exists')
        storeJson(outputPath, { label: claim.label, batchId: job.batchId, output: checked.output })
        row.outputSha256 = digest(checked.output)
      }
      if (grade) row.structuralValid = grade.structuralValid
      const overBudget = usage && Object.keys(claim.reserved).some(key => usage[key] > claim.reserved[key])
      const reason = checked.issue ?? (!routeMatches ? 'route-mismatch' : !usage ? 'usage-unknown' : overBudget ? 'budget-exceeded' :
        !grade.structuralValid ? 'invalid-output' : undefined)
      row.status = reason ? 'failed' : 'completed'
      if (reason) row.reason = reason
      return reason ? 'needs-review' : 'completed-batch'
    })
    if (resultStatus === 'needs-review') { status = resultStatus; break }
  }
  const { state } = transaction(() => undefined)
  if (state.jobs.every(job => job.status === 'completed')) status = 'complete'
  else if (status === 'paused' && state.jobs.filter(job => modes.includes(job.mode)).every(job => job.status === 'completed')) status = 'selection-complete'
  return { status, receipt: state }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length > 2) {
    process.stderr.write('This command prints the dry plan. Import runDreamReviewTrial to supply a verified transport.\n')
    process.exitCode = 2
  } else {
    process.stdout.write(`${JSON.stringify(await runDreamReviewTrial(), null, 2)}\n`)
  }
}
