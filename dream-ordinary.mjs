import { chunkText, selectCaptureControls } from './capture-llm.mjs'
import { dreamReviewMessages } from './dream-review.mjs'

const MAX_RESPONSE_BYTES = 16 * 1024
const bound = number => Number.isSafeInteger(number) && number >= 0

function tokenUsage(usage) {
  if (!bound(usage?.inputTokens) || !bound(usage?.outputTokens)) return undefined
  const totalTokens = usage.inputTokens + usage.outputTokens
  return bound(totalTokens) ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens } : undefined
}

/** Ordinary DSH uses the host model service without creating or continuing a user session. */
export function createOrdinaryDreamExecutor({ getLlm }) {
  return {
    ready() {
      const state = getLlm()
      const ready = !state?.signal?.aborted && typeof state?.value?.prepareCall === 'function'
      return ready ? { ready } : { ready, reason: 'dream-model-service-unavailable' }
    },
    async execute(input, { signal, runId, route, maxTokens, beforeDispatch, verifyBeforeDispatch }) {
      const state = getLlm()
      if (typeof state?.value?.prepareCall !== 'function') throw Error('dream-model-service-unavailable')
      const linkedSignal = state.signal ? AbortSignal.any([signal, state.signal]) : signal
      linkedSignal.throwIfAborted()
      const [system, ...messages] = dreamReviewMessages(input)
      const call = await state.value.prepareCall({ ...route, maxTokens, reasoningEffort: 'off' }, linkedSignal, selectCaptureControls)
      if (verifyBeforeDispatch) await verifyBeforeDispatch()
      linkedSignal.throwIfAborted()
      beforeDispatch()
      linkedSignal.throwIfAborted()
      const stream = call.stream({
        ...call.config,
        system: system.content.map(part => part.text).join('\n'),
        messages,
        tools: [],
        purpose: 'memory-dream-review',
        sessionId: 'memory-dream-' + runId,
        signal: linkedSignal,
      })
      let text = '', bytes = 0, usage
      for await (const chunk of stream) {
        linkedSignal.throwIfAborted()
        if (chunk?.type === 'finish') {
          if (['error', 'aborted', 'max-tokens'].includes(chunk.reason?.kind)) throw Error('dream-model-incomplete')
          usage = tokenUsage(chunk.usage) ?? usage
        }
        if (chunk?.type === 'usage') usage = tokenUsage(chunk.usage) ?? usage
        const delta = chunkText(chunk)
        bytes += Buffer.byteLength(delta)
        if (bytes > MAX_RESPONSE_BYTES) throw Error('dream-model-response-too-large')
        text += delta
      }
      linkedSignal.throwIfAborted()
      return { output: text, usage }
    },
  }
}
