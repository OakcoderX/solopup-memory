/** One bounded review cue when a normal DSH turn is ready to close. */
import { randomUUID } from 'node:crypto'
import { captureSessionEligible } from './capture-inputs.mjs'

const SOURCE = 'solopup-delivery-review'

function hasReviewRules(rows) {
  return Array.isArray(rows) && rows.some(row =>
    typeof row?.id === 'string' && row.id.length > 0 &&
    typeof row.text === 'string' && row.text.length > 0)
}

function reviewMessage() {
  // The notice is persisted. Current rules and any later withdrawals remain
  // owned by the live memory projection rather than being copied here.
  const text = [
    'SoloPup 交付复核。一次性插件提示。',
    '按原任务和现行用户约定核对实际产物、测试和示例。',
    '本次适用的已确认约定无需重述。可在已授权范围内补齐普通项目内配套文件，包括新建必要文件。',
    '用户当前的明确要求优先。若需额外授权或范围不清，如实说明遗漏。',
  ].join('\n')
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: SOURCE, form: 'notice', summary: 'SoloPup 交付复核' },
    content: [{ type: 'text', text }],
  }
}

export function installDeliveryReview(ctx, { rulesFor, hasAppliedWork }) {
  const reviewedTurns = new WeakMap()
  let active = true
  ctx.effect?.(() => () => { active = false })
  ctx.on?.('agent/turn-stopping', ({ agent, turn, signal } = {}) => {
    const session = agent?.session
    if (!active || signal?.aborted || !Number.isSafeInteger(turn) || turn < 1 ||
        typeof agent?.steer !== 'function' || !captureSessionEligible(session) ||
        session.header?.origin === 'subagent' || (reviewedTurns.get(session) ?? 0) >= turn) return

    try {
      if (hasAppliedWork(session, turn) !== true) return
      if (!hasReviewRules(rulesFor(session)) || !active || signal?.aborted) return

      // Steering may synchronously publish events. Reserve first so another
      // stopping callback for the same turn cannot open a second review step.
      reviewedTurns.set(session, turn)
      agent.steer(reviewMessage())
    } catch {
      // Optional review must never convert a completed turn into an error.
    }
  })
}
