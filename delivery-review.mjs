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
    '按现行用户约定核对产物位置与内容（可用 memory_check_delivery）。',
    '自检：必交文件落盘且改动已读回；被替换旧做法已清除、不并列；核查工作区并清理临时或调试文件；确认空输入等边界用例已验证。',
    '可在授权内补齐普通项目文件。用户当前的明确要求优先，超出权限如实说明。',
  ].join('\n')
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: SOURCE, form: 'notice', summary: 'SoloPup 交付复核' },
    content: [{ type: 'text', text }],
  }
}

export function installDeliveryReview(ctx, { rulesFor, hasAppliedWork, hasReferenceContext = () => false }) {
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
      const hasRules = hasReviewRules(rulesFor(session))
      const hasContext = !hasRules && !signal?.aborted && hasReferenceContext(session) === true
      if ((!hasRules && !hasContext) || !active || signal?.aborted) return

      // Steering may synchronously publish events. Reserve first so another
      // stopping callback for the same turn cannot open a second review step.
      reviewedTurns.set(session, turn)
      agent.steer(reviewMessage())
    } catch {
      // Optional review must never convert a completed turn into an error.
    }
  })
}
