import { createHash, randomUUID } from 'node:crypto'
import { buildDreamEvidence, dreamReviewMessages, validateDreamReview } from './dream-review.mjs'
import { createDreamScheduler } from './dream-scheduler.mjs'

const REVIEW_POLICY = 'solopup-project-review-v3'
const MAX_OUTPUT_TOKENS = 1800
const SUPER_AGENT_RESERVE = 8000
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ordinaryReservation = input => Buffer.byteLength(JSON.stringify(dreamReviewMessages(input))) + MAX_OUTPUT_TOKENS + 512
function itemKey(project, record, byId) {
  const related = project.relatedRecordIdsByTarget?.[record.id] ?? []
  const additional = project.additionalEvidenceByTarget?.[record.id] ?? []
  return digest([record.id, record.summary, record.meaning, record.expires, record.evidence,
    related.map(id => byId.get(id) ?? id), project.replayPointers?.[record.id] ?? additional.map(source => [source.hash, source.occurredAt])])
}

const selectedPointers = (project, ids) => Object.fromEntries(ids.flatMap(id =>
  project.replayPointers?.[id]?.length ? [[id, project.replayPointers[id]]] : []))

/** Show quotes only while this row still resolves to the same authorized evidence. */
export function renderDreamReport(project, run, report, now = Date.now()) {
  if (!run || !report) return { available: false, reason: 'dream-report-missing' }
  if (project?.projectId !== report.projectId || run.projectId !== project.projectId) {
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
    if (!item || (row.evidenceDigest ? digest(item) !== row.evidenceDigest : !sameSnapshot) ||
        !row.sourceIds.every(id => item.sources.some(source => source.id === id))) {
      if (item && row.historical && !project.additionalEvidenceByTarget) {
        return { id: row.id, state: 'source-recheck-required' }
      }
      return { id: row.id, state: 'evidence-changed' }
    }
    const sources = item.sources.filter(source => row.sourceIds.includes(source.id)).map(source => ({ ...source, ...origins.get(source.id) }))
    return { ...row, state: 'current', current: item.summary, sources }
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
export function createDreamRuntime({ options, queue, readProject, readReplay, executors, now = Date.now, timers = {} }) {
  const owner = randomUUID()
  const route = { provider: options.provider, model: options.model }
  const dailyTokens = options.maxDailyTokens ?? 12_000
  let last = 'waiting-for-idle', disposed = false, inFlight, checkingControls
  const controlLifetime = new AbortController()

  function select(project, queued, targetOverride) {
    const byId = new Map(project.records.map(record => [record.id, record]))
    const keys = new Map(project.records.map(record => [record.id, itemKey(project, record, byId)]))
    const preferred = [...new Set([...Object.keys(project.replayPointers ?? {}), ...keys.keys()])]
    const targetIds = queued?.metadata.itemIds ?? targetOverride ?? preferred.filter(id =>
      keys.has(id) && !queue.wasReviewed(project.projectId, keys.get(id)))
    const input = buildDreamEvidence({ ...project, targetIds, now: now() })
    // Fit new batches before they receive an identity. A queued batch is always
    // reconstructed byte-for-byte, including when the executor changes.
    if (!queued) while (input.items.length && ordinaryReservation(input) > Math.min(dailyTokens, 12_000)) input.items.pop()
    if (!input.items.length) return undefined
    return {
      input,
      metadata: {
        itemIds: input.items.map(item => item.id),
        itemKeys: input.items.map(item => keys.get(item.id)),
      },
      inputHash: digest(input),
    }
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
      const replay = await readReplay(pending, signal)
      signal.throwIfAborted()
      pending.additionalEvidenceByTarget = replay.additionalEvidenceByTarget
    }
    return current(path, claim, selected => selected && { ...selected, proof: pending }, pending)
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
      const ordinaryReserve = ordinaryReservation(input)
      reservedTokens = claim.mode === 'superagent' ? Math.max(ordinaryReserve, SUPER_AGENT_RESERVE) : ordinaryReserve
      const outcome = await Promise.race([limit.expired, Promise.resolve().then(() => {
        limit.signal.throwIfAborted()
        return executor.execute(input, {
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
      const result = validateDreamReview(input, outcome?.output)
      const report = {
        schema: 1, runId: claim.runId, projectId: claim.projectId, mode: claim.mode,
        inputHash: claim.inputHash, storeRevision: input.storeRevision,
        createdAt: new Date(now()).toISOString(), route,
        items: result.items.map(row => ({ ...row, evidenceDigest: digest(input.items.find(item => item.id === row.id)),
          ...(proof.pointers[row.id] ? { historical: true } : {}) })),
        usage: usage ?? null,
      }
      if (hasReplay) verified = (await prepare(path, claim, limit.signal)).proof
      const finished = current(path, claim, selected => {
        return queue.finish(claim, {
          status: 'completed', report, reviewedItemKeys: selected.metadata.itemKeys, usedTokens: usage?.totalTokens,
        })
      }, verified)
      completed = finished?.status === 'completed'
      last = completed ? 'report-ready' : finished?.status === 'failed' ? 'review-failed' : 'lease-changed'
    } catch (error) {
      if (completed) return
      if (!dispatched && (limit.signal.aborted || error?.message === 'dream-dispatch-not-admitted')) {
        queue.release(claim)
        last = limit.signal.aborted ? 'deferred' : 'dispatch-not-admitted'
        if (!limit.signal.aborted) return { retryAt: queue.nextAutomaticAt({ reservedTokens, projectIds }) ?? null }
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
      const readiness = await Promise.race([limit.expired, Promise.resolve().then(() => executor?.ready({ signal: limit.signal }))])
      limit.signal.throwIfAborted()
      if (!readiness?.ready) { last = state.mode === 'superagent' ? 'superagent-unavailable' : 'model-unavailable'; return }
      const locations = projects()
      for (const [projectId, path] of locations) {
        limit.signal.throwIfAborted()
        // Preserve a queued batch across reloads and mode changes before forming another.
        if (queue.listQueued({ projectId, limit: 1 }).length) continue
        const selected = await prepare(path, undefined, limit.signal)
        if (selected?.input.projectId !== projectId) continue
        limit.signal.throwIfAborted()
        current(path, undefined, current => {
          if (current?.inputHash === selected.inputHash) {
            queue.enqueue({ projectId, inputHash: selected.inputHash, policyVersion: REVIEW_POLICY, metadata: selected.metadata })
          }
        }, selected.proof)
      }
      const projectIds = [...locations.keys()]
      const claim = queue.claim({ owner, projectIds })
      if (claim) {
        // A change after the readiness probe may have assigned a different executor.
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

  async function openReport(path, runId, signal = controlLifetime.signal) {
    const unavailable = reason => ({ available: false, reason })
    if (disposed || !path || (runId !== undefined && (typeof runId !== 'string' || !/^[a-f0-9]{64}$/.test(runId)))) {
      return unavailable('dream-report-unavailable')
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
        const ids = report.items.filter(row => row.historical).map(row => row.id)
        return { projectId: project.projectId, storeRevision: project.storeRevision,
          ids, pointers: selectedPointers(project, ids), withdrawnSourceIds: project.withdrawnSourceIds ?? [], run, report }
      })
      if (!snapshot) return unavailable('dream-report-missing')
      let additionalEvidenceByTarget
      if (snapshot.ids.length && readReplay && Object.keys(snapshot.pointers).length) {
        const limit = deadline(linked, Math.min(5000, options.timeoutMs))
        try {
          const replay = await Promise.race([limit.expired, Promise.resolve().then(() => readReplay(snapshot, limit.signal))])
          additionalEvidenceByTarget = replay.additionalEvidenceByTarget
        } finally { limit.dispose() }
      }
      linked.throwIfAborted()
      return liveProject(path, project => {
        if (!project || project.projectId !== snapshot.projectId || !queue.report(snapshot.run.runId)) {
          return unavailable('dream-report-unavailable')
        }
        const same = project.storeRevision === snapshot.storeRevision &&
          digest(selectedPointers(project, snapshot.ids)) === digest(snapshot.pointers)
        const checked = same && additionalEvidenceByTarget ? { ...project, additionalEvidenceByTarget } : project
        return renderDreamReport(checked, snapshot.run, snapshot.report, now())
      })
    } catch { return unavailable('dream-report-unavailable') }
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
