import { isAbsolute } from 'node:path'
import { transcriptSourceContext } from './dream-transcripts.mjs'
import { optionalService } from './host-services.mjs'
import { privateMemory } from './privacy.mjs'
import { escapeFraming, findSecrets, normalizeText } from './security.mjs'

const MAX_SESSIONS = 40
const MAX_RESULTS = 3
const MAX_EVENTS = 4096
const MAX_STORED_BYTES = 8 * 1024 * 1024
const MAX_MESSAGE_CHARS = 64 * 1024
const MAX_EXCERPT_CHARS = 700
const MAX_EXCERPTS = 9
const MAX_RESULT_CHARS = 2600
const TIMEOUT_MS = 5000
const SKIP_CODES = new Set([
  'workspace-history-stat-unavailable', 'workspace-history-stored-cap', 'workspace-history-event-cap',
  'dream-transcripts-source-changed', 'dream-transcripts-unknown-surface', 'dream-transcripts-event-cap',
  'dream-transcripts-workspace-unavailable', 'SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_QUERY_SOURCE_CONFLICT',
  'SESSION_QUERY_PERSISTENCE_FAILED', 'SESSION_QUERY_CORRUPT_SESSION', 'SESSION_QUERY_INVALID_SURFACE',
])

function ownerSession(header) {
  return typeof header?.cwd === 'string' && isAbsolute(header.cwd) && header.isSeeded === false &&
    header.parentSession === undefined && header.origin !== 'subagent' &&
    (header.delegationDepth === undefined || header.delegationDepth === 0)
}

function callerCwd(ctx, session) {
  if (!ownerSession(session?.header) || session.header.id !== session.id) return undefined
  const cwd = optionalService(ctx, 'workingDirectory')?.get(session)
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined
}

export function workspaceHistoryAvailable(ctx) {
  const source = optionalService(ctx, 'sessionQuery')
  return typeof source?.filterSessions === 'function' && typeof source?.inspectSession === 'function' &&
    typeof optionalService(ctx, 'workingDirectory')?.get === 'function'
}

function sourceId(event) {
  const message = event.data?.message ?? event.data
  return typeof message?.id === 'string' && message.id.length <= 300 ? message.id : undefined
}

function messageRole(event) {
  const message = event.data?.message ?? event.data
  const source = message?.source
  if (event.type === 'user/message' && message?.role === 'user' &&
      ['user', 'user-rpc'].includes(source?.kind) && source.principal === undefined) return 'user'
  if (event.type === 'assistant/message' && message?.role === 'assistant' && source?.kind === 'model') return 'assistant'
}

function safeBody(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_MESSAGE_CHARS) return undefined
  const text = normalizeText(value).trim()
  return text && !privateMemory(value) && !privateMemory(text) &&
    !findSecrets(value).length && !findSecrets(text).length ? text : undefined
}

function messageBody(event) {
  const message = event.data?.message ?? event.data
  if (!Array.isArray(message?.content) || message.content.length > 64) return undefined
  return safeBody(message.content.flatMap(block =>
    block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n'))
}

function excerpt(row, limit) {
  const { seq, messageId, time, role, text, matchAt } = row
  const start = matchAt < limit ? 0 : Math.max(0, matchAt - Math.floor(limit / 3))
  const end = Math.min(start + limit, text.length)
  return { seq, messageId, occurredAt: new Date(time).toISOString(), role,
    text: escapeFraming(text.slice(start, end)), matched: matchAt >= 0,
    ...(start > 0 || end < text.length ? { truncated: true } : {}) }
}

function selectExcerpts(messages) {
  const ranked = new Map()
  const add = (row, rank) => {
    if (!row || (row.matchAt < 0 && /^(?:继续(?:上次)?|接着|请继续|continue)[。！!\s]*$/iu.test(row.text))) return
    const previous = ranked.get(row.text)
    if (!previous || rank > previous.rank || (rank === previous.rank && row.seq > previous.row.seq)) {
      ranked.set(row.text, { rank, row })
    }
  }
  for (const [i, anchor] of messages.entries()) {
    if (anchor.matchAt < 0) continue
    add(anchor, anchor.role === 'user' ? 4 : 3)
    // Include the exchange and nearby owner follow-up even when they omit the title.
    const around = messages.slice(Math.max(0, i - 5), i + 9).filter(row => row.segment === anchor.segment && row !== anchor)
    const before = around.filter(row => row.seq < anchor.seq)
    const after = around.filter(row => row.seq > anchor.seq)
    if (anchor.role === 'assistant') {
      add(before.findLast(row => row.role === 'user'), 4)
      add(before.findLast(row => row.role === 'assistant'), 3)
    }
    add(before.findLast(row => row.matchAt >= 0 && row.role === 'assistant'), 2)
    for (const row of after.filter(row => row.role === 'user').slice(0, 2)) add(row, 4)
    add(after.find(row => row.role === 'assistant'), 2)
  }

  const selected = []
  let remaining = MAX_RESULT_CHARS
  const rankedRows = [...ranked.values()].sort((a, b) => b.rank - a.rank || b.row.seq - a.row.seq)
  // Keep a direct body match to show why this conversation was selected.
  const anchor = rankedRows.find(({ row }) => row.matchAt >= 0)
  if (!anchor) return []
  for (const { row } of [anchor, ...rankedRows.filter(candidate => candidate !== anchor)]) {
    if (remaining < 120 || selected.length === MAX_EXCERPTS) break
    const item = excerpt(row, Math.min(remaining, MAX_EXCERPT_CHARS))
    remaining -= item.text.length
    selected.push(item)
  }
  return selected.sort((a, b) => a.seq - b.seq)
}

function inspectConversation(previous, sessionId, cwd, pattern, allowSource, signal) {
  const { header } = previous
  if (!ownerSession(header) || header.id !== sessionId || header.cwd !== cwd || previous.inheritedEventCount !== 0) return undefined
  if (!Number.isSafeInteger(previous.seq) || previous.seq < 0 || previous.seq > MAX_EVENTS) throw Error('workspace-history-event-cap')
  const events = Array.from({ length: previous.seq }, (_, seq) => previous.eventAt(seq))
  const indices = new Set(events.flatMap(event => messageRole(event) ? [event.seq] : []))
  const { dirs, replaced } = transcriptSourceContext(events, indices, header)
  let title
  let segment = 0
  let isOwnerExchange = false
  const messages = []
  for (const event of events) {
    signal.throwIfAborted()
    if (event.type === 'working-directory/change') {
      segment++
      isOwnerExchange = false
    }
    if (event.type === 'session/title' && !segment) title = event.data?.title
    const role = messageRole(event)
    if (event.type === 'user/message' && (event.data?.message ?? event.data)?.source?.principal !== undefined) {
      segment++
      isOwnerExchange = false
    }
    if (!role || dirs.get(event.seq) !== cwd || replaced.has(event.seq) ||
        !Number.isSafeInteger(event.time) || event.time < 0 || event.time > 8_640_000_000_000_000) continue
    const messageId = sourceId(event)
    const usable = messageId && (!allowSource || allowSource({ sessionId, messageId, seq: event.seq }))
    const text = usable ? messageBody(event) : undefined
    if (role === 'user') {
      isOwnerExchange = Boolean(text)
      if (!isOwnerExchange) segment++
    }
    if (!text || !isOwnerExchange) continue
    const match = pattern.exec(text)
    messages.push({ seq: event.seq, messageId, time: event.time, role, text, matchAt: match?.index ?? -1, segment })
  }
  const excerpts = selectExcerpts(messages)
  if (!excerpts.length) return undefined
  const displayTitle = safeBody(title)
  return { sessionId, title: displayTitle ? escapeFraming(displayTitle.slice(0, 160)) : undefined, excerpts }
}

function phrasePattern(query) {
  if (typeof query !== 'string') return undefined
  const text = normalizeText(query).trim()
  if (!text || text.length > 200 || !/[\p{L}\p{N}]/u.test(text)) return undefined
  const words = text.split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  return new RegExp(words.join('\\s+'), 'iu')
}

/** Search exact-time host observations of prior sessions. Only selected excerpts leave this adapter. */
export async function searchWorkspaceHistory(ctx, { session, query, signal, allowSource } = {}) {
  const sessions = []
  const coverage = { scannedSources: 0, skippedSources: 0, skippedReasons: {},
    scanLimitReached: false, resultLimitReached: false, timedOut: false }
  const result = status => ({ status, sessions, coverage })
  const pattern = phrasePattern(query)
  if (!pattern) return result('query-required')
  if (!workspaceHistoryAvailable(ctx)) return result('unavailable')
  const cwd = callerCwd(ctx, session)
  if (cwd === undefined) return result('unavailable')
  const host = optionalService(ctx, 'sessionQuery')
  const persistence = optionalService(ctx, 'sessionPersistence')
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const records = await host.filterSessions([{ kind: 'cwd', values: [cwd] }, { kind: 'parent', values: [null] }], readSignal)
    const eligible = records.filter(({ header }) => ownerSession(header) && header.id !== session.id && header.cwd === cwd)
    coverage.scanLimitReached = eligible.length > MAX_SESSIONS
    for (const record of eligible.slice(0, MAX_SESSIONS)) {
      readSignal.throwIfAborted()
      if (sessions.length === MAX_RESULTS) {
        coverage.resultLimitReached = true
        break
      }
      const id = record.header.id
      let phase = 'stat'
      try {
        if (!record.live) {
          if (typeof persistence?.stat !== 'function') throw Error('workspace-history-stat-unavailable')
          const stored = await persistence.stat(id, { signal: readSignal })
          if (stored?.header?.id !== id || stored.header.cwd !== cwd || !Number.isSafeInteger(stored.sizeBytes) ||
              stored.sizeBytes < 0 || stored.sizeBytes > MAX_STORED_BYTES) throw Error('workspace-history-stored-cap')
        }
        phase = 'inspect'
        const matched = await host.inspectSession(id, previous => {
          phase = 'extract'
          return inspectConversation(previous, id, cwd, pattern, allowSource, readSignal)
        }, readSignal)
        coverage.scannedSources++
        if (matched) sessions.push(matched)
      } catch (error) {
        readSignal.throwIfAborted()
        coverage.skippedSources++
        const code = error?.code ?? error?.message
        const reason = SKIP_CODES.has(code) ? code : `${phase}-failed`
        coverage.skippedReasons[reason] = (coverage.skippedReasons[reason] ?? 0) + 1
      }
    }
  } catch {
    signal?.throwIfAborted()
    if (!timeout.aborted) return result('unavailable')
    coverage.timedOut = true
  }
  signal?.throwIfAborted()
  if (callerCwd(ctx, session) !== cwd) {
    sessions.length = 0
    return result('unavailable')
  }
  if (sessions.length) return result('found')
  if (coverage.timedOut || coverage.skippedSources || coverage.scanLimitReached) return result('partial')
  return result('no-match')
}
