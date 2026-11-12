import { createHash, randomUUID } from 'node:crypto'
import { buildDreamEvidence, dreamReviewMessages, validateDreamReview } from './dream-review.mjs'
import { createDreamScheduler } from './dream-scheduler.mjs'

const REVIEW_POLICY = 'solopup-project-review-v1'
const MAX_OUTPUT_TOKENS = 1800
const SUPER_AGENT_RESERVE = 8000
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ordinaryReservation = input => Buffer.byteLength(JSON.stringify(dreamReviewMessages(input))) + MAX_OUTPUT_TOKENS + 512
function itemKey(project, record, byId) {
  const related = project.relatedRecordIdsByTarget?.[record.id] ?? []
  const additional = project.additionalEvidenceByTarget?.[record.id] ?? []
  return digest([record.id, record.summary, record.meaning, record.expires, record.evidence,
    related.map(id => byId.get(id) ?? id), additional.map(source => [source.hash, source.occurredAt])])
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
export function createDreamRuntime({ options, queue, readProject, executors, now = Date.now, timers = {} }) {
  const owner = randomUUID()
  const route = { provider: options.provider, model: options.model }
  const dailyTokens = options.maxDailyTokens ?? 12_000
  let last = 'waiting-for-idle', disposed = false, inFlight, checkingControls
  const controlLifetime = new AbortController()

  function select(project, queued) {
    const byId = new Map(project.records.map(record => [record.id, record]))
    const keys = new Map(project.records.map(record => [record.id, itemKey(project, record, byId)]))
    const targetIds = queued ? queued.metadata.itemIds : [...keys.keys()].filter(id => !queue.wasReviewed(project.projectId, keys.get(id)))
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

  function current(path, claim, action) {
    if (!path) throw Error('dream-project-no-longer-authorized')
    return readProject(path, project => {
      if (!project || project.projectId !== claim.projectId) throw Error('dream-project-changed')
      const selected = select(project, claim)
      if (selected?.inputHash !== claim.inputHash) throw Error('dream-evidence-changed')
      return action(selected)
    })
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

  async function process(claim, path, executor, signal) {
    const limit = deadline(signal, options.timeoutMs)
    let dispatched = false, returned = false, completed = false
    let usage, reservedTokens
    try {
      const { input } = current(path, claim, selected => selected)
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
          beforeDispatch: () => {
            limit.signal.throwIfAborted()
            if (dispatched) throw Error('dream-duplicate-dispatch')
            current(path, claim, () => {
              if (!queue.beginDispatch(claim, { reservedTokens })) throw Error('dream-dispatch-not-admitted')
              dispatched = true
            })
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
        items: result.items, usage: usage ?? null,
      }
      const finished = current(path, claim, selected => {
        return queue.finish(claim, {
          status: 'completed', report, reviewedItemKeys: selected.metadata.itemKeys, usedTokens: usage?.totalTokens,
        })
      })
      completed = finished?.status === 'completed'
      last = completed ? 'report-ready' : finished?.status === 'failed' ? 'review-failed' : 'lease-changed'
    } catch (error) {
      if (completed) return
      if (!dispatched && (limit.signal.aborted || error?.message === 'dream-dispatch-not-admitted')) {
        queue.release(claim)
        last = limit.signal.aborted ? 'deferred' : 'dispatch-not-admitted'
        if (!limit.signal.aborted) return { retryAt: queue.nextAutomaticAt({ reservedTokens }) ?? null }
      } else {
        const status = !dispatched || returned ? 'invalidated' : 'uncertain'
        const finished = queue.finish(claim, { status, usedTokens: usage?.totalTokens, confirmedUnsent: !dispatched })
        last = status === 'uncertain' ? 'dispatch-uncertain' : 'review-invalidated'
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
        readProject(path, project => {
          if (project?.projectId !== projectId) return
          const selected = select(project)
          if (!selected) return
          queue.enqueue({ projectId, inputHash: selected.inputHash, policyVersion: REVIEW_POLICY, metadata: selected.metadata })
        })
      }
      for (const [projectId, path] of locations) {
        const claim = queue.claim({ owner, projectId })
        if (!claim) continue
        // A change after the readiness probe may have assigned a different executor.
        if (claim.mode !== state.mode) { queue.release(claim); return { nextAt: now() + 1000 } }
        last = 'running'
        const outcome = await process(claim, path, executor, limit.signal)
        if (outcome?.retryAt === null) return
        return { nextAt: Math.max(now() + 1000, outcome?.retryAt ?? 0) }
      }
      last = locations.size ? 'no-eligible-batch' : 'no-authorized-project'
      const nextAt = queue.nextAutomaticAt()
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

  return {
    scheduler,
    checkControls,
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
