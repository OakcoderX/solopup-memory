import { createHash, randomUUID } from 'node:crypto'
import { buildDreamEvidence, dreamReviewMessages, incompleteDreamReview, validateDreamReview } from './dream-review.mjs'
import { createDreamScheduler } from './dream-scheduler.mjs'
import { planDreamCorrection } from './dream-auto-apply.mjs'

const REVIEW_POLICY = 'solopup-project-review-v4'
const MAX_OUTPUT_TOKENS = 1800
const SUPER_AGENT_RESERVE = 8000
const REPLAY_RETRY_MS = 60_000
const HASH = /^[a-f0-9]{64}$/
const isHash = value => typeof value === 'string' && HASH.test(value)
const reportReason = report => report.reportOnlyReason
const permanentReplayLoss = new Set(['source-replaced', 'source-withdrawn'])
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ordinaryReservation = input => Buffer.byteLength(JSON.stringify(dreamReviewMessages(input))) + MAX_OUTPUT_TOKENS + 512
function itemKey(project, record, byId) {
  const related = project.relatedRecordIdsByTarget?.[record.id] ?? []
  const additional = project.additionalEvidenceByTarget?.[record.id] ?? []
  return digest([record.id, record.summary, record.meaning, record.expires, record.evidence,
    related.map(id => byId.get(id) ?? id), project.replayPointers?.[record.id] ?? additional.map(source => [source.hash, source.occurredAt])])
}

function priority(project, record, invalidEvidence) {
  if (project.replayPointers?.[record.id]?.length || project.additionalEvidenceByTarget?.[record.id]?.length) return 0
  if (project.relatedRecordIdsByTarget?.[record.id]?.length || invalidEvidence) return 1
  return record.fieldLineage?.parentId ? 2 : 3
}

const selectedPointers = (project, ids) => Object.fromEntries(ids.flatMap(id =>
  project.replayPointers?.[id]?.length ? [[id, project.replayPointers[id]]] : []))

/** Show quotes only while this row still resolves to the same authorized evidence. */
export function renderDreamReport(project, run, report, now = Date.now(), { previewChecked = false } = {}) {
  if (!run || !report) return { available: false, reason: 'dream-report-missing' }
  if (project?.projectId !== report.projectId || run.projectId !== project.projectId || run.runId !== report.runId ||
      run.inputHash !== report.inputHash) {
    return { available: false, reason: 'dream-report-project-mismatch' }
  }
  const input = buildDreamEvidence({ ...project, targetIds: run.metadata.itemIds, now })
  const byId = new Map(input.items.map(item => [item.id, item]))
  const origins = new Map()
  for (const record of project.records) {
    for (const source of record.evidence ?? []) {
      origins.set(digest([record.sessionId, source.messageId]), { sessionId: record.sessionId, messageId: source.messageId })
    }
  }
  for (const sources of Object.values(project.additionalEvidenceByTarget ?? {})) {
    for (const source of sources) {
      origins.set(digest([source.sessionId, source.messageId]), { sessionId: source.sessionId, messageId: source.messageId })
    }
  }
  const sameSnapshot = digest(input) === report.inputHash
  const items = report.items.map(row => {
    const item = byId.get(row.id)
    const pointers = project.replayPointers?.[row.id] ?? []
    const pointerDigest = digest(pointers)
    const changedPointers = (previewChecked || project.replayPointers !== undefined) && (row.pointerDigest
      ? row.pointerDigest !== pointerDigest : pointers.length > 0 && !row.historical)
    if (!item || changedPointers || (row.evidenceDigest ? digest(item) !== row.evidenceDigest : !sameSnapshot) ||
        !row.sourceIds.every(id => item.sources.some(source => source.id === id))) {
      if (item && row.historical && !project.additionalEvidenceByTarget) {
        return { id: row.id, state: 'source-recheck-required' }
      }
      return { id: row.id, state: 'evidence-changed' }
    }
    const sources = item.sources.filter(source => row.sourceIds.includes(source.id)).map(source => ({ ...source, ...origins.get(source.id) }))
    const preview = previewChecked && row.verdict === 'propose-correction' && !item.incompleteEvidence &&
      sources.every(source => source.sessionId !== undefined && source.messageId !== undefined)
      ? { id: digest(['solopup-dream-preview-v1', project.projectId, run.runId, run.inputHash, row.id,
          digest(item), digest(row), sources.map(({ id, hash }) => [id, hash]), pointerDigest, project.storeRevision]),
          storeRevision: project.storeRevision, scope: 'project', ...(item.meaning ? { meaning: item.meaning } : {}) } : undefined
    return { ...row, state: 'current', current: item.summary, sources, ...(preview ? { preview } : {}) }
  })
  return { available: true, ...report, items }
}

function deadline(signal, timeoutMs) {
  const controller = new AbortController()
  const linked = AbortSignal.any([signal, controller.signal])
  let onAbort
  const expired = new Promise((_, reject) => {
    onAbort = () => reject(linked.reason)
    linked.addEventListener('abort', onAbort, { once: true })
    if (linked.aborted) onAbort()
  })
  // Some phases pass only the signal to the reader before observing the deadline promise.
  void expired.catch(() => {})
  const timer = setTimeout(() => controller.abort(Error('dream-deadline')), timeoutMs)
  timer.unref?.()
  return {
    signal: linked, expired,
    dispose() {
      clearTimeout(timer)
      linked.removeEventListener('abort', onAbort)
    },
  }
}

/** A backend-independent pipeline. Only trusted host code may provide readProject and executors. */
export function createDreamRuntime({ options, queue, readProject, readReplay, publishCorrection, readApplication, previewWithdrawal,
  currentOwnerActivity = projectId => queue.ownerActivity(projectId), housekeepProject, executors, now = Date.now, timers = {} }) {
  const owner = randomUUID()
  const route = { provider: options.provider, model: options.model }
  const dailyTokens = options.maxDailyTokens ?? 12_000
  let last = 'waiting-for-idle', disposed = false, inFlight, checkingControls
  const controlLifetime = new AbortController()
  const automaticPublication = options.autoApply === true && typeof publishCorrection === 'function' && typeof readApplication === 'function'

  function select(project, queued, targetOverride) {
    const byId = new Map(project.records.map(record => [record.id, record]))
    const withdrawn = new Set(project.withdrawnSourceIds)
    const candidates = project.records.map(record => {
      const key = itemKey(project, record, byId)
      if (queued && queued.policyVersion !== REVIEW_POLICY) return { id: record.id, key }
      const linked = (project.relatedRecordIdsByTarget?.[record.id] ?? []).flatMap(id => byId.get(id)?.sources ?? [])
      const replay = (project.replayPointers?.[record.id] ?? []).map(({ sessionId, seq }) => digest([sessionId, `${sessionId}:${seq}`]))
      const revoked = [...new Set([...linked, ...replay].filter(id => withdrawn.has(id)))].sort()
      return { id: record.id, key: revoked.length ? digest([key, revoked]) : key,
        rank: priority(project, record, revoked.length > 0), date: String(record.createdAt ?? '') }
    })
    const keys = new Map(candidates.map(({ id, key }) => [id, key]))
    let targetIds = queued?.metadata.itemIds ?? targetOverride
    if (targetIds === undefined) {
      const eligible = candidates.filter(({ key }) => !queue.wasReviewed(project.projectId, key))
      if (!eligible.length) return
      const reviewed = queue.reviewedTargets(project.projectId)
      for (const item of eligible) if (reviewed.has(item.id)) item.rank = Math.min(item.rank, 2)
      targetIds = eligible.sort((a, b) => a.rank - b.rank || b.date.localeCompare(a.date, 'en') || a.id.localeCompare(b.id, 'en'))
        .map(({ id }) => id)
    }
    const input = buildDreamEvidence({ ...project, targetIds, now: now() })
    // Fit new batches before they receive an identity. A queued batch is always
    // reconstructed byte-for-byte, including when the executor changes.
    if (!queued) while (input.items.length) {
      const modelItems = input.items.filter(item => !item.incompleteEvidence)
      if (!modelItems.length || ordinaryReservation({ ...input, items: modelItems }) <= Math.min(dailyTokens, 12_000)) break
      input.items.pop()
    }
    if (!input.items.length) return undefined
    const metadata = { itemIds: input.items.map(item => item.id), itemKeys: input.items.map(item => keys.get(item.id)) }
    const legacy = queued && queued.policyVersion !== REVIEW_POLICY
    return { input, metadata, inputHash: digest(legacy ? input : [input, metadata.itemKeys]) }
  }

  function liveProject(path, consume) {
    if (!path) throw Error('dream-project-no-longer-authorized')
    return readProject(path, project => consume(project && {
      ...project, replayPointers: readReplay ? queue.replaySources(project.projectId) : undefined,
    }))
  }

  function projects() {
    const selected = new Map()
    for (const path of options.projects) {
      try {
        readProject(path, project => {
          if (project && !selected.has(project.projectId)) selected.set(project.projectId, path)
        })
      } catch { last = 'project-evidence-unavailable' }
    }
    return selected
  }

  function current(path, claim, action, proof) {
    return liveProject(path, project => {
      if (!project || (claim && project.projectId !== claim.projectId)) throw Error('dream-project-changed')
      if (proof && (project.projectId !== proof.projectId || project.storeRevision !== proof.storeRevision ||
          digest(selectedPointers(project, proof.targetIds)) !== digest(proof.pointers))) throw Error('dream-evidence-changed')
      const checked = proof?.additionalEvidenceByTarget ? { ...project, additionalEvidenceByTarget: proof.additionalEvidenceByTarget } : project
      const selected = select(checked, claim, proof?.targetIds)
      if (claim && selected?.inputHash !== claim.inputHash) throw Error('dream-evidence-changed')
      return action(selected)
    })
  }

  async function prepare(path, claim, signal) {
    const pending = liveProject(path, project => {
      if (!project || (claim && project.projectId !== claim.projectId)) return
      const initial = select(project, claim)
      if (!initial) return
      const targetIds = initial.metadata.itemIds
      return { projectId: project.projectId, storeRevision: project.storeRevision,
        targetIds, pointers: selectedPointers(project, targetIds), withdrawnSourceIds: project.withdrawnSourceIds ?? [] }
    })
    if (!pending) {
      if (claim) throw Error('dream-evidence-changed')
      return
    }
    if (Object.keys(pending.pointers).length) {
      let replay
      try { replay = await readReplay(pending, signal) }
      catch {
        signal.throwIfAborted()
        if (claim) throw Error('dream-replay-deferred')
        return
      }
      signal.throwIfAborted()
      pending.assertReplayCurrent = replay.assertCurrent
      const transient = new Set(Object.keys(pending.pointers).filter(id => {
        const verified = replay.additionalEvidenceByTarget?.[id]
        if (verified?.length === pending.pointers[id].length && verified.every(source => isHash(source?.hash))) return false
        const losses = replay.skips?.filter(skip => skip.targetId === id) ?? []
        return !losses.length || losses.some(skip => !permanentReplayLoss.has(skip.reason))
      }))
      if (transient.size && claim) throw Error('dream-replay-deferred')
      if (claim && claim.policyVersion !== REVIEW_POLICY) {
        if (replay.skips?.some(skip => permanentReplayLoss.has(skip.reason))) throw Error('dream-evidence-changed')
        pending.additionalEvidenceByTarget = replay.additionalEvidenceByTarget
        return current(path, claim, selected => selected && { ...selected, proof: pending }, pending)
      }
      if (transient.size) {
        pending.targetIds = pending.targetIds.filter(id => !transient.has(id))
        for (const id of transient) delete pending.pointers[id]
      }
      pending.additionalEvidenceByTarget = Object.fromEntries(Object.keys(pending.pointers).map(id =>
        [id, replay.additionalEvidenceByTarget?.[id]?.length ? replay.additionalEvidenceByTarget[id] : [{}]]))
    }
    return current(path, claim, selected => selected && { ...selected, proof: pending }, pending)
  }

  async function applyPending(path, receipt, signal, frozen) {
    let result
    try {
      signal.throwIfAborted()
      const existing = readApplication(path, receipt)
      if (existing) result = { recordId: existing.recordId }
      else {
        const run = queue.getRun(receipt.runId), report = queue.report(receipt.runId)
        if (!report || run?.manual || report.projectId !== receipt.projectId) result = { reason: 'report-unavailable' }
        else if (run.owner !== owner) result = { reason: 'runtime-interrupted' }
        else {
          const selected = frozen ?? await prepare(path, run, signal)
          signal.throwIfAborted()
          const plan = selected && planDreamCorrection({ report, ...selected })
          if (!plan || plan.operationId !== receipt.operationId || plan.targetId !== receipt.targetId) result = { reason: 'source-or-target-changed' }
          else result = publishCorrection(path, plan, () => {
            signal.throwIfAborted()
            selected.proof.assertReplayCurrent?.(plan.source)
            const claim = queue.autoApplication(receipt.runId)
            if (claim?.state !== 'pending' || claim.operationId !== plan.operationId ||
                currentOwnerActivity(plan.projectId) !== plan.sourceId) throw Error('dream-auto-claim-changed')
            current(path, run, () => {}, selected.proof)
          })
        }
      }
    } catch (error) {
      if (signal.aborted || error?.code === 'memory-lock-busy' || error?.message === 'publication-needs-recovery') return
      const reason = ['dream-replay-deferred', 'dream-auto-replay-changed'].includes(error?.message) ? 'source-unavailable' : 'source-or-target-changed'
      try {
        const committed = readApplication(path, receipt)
        result = committed ? { recordId: committed.recordId } : { reason }
      } catch { return }
    }
    // Keep the pending intent if updating the queue fails after canonical commit.
    try {
      const recorded = queue.finishAutoApplication(receipt.runId, result)
      if (recorded?.state === 'applied') last = 'correction-applied'
    } catch { /* The next idle pass checks the canonical ledger before a retry. */ }
  }

  async function reconcileRemote(active, method, signal) {
    if (active?.status !== 'uncertain' || !active.remoteBinding) return false
    const executor = executors[active.mode]
    if (typeof executor?.[method] !== 'function') return false
    const limit = deadline(signal, 5000)
    try {
      const receipt = await Promise.race([
        limit.expired,
        executor[method](active.remoteBinding, { signal: limit.signal }),
      ])
      if (disposed || limit.signal.aborted) return false
      const status = { completed: 'invalidated', failed: 'failed', cancelled: 'cancelled' }[receipt?.state]
      if (!status) return false
      return Boolean(queue.resolveUncertain(active.runId, { status, reason: 'verified-remote-terminal' }))
    } catch { return false }
    finally { limit.dispose() }
  }

  async function process(claim, path, executor, signal, projectIds) {
    const limit = deadline(signal, options.timeoutMs)
    let dispatched = false, returned = false, completed = false
    let usage, reservedTokens
    try {
      const { input, proof } = await prepare(path, claim, limit.signal)
      const hasReplay = Object.keys(proof.pointers).length > 0
      let verified = proof, historyChecked = !hasReplay
      const local = new Map(claim.policyVersion === REVIEW_POLICY ? input.items.filter(item => item.incompleteEvidence)
        .map(item => [item.id, incompleteDreamReview(item)]) : [])
      const modelInput = { ...input, items: input.items.filter(item => !local.has(item.id)) }
      const finish = (rows, localOnly = false) => {
        const report = {
          schema: 1, runId: claim.runId, projectId: claim.projectId, mode: claim.mode,
          inputHash: claim.inputHash, storeRevision: input.storeRevision,
          createdAt: new Date(now()).toISOString(), route,
          items: input.items.map(item => ({ ...rows.get(item.id), evidenceDigest: digest(item),
            pointerDigest: digest(proof.pointers[item.id] ?? []),
            ...(claim.policyVersion === REVIEW_POLICY && item.incompleteEvidence ? { reviewMethod: 'evidence-check' } : {}),
            ...(proof.pointers[item.id] ? { historical: true } : {}) })),
          usage: usage ?? null,
        }
        const finished = current(path, claim, selected => {
          const plan = automaticPublication && !localOnly && !claim.manual ? planDreamCorrection({ report, ...selected, proof: verified }) : undefined
          const admitted = plan && currentOwnerActivity(plan.projectId) === plan.sourceId
          if (!admitted) report.reportOnlyReason = options.autoApply !== true ? 'automatic-application-disabled-at-review' :
            !automaticPublication ? 'automatic-application-unavailable' : claim.manual ? 'manual-review' :
              !plan ? 'no-eligible-correction' : 'owner-activity-unverified'
          const result = { report, reviewedItemKeys: selected.metadata.itemKeys,
            ...(admitted ? { autoApplication: { targetId: plan.targetId, operationId: plan.operationId } } : {}) }
          return localOnly ? queue.finishWithoutModel(claim, result) :
            queue.finish(claim, { ...result, status: 'completed', usedTokens: usage?.totalTokens })
        }, verified)
        completed = finished?.status === 'completed'
        last = completed ? 'report-ready' : finished?.status === 'failed' ? 'review-failed' : 'lease-changed'
      }
      if (!modelInput.items.length) {
        if (hasReplay) verified = (await prepare(path, claim, limit.signal)).proof
        limit.signal.throwIfAborted()
        finish(local, true)
        return
      }
      const readiness = await Promise.race([limit.expired,
        Promise.resolve().then(() => executor?.ready({ signal: limit.signal })).catch(() => undefined)])
      limit.signal.throwIfAborted()
      if (!readiness?.ready) {
        queue.release(claim)
        last = claim.mode === 'superagent' ? 'superagent-unavailable' : 'model-unavailable'
        return { retryAt: null }
      }
      const ordinaryReserve = ordinaryReservation(modelInput)
      reservedTokens = claim.mode === 'superagent' ? Math.max(ordinaryReserve, SUPER_AGENT_RESERVE) : ordinaryReserve
      const outcome = await Promise.race([limit.expired, Promise.resolve().then(() => {
        limit.signal.throwIfAborted()
        return executor.execute(modelInput, {
          signal: limit.signal, runId: claim.runId, attempt: claim.attempt, route,
          maxTokens: MAX_OUTPUT_TOKENS, maxTotalTokens: reservedTokens,
          onReceipt: receipt => {
            if (limit.signal.aborted || !dispatched || !receipt?.ticketId ||
              !queue.markRunning(claim, { remoteId: receipt.ticketId, binding: receipt })) throw Error('dream-receipt-stale')
          },
          ...(hasReplay ? { verifyBeforeDispatch: async () => {
            const refreshed = await prepare(path, claim, limit.signal)
            verified = refreshed.proof
            historyChecked = true
          } } : {}),
          beforeModel: async () => {
            if (hasReplay) verified = (await prepare(path, claim, limit.signal)).proof
            limit.signal.throwIfAborted()
            current(path, claim, () => {
              const active = queue.getRun(claim.runId)
              if (!active || active.attempt !== claim.attempt || active.epoch !== claim.epoch ||
                  active.mode !== claim.mode || active.owner !== claim.owner || active.leaseUntil <= now() ||
                  !['dispatching', 'running'].includes(active.status)) throw Error('dream-dispatch-not-admitted')
            }, verified)
          },
          beforeDispatch: () => {
            limit.signal.throwIfAborted()
            if (!historyChecked) throw Error('dream-history-recheck-required')
            if (dispatched) throw Error('dream-duplicate-dispatch')
            current(path, claim, () => {
              if (!queue.beginDispatch(claim, { reservedTokens })) throw Error('dream-dispatch-not-admitted')
              dispatched = true
            }, verified)
          },
        })
      })])
      limit.signal.throwIfAborted()
      if (!dispatched) throw Error('dream-executor-did-not-claim')
      returned = true
      usage = outcome?.usage
      const result = validateDreamReview(modelInput, outcome?.output)
      for (const row of result.items) local.set(row.id, row)
      if (hasReplay) verified = (await prepare(path, claim, limit.signal)).proof
      finish(local)
      if (completed && automaticPublication) {
        const pending = queue.autoApplication(claim.runId)
        if (pending?.state === 'pending') await applyPending(path, pending, limit.signal, { input, proof: verified })
      }
    } catch (error) {
      if (completed) return
      if (!dispatched && (limit.signal.aborted || ['dream-dispatch-not-admitted', 'dream-replay-deferred'].includes(error?.message))) {
        const replayDeferred = error?.message === 'dream-replay-deferred'
        queue.release(claim, { delayMs: replayDeferred ? REPLAY_RETRY_MS : 0 })
        last = limit.signal.aborted || replayDeferred ? 'deferred' : 'dispatch-not-admitted'
        if (!limit.signal.aborted) {
          return { retryAt: queue.nextAutomaticAt({ reservedTokens: replayDeferred ? undefined : reservedTokens, projectIds }) ?? null }
        }
      } else {
        const confirmedUnsent = !dispatched || error?.notDispatched === true
        const status = dispatched && confirmedUnsent ? 'retryable' : !dispatched || returned ? 'invalidated' : 'uncertain'
        const finished = queue.finish(claim, { status, usedTokens: usage?.totalTokens, confirmedUnsent,
          ...(dispatched && confirmedUnsent ? { reason: 'model-unsent' } : {}) })
        last = status === 'uncertain' ? 'dispatch-uncertain' : status === 'retryable' ? 'model-unsent' : 'review-invalidated'
        if (!disposed && status === 'uncertain' && limit.signal.aborted &&
          await reconcileRemote(finished, 'cancel', controlLifetime.signal)) last = 'remote-cancel-confirmed'
      }
    } finally { limit.dispose() }
  }

  async function run({ signal }) {
    const limit = deadline(signal, options.timeoutMs)
    try {
      queue.recover()
      await checkControls()
      limit.signal.throwIfAborted()
      let state = queue.status()
      if (state.active?.status === 'uncertain') {
        if (!await reconcileRemote(state.active, 'status', limit.signal)) {
          last = 'dispatch-uncertain'
          return
        }
        state = queue.status()
      }
      const executor = executors[state.mode]
      const locations = projects()
      const projectIds = [...locations.keys()]
      if (automaticPublication && !state.active) {
        const pending = queue.pendingAutoApplications(projectIds)
        for (const receipt of pending) {
          await applyPending(locations.get(receipt.projectId), receipt, limit.signal)
          limit.signal.throwIfAborted()
        }
        if (pending.length) return { nextAt: now() + (queue.pendingAutoApplications(projectIds).length ? REPLAY_RETRY_MS : 1000) }
      }
      for (const [projectId, path] of locations) {
        limit.signal.throwIfAborted()
        // Preserve a queued batch across reloads and mode changes before forming another.
        if (queue.listQueued({ projectId, limit: 1 }).length) continue
        if (options.autoApply === true && !state.active && typeof housekeepProject === 'function') {
          try { housekeepProject(path) } catch { /* Housekeeping must never bypass normal DREAM read guards. */ }
        }
        const selected = await prepare(path, undefined, limit.signal)
        if (selected?.input.projectId !== projectId) continue
        limit.signal.throwIfAborted()
        current(path, undefined, current => {
          if (current?.inputHash === selected.inputHash) {
            queue.enqueue({ projectId, inputHash: selected.inputHash, policyVersion: REVIEW_POLICY, metadata: selected.metadata })
          }
        }, selected.proof)
      }
      const claim = queue.claim({ owner, projectIds })
      if (claim) {
        // A concurrent mode change may have assigned a different executor.
        if (claim.mode !== state.mode) { queue.release(claim); return { nextAt: now() + 1000 } }
        last = 'running'
        const outcome = await process(claim, locations.get(claim.projectId), executor, limit.signal, projectIds)
        if (outcome?.retryAt === null) return
        return { nextAt: Math.max(now() + 1000, outcome?.retryAt ?? 0) }
      }
      last = locations.size ? 'no-eligible-batch' : 'no-authorized-project'
      const nextAt = queue.nextAutomaticAt({ projectIds })
      return nextAt > now() ? { nextAt } : undefined
    } finally { limit.dispose() }
  }

  const scheduler = createDreamScheduler({
    ...timers, now, idleMs: options.idleMs,
    run(args) {
      inFlight = run(args).finally(() => { inFlight = undefined })
      return inFlight
    },
    onError() { last = 'dream-runtime-unavailable' },
  })

  function checkControls() {
    if (disposed || checkingControls) return checkingControls
    checkingControls = Promise.resolve().then(async () => {
      if (disposed) return
      const request = queue.pendingExecutorRequest()
      if (!request) return
      const limit = deadline(controlLifetime.signal, Math.min(5000, options.timeoutMs))
      let ready = false
      try {
        const result = request.mode === 'superagent' && dailyTokens < SUPER_AGENT_RESERVE
          ? undefined : await Promise.race([limit.expired, executors[request.mode]?.ready({ signal: limit.signal })])
        ready = result?.ready === true
      } catch { /* Preserve the current executor if the requested one is unavailable. */ }
      finally { limit.dispose() }
      if (disposed) return
      if (ready) queue.acceptExecutorRequest(request.id)
      else queue.rejectExecutorRequest(request.id, { reason: 'dream-mode-unavailable' })
      scheduler.wake()
    }).catch(() => { last = 'dream-control-unavailable' }).finally(() => { checkingControls = undefined })
    return checkingControls
  }

  async function openReport(path, runId, signal = controlLifetime.signal, { targetId, expectedPreviewId, withdrawalPreview = false } = {}) {
    const unavailable = reason => ({ available: false, reason })
    const unavailableReason = expectedPreviewId === undefined ? 'dream-report-unavailable' : 'dream-preview-unavailable'
    if (disposed || !path || (runId !== undefined && !isHash(runId)) ||
        (targetId !== undefined && !isHash(targetId)) ||
        (expectedPreviewId !== undefined && (!isHash(expectedPreviewId) || !runId || !targetId)) ||
        typeof withdrawalPreview !== 'boolean' || (withdrawalPreview && !runId)) {
      return unavailable(unavailableReason)
    }
    const linked = AbortSignal.any([signal, controlLifetime.signal])
    try {
      linked.throwIfAborted()
      const authorized = projects()
      const snapshot = liveProject(path, project => {
        if (!project || !authorized.has(project.projectId)) return
        const id = runId ?? queue.listReports({ projectId: project.projectId, limit: 1 })[0]?.runId
        if (!id) return
        const run = queue.getRun(id)
        const report = queue.report(id)
        if (run?.projectId !== project.projectId || !report) return
        const ids = report.items.map(row => row.id)
        return { projectId: project.projectId, storeRevision: project.storeRevision,
          ids, pointers: selectedPointers(project, ids), withdrawnSourceIds: project.withdrawnSourceIds ?? [], run, report }
      })
      if (!snapshot) return unavailable(expectedPreviewId === undefined ? 'dream-report-missing' : unavailableReason)
      let additionalEvidenceByTarget
      if (snapshot.ids.length && readReplay && Object.keys(snapshot.pointers).length) {
        const limit = deadline(linked, Math.min(5000, options.timeoutMs))
        try {
          const replay = await Promise.race([limit.expired, Promise.resolve().then(() => readReplay(snapshot, limit.signal))])
          additionalEvidenceByTarget = replay.additionalEvidenceByTarget
        } finally { limit.dispose() }
      }
      linked.throwIfAborted()
      const result = liveProject(path, project => {
        if (!project || project.projectId !== snapshot.projectId || !queue.report(snapshot.run.runId)) {
          return unavailable(unavailableReason)
        }
        const same = project.storeRevision === snapshot.storeRevision &&
          digest(selectedPointers(project, snapshot.ids)) === digest(snapshot.pointers)
        const checked = same && additionalEvidenceByTarget ? { ...project, additionalEvidenceByTarget } : project
        const rendered = renderDreamReport(checked, snapshot.run, snapshot.report, now(), { previewChecked: same })
        const application = queue.autoApplication(snapshot.run.runId)
        if (application && rendered.available && (targetId === undefined || targetId === application.targetId)) {
          const published = application.state === 'applied' ? readApplication?.(path, application) : undefined
          rendered.autoApplication = { targetId: application.targetId, state: application.state,
            ...(application.reason ? { reason: application.reason } : {}), ...(published ?? {}),
            ...(application.state === 'applied' && !published ? { reason: 'application-evidence-unavailable-or-withdrawn' } : {}) }
        }
        if (!application && rendered.available) rendered.autoApplication = { state: 'report-only',
          reason: ['automatic-application-disabled-at-review', 'automatic-application-unavailable', 'manual-review',
            'no-eligible-correction', 'owner-activity-unverified'].includes(reportReason(snapshot.report))
            ? reportReason(snapshot.report) : 'application-reason-not-recorded' }
        if (targetId === undefined || !rendered.available) return rendered
        const row = rendered.items.find(item => item.id === targetId)
        if (!row) return unavailable(unavailableReason)
        if (expectedPreviewId !== undefined) {
          if (!same) return unavailable(unavailableReason)
          if (row.state === 'evidence-changed' || (row.preview && row.preview.id !== expectedPreviewId)) {
            return unavailable('dream-preview-stale')
          }
          if (!row.preview) return unavailable(unavailableReason)
        }
        return { ...rendered, items: [row] }
      })
      if (withdrawalPreview && result.available) {
        const application = queue.autoApplication(snapshot.run.runId)
        result.withdrawalPreview = application?.state === 'applied' && (targetId === undefined || targetId === application.targetId) &&
          typeof previewWithdrawal === 'function'
          ? previewWithdrawal(path, application) ?? { available: false, reason: 'source-unavailable-or-withdrawn' }
          : { available: false, reason: 'no-applied-correction' }
      }
      return result
    } catch { return unavailable(unavailableReason) }
  }

  return {
    scheduler,
    checkControls,
    openReport,
    resumeAfterDiscard() {
      if (!disposed && last === 'dispatch-uncertain' && !queue.status().active) {
        last = 'waiting-for-idle'
        scheduler.wake()
      }
    },
    status() { return { last, idle: scheduler.status(), ...queue.status() } },
    dispose() {
      disposed = true
      controlLifetime.abort(Error('dream-host-stopping'))
      scheduler.dispose()
      if (inFlight) void inFlight.catch(() => {}).finally(() => queue.close())
      else queue.close()
    },
  }
}
