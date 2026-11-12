import { createHash, randomUUID } from 'node:crypto'
import { DREAM_REVIEW_LIMITS, dreamReviewMessages } from './dream-review.mjs'

export const SUPER_AGENT_DREAM_PROTOCOL = 'solopup-dream-superagent/v1'
export const SUPER_AGENT_DREAM_SERVICE = 'solopupDreamSuperAgent'
export const SUPER_AGENT_DREAM_ISOLATION_SERVICE = 'solopupDreamIsolation'
export const SUPER_AGENT_DREAM_PROTOTYPE = '8c32a9dc5d72c033816c6a8110b37f40cf94fba4'
const SOURCE = 'solopup-dream'
const PROBE_MS = 3000
const MAX_RUN_MS = 180_000
const HASH = /^[a-f0-9]{64}$/
const TICKET = /^[a-f0-9]{32}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const ROUTE_ID = /^[A-Za-z0-9_./:@-]{1,128}$/
const isId = value => typeof value === 'string' && ID.test(value)
const isRouteId = value => typeof value === 'string' && ROUTE_ID.test(value)
const isHash = value => typeof value === 'string' && HASH.test(value)
const natural = value => Number.isSafeInteger(value) && value >= 0
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function failure(code, notDispatched = true) {
  return Object.assign(new Error(code), { code, notDispatched })
}

function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeTree(entry)
    Object.freeze(value)
  }
  return value
}

function withSignal(work, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let result
    try { result = work() } catch (error) { result = Promise.reject(error) }
    Promise.resolve(result).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function combinedSignal(signals, timeout) {
  return AbortSignal.any([...signals.filter(Boolean), AbortSignal.timeout(timeout)])
}

/** Public Source intake shape. Only opaque metadata may reach the router and outbox. */
function localTrigger(binding, now) {
  const thread = digest([SOURCE, binding.runId, String(binding.attempt)]).slice(0, 32)
  return {
    id: digest([SOURCE, thread, 'review']).slice(0, 32),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: 'solopup-runtime' },
    human: false,
    at: new Date(now).toISOString(),
    text: 'Review the prepared project memory evidence in an isolated Worker and return the structured result locally.',
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { runId: binding.runId, attempt: String(binding.attempt) } },
    meta: { runId: binding.runId, attempt: binding.attempt, projectId: binding.projectId, inputDigest: binding.inputDigest },
  }
}

function readProof(raw, challenge) {
  if (raw?.protocol !== SUPER_AGENT_DREAM_PROTOCOL || raw.challenge !== challenge || raw.source !== SOURCE ||
      raw.prototypeCommit !== SUPER_AGENT_DREAM_PROTOTYPE || !isId(raw.runtimeId) || !isId(raw.isolationId)) return undefined
  return freezeTree({ protocol: raw.protocol, challenge, source: SOURCE, prototypeCommit: raw.prototypeCommit,
    runtimeId: raw.runtimeId, isolationId: raw.isolationId })
}

function readBinding(value) {
  if (!isId(value?.runId) || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || !isHash(value.projectId) ||
      !isHash(value.inputDigest) || !isId(value.runtimeId) || !isId(value.isolationId)) return undefined
  return { runId: value.runId, attempt: value.attempt, projectId: value.projectId, inputDigest: value.inputDigest,
    runtimeId: value.runtimeId, isolationId: value.isolationId }
}

function readReceipt(raw, binding, needsWorker = false) {
  const candidate = readBinding(raw)
  if (!candidate || Object.keys(binding).some(key => binding[key] !== candidate[key]) ||
      typeof raw.ticketId !== 'string' || !TICKET.test(raw.ticketId) ||
      ((needsWorker || raw.workerSessionId !== undefined) && raw.workerSessionId !== `worker-${raw.ticketId}`)) return undefined
  return Object.freeze({ ...candidate, ticketId: raw.ticketId,
    ...(raw.workerSessionId === undefined ? {} : { workerSessionId: raw.workerSessionId }) })
}

function readUsage(raw) {
  if (raw === undefined) return undefined
  if (!natural(raw?.inputTokens) || !natural(raw.outputTokens) || !natural(raw.totalTokens) ||
      raw.totalTokens !== raw.inputTokens + raw.outputTokens) throw failure('dream-superagent-invalid-usage', false)
  return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, totalTokens: raw.totalTokens }
}

/**
 * The companion is an explicit, trusted local service, not an installation probe.
 * Its dispatch must bind the isolated Worker before providing the model messages,
 * recheck that binding on Worker start and resume, and count all model calls.
 * The independent verifier must establish real isolation and route/budget controls
 * for that companion. A successful self-reported probe alone grants no access.
 */
export function createSuperAgentDreamExecutor({ getBridge, getIsolation, verifyIsolation, now = Date.now } = {}) {
  function observe(get) {
    try {
      const current = get?.()
      return current && Object.hasOwn(current, 'value') ? current : { value: current }
    } catch { return { value: undefined } }
  }

  function currentIs(state, get) {
    const current = observe(get)
    return !state.signal?.aborted && !current.signal?.aborted && current.value === state.value && current.generation === state.generation
  }

  async function inspect(signal, request) {
    const state = observe(getBridge)
    const isolation = getIsolation && observe(getIsolation)
    const bridge = state.value
    if (!bridge || state.signal?.aborted) throw failure('dream-superagent-bridge-unavailable')
    if (['probe', 'dispatch', 'status', 'cancel'].some(key => typeof bridge[key] !== 'function')) throw failure('dream-superagent-bridge-incompatible')
    const verify = getIsolation && typeof isolation.value?.verify === 'function'
      ? isolation.value.verify.bind(isolation.value) : getIsolation ? undefined : verifyIsolation
    if (typeof verify !== 'function' || isolation?.signal?.aborted) throw failure('dream-superagent-isolation-unverified')
    const live = () => currentIs(state, getBridge) && (!isolation || currentIs(isolation, getIsolation))
    const lifetime = [state.signal, isolation?.signal]
    const challenge = randomUUID()
    const probeSignal = combinedSignal([signal, ...lifetime], PROBE_MS)
    let raw
    try { raw = await withSignal(() => bridge.probe({ protocol: SUPER_AGENT_DREAM_PROTOCOL, challenge, signal: probeSignal }), probeSignal) }
    catch { throw failure('dream-superagent-probe-failed') }
    const proof = readProof(raw, challenge)
    if (!proof) throw failure('dream-superagent-bridge-incompatible')
    let verified
    try { verified = await withSignal(() => verify({ proof, signal: probeSignal, request }), probeSignal) }
    catch { throw failure('dream-superagent-isolation-unverified') }
    if (verified !== true || probeSignal.aborted || !live()) throw failure('dream-superagent-isolation-unverified')
    return { live, lifetime, bridge, proof }
  }

  async function control(method, receipt, { signal } = {}) {
    const binding = readBinding(receipt)
    if (!binding) return { state: 'uncertain' }
    try {
      const { live, lifetime, bridge, proof } = await inspect(signal, freezeTree({ ...binding }))
      if (binding.runtimeId !== proof.runtimeId || binding.isolationId !== proof.isolationId) return { state: 'uncertain' }
      const linked = combinedSignal([signal, ...lifetime], PROBE_MS)
      const result = await withSignal(() => bridge[method](freezeTree(binding), { signal: linked }), linked)
      if (!live() || !['queued', 'running', 'completed', 'cancelled', 'failed', 'uncertain'].includes(result?.state)) return { state: 'uncertain' }
      const actual = readReceipt(result.receipt, binding, result.state === 'completed')
      if (!actual || (receipt.ticketId !== undefined && receipt.ticketId !== actual.ticketId)) return { state: 'uncertain' }
      return { state: result.state, receipt: actual }
    } catch { return { state: 'uncertain' } }
  }

  return {
    async ready({ signal } = {}) {
      try { await inspect(signal); return { ready: true } }
      catch (error) { return { ready: false, reason: error.code ?? 'dream-superagent-bridge-unavailable' } }
    },

    async execute(input, { signal, runId, attempt, route, maxTokens, maxTotalTokens, onReceipt, beforeDispatch } = {}) {
      if (!isId(runId) || !Number.isSafeInteger(attempt) || attempt < 1 || !isRouteId(route?.provider) || !isRouteId(route.model) ||
          !Number.isSafeInteger(maxTokens) || maxTokens < 1 || !Number.isSafeInteger(maxTotalTokens) ||
          maxTotalTokens < maxTokens || maxTotalTokens > 12_000 || typeof beforeDispatch !== 'function') {
        throw failure('dream-superagent-invalid-dispatch')
      }
      let messages
      try { messages = dreamReviewMessages(input) } catch { throw failure('dream-superagent-invalid-evidence') }
      const request = freezeTree({ runId, attempt, projectId: input.projectId,
        inputDigest: digest(input), route: { provider: route.provider, model: route.model },
        maxTokens, maxTotalTokens })
      const { live, lifetime, bridge, proof } = await inspect(signal, request)
      const binding = freezeTree({ runId, attempt, projectId: request.projectId, inputDigest: request.inputDigest,
        runtimeId: proof.runtimeId, isolationId: proof.isolationId })
      const envelope = freezeTree({ protocol: SUPER_AGENT_DREAM_PROTOCOL, proof, binding, trigger: localTrigger(binding, now()),
        messages, route: request.route, maxTokens, maxTotalTokens, maxRunMs: MAX_RUN_MS })
      const linked = combinedSignal([signal, ...lifetime], MAX_RUN_MS)
      if (linked.aborted || !live()) throw failure('dream-superagent-before-dispatch')
      // No await may occur between this authorization check and handing over the evidence.
      const authorization = beforeDispatch()
      if (authorization?.then) {
        Promise.resolve(authorization).catch(() => {})
        throw failure('dream-superagent-before-dispatch-async')
      }
      if (linked.aborted || !live()) throw failure('dream-superagent-before-dispatch')
      let receipt
      let receiptError
      const acceptReceipt = raw => {
        const actual = readReceipt(raw, binding)
        if (linked.aborted || !live() || !actual || (receipt && actual.ticketId !== receipt.ticketId)) {
          receiptError = failure('dream-superagent-invalid-receipt', false)
          throw receiptError
        }
        receipt = actual
        try {
          const persisted = onReceipt?.(actual)
          if (persisted?.then) {
            Promise.resolve(persisted).catch(() => {})
            throw failure('dream-superagent-receipt-persistence', false)
          }
        } catch {
          receiptError = failure('dream-superagent-receipt-persistence', false)
          throw receiptError
        }
      }
      let result
      try { result = await withSignal(() => bridge.dispatch(envelope, { signal: linked, onReceipt: acceptReceipt }), linked) }
      catch { throw receiptError ?? failure('dream-superagent-dispatch-uncertain', false) }
      if (receiptError) throw receiptError
      const final = readReceipt(result?.receipt, binding, true)
      if (linked.aborted || !live() || !final || (receipt && final.ticketId !== receipt.ticketId)) {
        throw failure('dream-superagent-invalid-result-binding', false)
      }
      if (typeof result.output !== 'string' || Buffer.byteLength(result.output) > DREAM_REVIEW_LIMITS.outputBytes) {
        throw failure('dream-superagent-invalid-output', false)
      }
      if (!receipt || final.workerSessionId !== receipt.workerSessionId) acceptReceipt(final)
      if (linked.aborted || !live()) throw failure('dream-superagent-dispatch-uncertain', false)
      const usage = readUsage(result.usage)
      if (usage?.totalTokens > maxTotalTokens) throw failure('dream-superagent-budget-exceeded', false)
      return { output: result.output, usage, receipt: final }
    },

    cancel: (binding, options) => control('cancel', binding, options),
    status: (binding, options) => control('status', binding, options),
  }
}
