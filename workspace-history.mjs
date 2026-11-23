import { isAbsolute } from 'node:path'
import { transcriptSourceContext } from './dream-transcripts.mjs'
import { foldEnglishInflection, queryTokens } from './retrieval.mjs'
import { optionalService } from './host-services.mjs'
import { privateMemory } from './privacy.mjs'
import { escapeFraming, findSecrets, normalizeText } from './security.mjs'

const MAX_SESSIONS = 40
const MAX_RESULTS = 3
const MAX_EVENTS = 4096
const MAX_STORED_BYTES = 8 * 1024 * 1024
const MAX_MESSAGE_CHARS = 64 * 1024
const MAX_EXCERPT_CHARS = 700
const MAX_OPENING_CHARS = 160
const MAX_NEARBY_SPAN = 120
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
  const quotedSpeaker = row.quotedSpeaker
  if (quotedSpeaker) limit -= quotedSpeaker.length
  const span = Math.min(limit, row.nearbySpan ?? row.exactLength)
  // A hit near the start already carries the opening. For late hits, share the existing
  // character allowance between two non-overlapping quotes from this exact message.
  const lateHit = matchAt >= limit || matchAt + span > limit
  const openingLength = lateHit ? Math.min(MAX_OPENING_CHARS, Math.floor(limit / 4), limit - span) : 0
  const bodyLimit = limit - openingLength
  const lead = Math.min(Math.floor(bodyLimit / 3), bodyLimit - span)
  const start = lateHit ? Math.max(openingLength, matchAt - lead) : 0
  const end = Math.min(start + bodyLimit, text.length)
  return { seq, messageId, occurredAt: new Date(time).toISOString(), role,
    ...(quotedSpeaker ? { quotedSpeaker } : {}),
    ...(openingLength ? { sourceOpening: escapeFraming(text.slice(0, openingLength)) } : {}),
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
  const anchor = rankedRows.filter(({ row }) => row.matchAt >= 0)
    .sort((a, b) => (a.row.nearbySpan ?? 0) - (b.row.nearbySpan ?? 0))[0]
  if (!anchor) return []
  for (const { row } of [anchor, ...rankedRows.filter(candidate => candidate !== anchor)]) {
    if (remaining < 120 || selected.length === MAX_EXCERPTS) break
    const item = excerpt(row, Math.min(remaining, MAX_EXCERPT_CHARS))
    remaining -= item.text.length + (item.sourceOpening?.length ?? 0) + (item.quotedSpeaker?.length ?? 0)
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
    const match = pattern.exact.exec(text)
    messages.push({ seq: event.seq, messageId, time: event.time, role, text, matchAt: match?.index ?? -1, exactLength: match?.[0].length ?? 0, segment })
  }
  // Resolve exact evidence before considering a looser match in the same conversation.
  let span = 0
  let passage = false
  if (!messages.some(row => row.matchAt >= 0)) {
    if (!pattern.terms) return undefined
    span = Infinity
    for (const row of messages) {
      const match = closestTerms(row.text, pattern)
      if (!match) continue
      row.matchAt = match.start
      row.nearbySpan = match.span
      span = Math.min(span, match.span)
    }
    if (!Number.isFinite(span)) {
      const turns = messages.flatMap(row => Array.from(row.text.matchAll(SPEAKER_TURN), turn => ({ row, turn })))
      const speakers = new Set(turns.map(({ turn }) => turn[1].trim().toLowerCase()))
      let best
      for (const { row, turn } of turns) {
        signal.throwIfAborted()
        const hit = speakerPassage(turn, pattern, speakers)
        if (hit && (!best || hit.cost < best.hit.cost)) best = { row, hit }
      }
      if (!best) return undefined
      const { row, hit } = best
      row.matchAt = hit.start
      row.nearbySpan = hit.length
      row.quotedSpeaker = hit.speaker
      passage = true
      span = hit.cost
    }
  }
  const excerpts = selectExcerpts(messages)
  if (!excerpts.length) return undefined
  const displayTitle = safeBody(title)
  return { span, passage, session: { sessionId, title: displayTitle ? escapeFraming(displayTitle.slice(0, 160)) : undefined, excerpts } }
}

function phrasePattern(query) {
  if (typeof query !== 'string') return undefined
  const text = normalizeText(query).trim()
  if (!text || text.length > 200 || !/[\p{L}\p{N}]/u.test(text)) return undefined
  const words = text.split(/\s+/u)
  const escape = word => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const exact = new RegExp(words.map(escape).join('\\s+'), 'iu')
  const terms = new Set(words.map(word => word.toLowerCase()))
  // Keep punctuation-heavy queries, repeated words and single terms on the existing exact path.
  if (terms.size < 2 || terms.size !== words.length || terms.size > 8 ||
      words.some(word => !/^[\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*$/u.test(word))) return { exact }
  const tokens = [...terms].sort((a, b) => b.length - a.length).map(word => {
    const literal = escape(word)
    return /\p{Script=Han}/u.test(word) ? literal :
      '(?<![\\p{L}\\p{M}\\p{N}_-])' + literal + '(?![\\p{L}\\p{M}\\p{N}_-])'
  })
  return { exact, terms, tokens: new RegExp(tokens.join('|'), 'giu') }
}

function closestTerms(text, { terms, tokens }) {
  const positions = new Map()
  let closest
  for (const match of text.matchAll(tokens)) {
    const term = match[0].toLowerCase()
    if (!terms.has(term)) continue
    positions.set(term, match.index)
    if (positions.size !== terms.size) continue
    const start = Math.min(...positions.values())
    const end = match.index + match[0].length
    const span = end - start
    if (span > MAX_NEARBY_SPAN || (closest && span >= closest.span)) continue
    // A pasted transcript may contain unrelated speakers on adjacent lines of one DSH message.
    if (/[\r\n\u2028\u2029]/u.test(text.slice(start, end))) continue
    closest = { start, span }
  }
  return closest
}

// Quoted speaker labels are source text. A different line or a different speaker cannot complete an event.
const SPEAKER_TURN = /^([\p{L}][\p{L}\p{M}\p{N} ._'’·-]{0,47})([:：])[ \t]*([^\r\n\u2028\u2029]+)/gmu
const SENTENCE = /[^。！？；.!?;\r\n]+[。！？；.!?;]*/gu
const metadataLabel = /(?:日期|时间|标题|来源|文件名)$|^(?:旁白|备注|说明)$|(?:^| )(?:date|time|title|source|filename|narrator|notes?|session)$/iu
const hanPhrase = /^\p{Script=Han}{4,}$/u

function weakHanMatch(term, sentence) {
  if (!hanPhrase.test(term)) return false
  const chars = [...new Set(term)]
  // Longest common subsequence on distinct query characters: preserve order without inventing a synonym.
  const lengths = Array(chars.length + 1).fill(0)
  for (const char of sentence) {
    let previous = 0
    for (let i = 1; i <= chars.length; i++) {
      const old = lengths[i]
      lengths[i] = char === chars[i - 1] ? previous + 1 : Math.max(old, lengths[i - 1])
      previous = old
    }
  }
  return lengths.at(-1) >= Math.max(2, Math.ceil(chars.length / 2))
}

function speakerPassage(turn, pattern, speakers) {
  const [, name, separator, body] = turn
  const speaker = name.trim().toLowerCase()
  if (metadataLabel.test(speaker)) return
  const terms = [...pattern.terms]
  // A qualified person or an identified other speaker must never be shortened to this name.
  if (terms.some(term => term !== speaker && (speakers.has(term) || term.includes(speaker)))) return
  const eventTerms = terms.filter(term => term !== speaker)
  if (!eventTerms.length) return
  let best
  for (const match of body.matchAll(SENTENCE)) {
    const sentence = match[0].trim().toLowerCase()
    // The label may be distant; the words describing the event must still be local.
    if (!sentence || match[0].length > MAX_NEARBY_SPAN) continue
    const words = eventTerms.some(term => !/\p{Script=Han}/u.test(term)) ? queryTokens(sentence) : undefined
    const missing = eventTerms.filter(term => /\p{Script=Han}/u.test(term)
      ? !sentence.includes(term) : !words.has(foldEnglishInflection(term)))
    if (missing.length === eventTerms.length || missing.length > 1) continue
    if (missing.length && !weakHanMatch(missing[0], sentence)) continue
    const cost = missing.length * MAX_EXCERPT_CHARS + match[0].length
    if (!best || cost < best.cost) {
      best = { cost, start: turn.index + turn[0].length - body.length + match.index,
        length: match[0].length, speaker: name + separator }
    }
  }
  return best
}

/** Read exact user source messages bound to already-matched project records. */
export async function readWorkspaceHistorySources(ctx, { session, pointers = [], signal, allowSource } = {}) {
  const sessions = []
  const coverage = { scannedSources: 0, skippedSources: 0, skippedReasons: {},
    scanLimitReached: false, resultLimitReached: false, timedOut: false }
  const result = status => ({ status, resolution: 'source-pointer', sessions, coverage })
  if (!Array.isArray(pointers) || !pointers.length) return result('no-match')
  if (!workspaceHistoryAvailable(ctx)) return result('unavailable')
  const cwd = callerCwd(ctx, session)
  if (cwd === undefined) return result('unavailable')
  const bySession = new Map()
  for (const pointer of pointers) {
    const sid = pointer?.sessionId
    if (typeof sid !== 'string' || !sid || sid === session.id) continue
    let entry = bySession.get(sid)
    if (!entry) {
      if (bySession.size >= MAX_RESULTS) { coverage.resultLimitReached = true; continue }
      entry = { ids: new Set(), seqs: new Set(), quotes: [] }
      bySession.set(sid, entry)
    }
    for (const rawId of pointer.messageIds ?? []) {
      if (typeof rawId !== 'string' || !rawId) continue
      entry.ids.add(rawId)
      if (rawId.startsWith(`${sid}:`)) {
        const parsed = Number(rawId.slice(sid.length + 1))
        if (Number.isSafeInteger(parsed) && parsed >= 0) entry.seqs.add(parsed)
      }
    }
    for (const quote of pointer.quotes ?? []) {
      if (typeof quote === 'string' && quote.trim() && entry.quotes.length < 8) entry.quotes.push(quote)
    }
  }
  if (!bySession.size) return result('no-match')
  const host = optionalService(ctx, 'sessionQuery')
  const persistence = optionalService(ctx, 'sessionPersistence')
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const readSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const records = await host.filterSessions([{ kind: 'cwd', values: [cwd] }, { kind: 'parent', values: [null] }], readSignal)
    const eligible = new Map(records
      .filter(({ header }) => ownerSession(header) && header.id !== session.id && header.cwd === cwd)
      .map(record => [record.header.id, record]))
    for (const [id, target] of bySession.entries()) {
      readSignal.throwIfAborted()
      const record = eligible.get(id)
      if (!record) continue
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
          const { header } = previous
          if (!ownerSession(header) || header.id !== id || header.cwd !== cwd || previous.inheritedEventCount !== 0) return undefined
          if (!Number.isSafeInteger(previous.seq) || previous.seq < 0 || previous.seq > MAX_EVENTS) throw Error('workspace-history-event-cap')
          const events = Array.from({ length: previous.seq }, (_, seq) => previous.eventAt(seq))
          const indices = new Set(events.flatMap(event => messageRole(event) ? [event.seq] : []))
          const { dirs, replaced } = transcriptSourceContext(events, indices, header)
          let title
          let segment = 0
          const found = []
          for (const event of events) {
            readSignal.throwIfAborted()
            if (event.type === 'working-directory/change') segment++
            if (event.type === 'session/title' && !segment) title = event.data?.title
            if (messageRole(event) !== 'user') continue
            if (dirs.get(event.seq) !== cwd || replaced.has(event.seq) ||
                !Number.isSafeInteger(event.time) || event.time < 0 || event.time > 8_640_000_000_000_000) continue
            const hostMessageId = sourceId(event)
            if (!hostMessageId || (!target.seqs.has(event.seq) && !target.ids.has(hostMessageId))) continue
            if (allowSource && !allowSource({ sessionId: id, messageId: hostMessageId, seq: event.seq })) continue
            const text = messageBody(event)
            if (!text) continue
            let matchAt = 0
            let exactLength = Math.min(text.length, 80)
            const positions = target.quotes.map(quote => {
              const at = text.indexOf(quote)
              return at >= 0 ? { start: at, end: at + quote.length } : undefined
            }).filter(Boolean)
            if (positions.length) {
              const minStart = Math.min(...positions.map(p => p.start))
              const maxEnd = Math.max(...positions.map(p => p.end))
              matchAt = minStart
              exactLength = Math.min(MAX_EXCERPT_CHARS, maxEnd - minStart)
            }
            found.push({ seq: event.seq, messageId: hostMessageId, time: event.time, role: 'user', text, matchAt, exactLength })
          }
          if (!found.length) return undefined
          let remaining = MAX_RESULT_CHARS
          const excerpts = []
          for (const row of found.slice(0, MAX_EXCERPTS)) {
            if (remaining < 120) { coverage.resultLimitReached = true; break }
            const item = excerpt(row, Math.min(remaining, MAX_EXCERPT_CHARS))
            remaining -= item.text.length + (item.sourceOpening?.length ?? 0)
            excerpts.push(item)
          }
          if (!excerpts.length) return undefined
          const displayTitle = safeBody(title)
          return { sessionId: id, title: displayTitle ? escapeFraming(displayTitle.slice(0, 160)) : undefined, excerpts }
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
  if (coverage.timedOut || coverage.skippedSources) return result('partial')
  return result('no-match')
}

/** Search exact-time host observations of prior sessions. Only selected excerpts leave this adapter. */
export async function searchWorkspaceHistory(ctx, { session, query, signal, allowSource } = {}) {
  const sessions = []
  const nearbySessions = []
  const passageSessions = []
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
        if (matched?.passage) passageSessions.push(matched)
        else if (matched?.span === 0) sessions.push(matched.session)
        else if (matched) nearbySessions.push(matched)
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
  if (!sessions.length) {
    const fallback = nearbySessions.length ? nearbySessions : passageSessions
    fallback.sort((a, b) => a.span - b.span)
    sessions.push(...fallback.slice(0, MAX_RESULTS).map(item => item.session))
    coverage.resultLimitReached = fallback.length > MAX_RESULTS
  }
  if (sessions.length) return result('found')
  if (coverage.timedOut || coverage.skippedSources || coverage.scanLimitReached) return result('partial')
  return result('no-match')
}
