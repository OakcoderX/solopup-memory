import { createHash } from 'node:crypto'
import { captureSessionEligible } from './capture-inputs.mjs'
import { privateMemory } from './privacy.mjs'
import { findSecrets, normalizeText } from './security.mjs'

const MAX_TEXT_BYTES = 64 * 1024
const MAX_QUERY_CHARS = 4000
const FILE_MUTATION = /^(?:edit|write|apply_patch|file_edit|file_write)$/u
const SHELL_TOOL = /^(?:bash|workspace_bash|shell|run_command|mcp__[a-z0-9_-]+__(?:bash|workspace_bash|shell))$/iu
const MCP_MUTATION = /^mcp__[a-z0-9_-]+__(?:create|update|edit|write|send|post|add|delete|remove|set|patch|put|upsert|move|assign|upgrade|extend|cancel|archive)_[a-z0-9_]+$/iu
const COMMIT = /(?:^|[;&|]\s*)\s*git\s+commit(?:\s|$)/u
const LEADING_CD = /^\s*cd\s+(?:(?:'[^']*'|"[^"]*"|[^\s;&|]+))\s*&&\s*/u
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
  const name = call?.name ?? ''
  if (FILE_MUTATION.test(name) || MCP_MUTATION.test(name)) return true
  if (!SHELL_TOOL.test(name)) return false
  try {
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    if (typeof args?.command !== 'string') return false
    const [rawFirstLine] = args.command.slice(0, 512).split(/\r?\n/u, 1)
    const firstLine = rawFirstLine.replace(LEADING_CD, '')
    const output = (HEREDOC_REDIRECT_FIRST.exec(firstLine) ?? HEREDOC_INPUT_FIRST.exec(firstLine))?.[2]
    return (args.command.length <= 8192 && COMMIT.test(args.command)) ||
      Boolean(firstLine.length < 512 && output && output !== '.' &&
        !output.split('/').includes('..') && !TRANSIENT_PATH.test(output))
  } catch { return false }
}

const HASH = /^[a-f0-9]{64}$/u
const WRITE_STATES = ['recorded', 'duplicate', 'pending-review', 'rejected', 'not-applied']
const FILE_STATES = ['matched', 'mismatch', 'record-unavailable', 'rule-unavailable',
  'context-needed', 'not-applicable', 'reference-unavailable', 'unsafe-path', 'too-large',
  'changed', 'invalid-text', 'missing', 'unavailable']
const MAX_RECEIPT_ROWS = 6
const isScope = value => value === 'project' || value === 'global'
const isHash = value => typeof value === 'string' && HASH.test(value)
const isPosition = value => Number.isSafeInteger(value) && value >= 0

function nativeResultDigest(message) {
  if (!Array.isArray(message.content) || !message.content.length ||
      message.content.length > 32 || message.content.some(block => block?.type !== 'text' ||
        typeof block.text !== 'string' || block.text.length > MAX_TEXT_BYTES)) return undefined
  const payload = JSON.stringify(message.content.map(block => block.text))
  if (Buffer.byteLength(payload) <= MAX_TEXT_BYTES) return createHash('sha256').update(payload).digest('hex')
}

/** Retain task text only while an owner turn is open. Receipts retain evidence metadata through the next turn. */
export function trackTaskMemory(ctx, {
  workspaceFor = session => ctx.workingDirectory?.get?.(session) ?? session?.header?.cwd,
  trackContext = true,
} = {}) {
  const turns = new WeakMap(), completed = new WeakMap()
  function workspace(session) {
    try {
      const value = workspaceFor(session)
      if (typeof value === 'string' && value) return value
    } catch { /* The receipt stays unavailable when the workspace cannot be established. */ }
  }
  function freshReceipt(turn) {
    return { turn, writes: [], sources: [], delivery: [], truncated: false }
  }
  function append(receipt, kind, item) {
    const list = receipt[kind]
    if (JSON.stringify(list.at(-1)) === JSON.stringify(item)) return
    if (list.length === MAX_RECEIPT_ROWS) {
      list.shift()
      receipt.truncated = true
    }
    list.push(item)
  }
  function receiptState(session, state = turns.get(session)) {
    return state?.receipt && state.workspace === workspace(session) ? state : undefined
  }
  if (trackContext) ctx.on('agent/pre-step', (input, next) => {
    const session = input?.agent?.session
    const state = session && turns.get(session)
    if (state && state.turn === input.turn && Array.isArray(input.messages)) {
      state.step = isPosition(input.step) ? input.step : undefined
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
  function event(session, event) {
    if (!captureSessionEligible(session)) return
    const data = event?.data
    if (event?.type === 'turn/start') {
      const currentWorkspace = workspace(session)
      turns.set(session, { turn: data?.turn, query: '', pending: new Map(), edited: false, workspace: currentWorkspace,
        receipt: currentWorkspace && isPosition(data?.turn) ? freshReceipt(data.turn) : undefined })
      return
    }
    if (event?.type === 'turn/end') {
      const current = receiptState(session)
      if (current && (data?.turn === undefined || current.turn === data.turn)) completed.set(session, current)
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
      completed.delete(session)
      state.workspace = workspace(session)
      state.receipt = state.workspace && isPosition(state.turn) ? freshReceipt(state.turn) : undefined
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
          event.sourceEventSeqs?.length === 1 && event.sourceEventSeqs[0] === seq) {
        state.edited = true
        const sha256 = receiptState(session, state) && nativeResultDigest(message)
        if (sha256 && isPosition(event.seq) && event.seq > seq) {
          append(state.receipt, 'delivery', { kind: 'tool-result-observed', status: 'succeeded', seq: event.seq, sha256 })
        }
      }
    }
  }
  return {
    event,
    disposeSession(session) {
      turns.delete(session)
      completed.delete(session)
    },
    queryFor: session => turns.get(session)?.query ?? '',
    contextFor(session) {
      const edition = turns.get(session)?.edition
      return edition === undefined ? {} : { edition }
    },
    hasAppliedWork: (session, turn) => turns.get(session)?.turn === turn && Boolean(turns.get(session)?.edited),
    observeContext(session, sha256, rules) {
      const current = receiptState(session)
      if (!current || !isPosition(current.step) || !isHash(sha256)) return
      const consistent = rules.filter(rule => isHash(rule.id) && isScope(rule.scope) &&
        ['applicable', 'unknown'].includes(rule.applicability)).slice(0, 4)
      current.receipt.context = { phase: 'request-validated', step: current.step, sha256,
        rules: consistent.map(({ id: recordId, scope, applicability }) => ({ recordId, scope, applicability })) }
    },
    begin(session) {
      const initial = receiptState(session)
      if (!initial) return
      const captured = initial.receipt
      function add(kind, item) {
        if (receiptState(session)?.receipt === captured) append(captured, kind, item)
      }
      return {
        write(scope, value) {
          if (!isScope(scope) || !WRITE_STATES.includes(value?.status)) return
          const item = { scope, status: value.status }
          if (['recorded', 'duplicate'].includes(value.status) && isHash(value.recordId)) item.recordId = value.recordId
          if (value.status === 'pending-review' && isHash(value.candidateId)) item.candidateId = value.candidateId
          add('writes', item)
        },
        source(value) {
          if (value?.status !== 'verified' || !isScope(value.scope) || !isHash(value.recordId)) return
          const pointers = value.sources.slice(0, 3).flatMap(({ sha256, seq }) =>
            isHash(sha256) && isPosition(seq) ? [{ sha256, seq }] : [])
          if (pointers.length) add('sources', { recordId: value.recordId, scope: value.scope, pointers })
        },
        file(value) {
          if (!isHash(value?.recordId) || !FILE_STATES.includes(value.status)) return
          if (['matched', 'mismatch'].includes(value.status) && !isHash(value.sha256)) return
          add('delivery', { kind: 'file-checked', status: value.status, recordId: value.recordId,
            ...(isHash(value.sha256) ? { sha256: value.sha256 } : {}) })
        },
      }
    },
    receiptFor(session, view) {
      const state = view === 'previous' ? receiptState(session, completed.get(session) ?? null) : receiptState(session)
      if (!state) return { status: 'unavailable' }
      return { status: 'observed', view, ...structuredClone(state.receipt) }
    },
  }
}

// The DSH tool schema uses a JSON Schema subset. Runtime collection enforces bounds.
const digestSchema = { type: 'string' }
const scopeSchema = { type: 'string', enum: ['project', 'global'] }
const list = (properties, required) => ({ type: 'array',
  items: { type: 'object', additionalProperties: false, properties, required } })
const seqSchema = { type: 'integer' }

export function defineMemoryReceiptTool(tracker) {
  return {
    name: 'memory_receipt',
    description: '查看当前或上一轮同工作区的记忆与交付回执。request-validated 表示宿主准备的请求通过当前记忆校验。文件检查是当时读取的结果，工具结果记录只表示工具返回。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      view: { type: 'string', enum: ['current', 'previous'] },
    } },
    output: { schema: { type: 'object', additionalProperties: false, required: ['status'], properties: {
      status: { type: 'string', enum: ['observed', 'unavailable'] },
      view: { type: 'string', enum: ['current', 'previous'] }, turn: seqSchema, truncated: { type: 'boolean' },
      context: { type: 'object', additionalProperties: false, required: ['phase', 'step', 'sha256', 'rules'], properties: {
        phase: { type: 'string', const: 'request-validated' }, step: seqSchema, sha256: digestSchema,
        rules: list({ recordId: digestSchema, scope: scopeSchema,
          applicability: { type: 'string', enum: ['applicable', 'unknown'] } }, ['recordId', 'scope', 'applicability']),
      } },
      writes: list({ scope: scopeSchema, status: { type: 'string', enum: WRITE_STATES },
        recordId: digestSchema, candidateId: digestSchema }, ['scope', 'status']),
      sources: list({ recordId: digestSchema, scope: scopeSchema,
        pointers: list({ sha256: digestSchema, seq: seqSchema }, ['sha256', 'seq']) }, ['recordId', 'scope', 'pointers']),
      delivery: list({ kind: { type: 'string', enum: ['file-checked', 'tool-result-observed'] },
        status: { type: 'string', enum: [...FILE_STATES, 'succeeded'] }, recordId: digestSchema,
        seq: seqSchema, sha256: digestSchema }, ['kind', 'status']),
    } }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute(args, exec) {
      const { view = 'current' } = args ?? {}
      if (!['current', 'previous'].includes(view) || Object.keys(args ?? {}).some(key => key !== 'view')) return { status: 'unavailable' }
      return tracker.receiptFor(exec?.agent?.session, view)
    },
  }
}
