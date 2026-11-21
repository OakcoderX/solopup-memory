import { captureSessionEligible } from './capture-inputs.mjs'
import { privateMemory } from './privacy.mjs'
import { findSecrets, normalizeText } from './security.mjs'

const MAX_TEXT_BYTES = 64 * 1024
const MAX_QUERY_CHARS = 4000
const FILE_MUTATION = /^(?:edit|write|apply_patch|file_edit|file_write)$/u
const COMMIT = /(?:^|[;&|]\s*)\s*git\s+commit(?:\s|$)/u
const HEREDOC_REDIRECT_FIRST = /^\s*cat\s+>>?\s*(['"]?)([\p{L}\p{N}_./-]+)\1\s+<<-?\s*['"]?\w+['"]?\s*$/u
const HEREDOC_INPUT_FIRST = /^\s*cat\s+<<-?\s*['"]?\w+['"]?\s+>>?\s*(['"]?)([\p{L}\p{N}_./-]+)\1\s*$/u
const TRANSIENT_PATH = /^\/(?:dev|proc|sys|tmp|var\/tmp|private\/tmp)(?:\/|$)/u
const EDITION_HEADER = /^(?:本轮稿本[：:]|Current edition:)[ \t]*/iu
const EDITION_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._-]{0,79}$/u

function declaredEdition(text) {
  if (!EDITION_HEADER.test(text)) return undefined
  const [first, ...rest] = text.split(/\r?\n/u)
  const header = EDITION_HEADER.exec(first)
  if (!header || rest.some(line => EDITION_HEADER.test(line.trimStart()))) return undefined
  const name = first.slice(header[0].length).trimEnd()
  return EDITION_NAME.test(name) && name === normalizeText(name) ? name : undefined
}

function userTask(message) {
  if (message?.role !== 'user' || message.source?.kind !== 'user' || message.source.principal !== undefined) return {}
  if (!Array.isArray(message.content)) return {}
  const text = message.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').slice(0, MAX_TEXT_BYTES + 1)
  if (!text || Buffer.byteLength(text) > MAX_TEXT_BYTES || privateMemory(text) || findSecrets(text).length) return {}
  const normalized = normalizeText(text).trim()
  const half = MAX_QUERY_CHARS / 2
  const query = normalized.length <= MAX_QUERY_CHARS ? normalized : normalized.slice(0, half) + '\n' + normalized.slice(-half)
  // Inspect the literal first line before normalization or shortening. A quoted
  // example, code block, or second declaration cannot silently select a draft.
  const edition = message.content[0]?.type === 'text' ? declaredEdition(text) : undefined
  return { query, edition }
}

function changesFiles(call) {
  if (FILE_MUTATION.test(call?.name ?? '')) return true
  if (call?.name !== 'bash') return false
  try {
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    if (typeof args?.command !== 'string') return false
    const [firstLine] = args.command.slice(0, 512).split(/\r?\n/u, 1)
    const output = (HEREDOC_REDIRECT_FIRST.exec(firstLine) ?? HEREDOC_INPUT_FIRST.exec(firstLine))?.[2]
    return (args.command.length <= 8192 && COMMIT.test(args.command)) ||
      Boolean(firstLine.length < 512 && output && output !== '.' &&
        !output.split('/').includes('..') && !TRANSIENT_PATH.test(output))
  } catch { return false }
}

/** Retain task text and edit observations only while an owner turn is open. */
export function trackTaskMemory(ctx) {
  const turns = new WeakMap()
  ctx.on('agent/pre-step', (input, next) => {
    const session = input?.agent?.session
    const state = session && turns.get(session)
    if (state && state.turn === input.turn && Array.isArray(input.messages)) {
      // DSH constructs the runtime snapshot before it appends claimed messages
      // as session events. Fix the query before snapshot reconciliation.
      const owners = input.messages.filter(message => message?.source?.kind === 'user')
      if (owners.length) {
        const task = userTask(owners.at(-1))
        state.query = task.query ?? ''
        state.edition = owners.length === 1 && !state.directoryChanged && session.header?.origin !== 'subagent'
          ? task.edition : undefined
      }
    }
    return next()
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    if (!captureSessionEligible(session)) return
    const data = event?.data
    if (event?.type === 'turn/start') {
      turns.set(session, { turn: data?.turn, query: '', pending: new Map(), edited: false })
      return
    }
    if (event?.type === 'turn/end') {
      turns.delete(session)
      return
    }
    const state = turns.get(session)
    if (!state) return
    if (event.type === 'working-directory/change') {
      state.edited = false
      state.edition = undefined
      state.directoryChanged = true
      state.pending.clear()
    }
    if (event.type === 'tool/call' && data?.turn === state.turn && changesFiles(data) && typeof data.callId === 'string') {
      if (state.pending.size < 32) state.pending.set(data.callId, event.seq)
    }
    if (event.type === 'tool/result' && data?.turn === state.turn) {
      const message = data.message
      const seq = state.pending.get(message?.toolCallId)
      if (seq === undefined) return
      state.pending.delete(message.toolCallId)
      if (message.source?.kind === 'tool' && message.source.callId === message.toolCallId &&
          message.role === 'tool' && !message.isError && !data.error && event.surfaceOp === 'append' &&
          event.sourceEventSeqs?.length === 1 && event.sourceEventSeqs[0] === seq) state.edited = true
    }
  })
  ctx.on('session/disposed', session => turns.delete(session))
  return {
    queryFor: session => turns.get(session)?.query ?? '',
    contextFor(session) {
      const edition = turns.get(session)?.edition
      return edition === undefined ? {} : { edition }
    },
    hasAppliedWork: (session, turn) => turns.get(session)?.turn === turn && Boolean(turns.get(session)?.edited),
  }
}
