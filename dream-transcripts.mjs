/** Bounded historical source reads through the host's exact SessionQuery read plane. */
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { privateMemory } from './privacy.mjs'
import { findSecrets, normalizeText } from './security.mjs'

const HASH = /^[a-f0-9]{64}$/
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,249}$/
const MAX_TARGETS = 5
const MAX_PER_TARGET = 3
const MAX_SESSIONS = 5
const MAX_EVENTS = 4096
const MAX_STORED_BYTES = 256 * 1024
const MAX_TEXT_CHARS = 2000
const MAX_TEXT_BYTES = 8000
const MAX_OWNER_BYTES = 64 * 1024
const MAX_QUOTE_CHARS = 500
const hashText = (text) => createHash('sha256').update(text).digest('hex')
export const replayTextHash = (text, wholeHash) => wholeHash === undefined ? hashText(text) : hashText(JSON.stringify([wholeHash, text]))
const sourceId = (sessionId, messageId) => hashText(JSON.stringify([sessionId, messageId]))
const safeTime = (time) => Number.isSafeInteger(time) && time >= 0 && time <= 8_640_000_000_000_000
const plain = (value) => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))

function fail(reason) {
  const error = new Error(`dream-transcripts-${reason}`)
  error.code = error.message
  throw error
}

function validPointer(pointer) {
  return plain(pointer) && Object.keys(pointer).every(key => ['sessionId', 'createdAt', 'seq', 'hash', 'quote'].includes(key)) &&
    typeof pointer.sessionId === 'string' && SESSION_ID.test(pointer.sessionId) && safeTime(pointer.createdAt) &&
    Number.isSafeInteger(pointer.seq) && pointer.seq >= 0 && pointer.seq < MAX_EVENTS &&
    typeof pointer.hash === 'string' && HASH.test(pointer.hash) &&
    (pointer.quote === undefined || (typeof pointer.quote === 'string' &&
      pointer.quote.length >= 8 && pointer.quote.length <= MAX_QUOTE_CHARS && pointer.quote.trim() === pointer.quote))
}

function disposeLate(observation) {
  try { observation?.[Symbol.dispose]?.() } catch { /* No retained state is used. */ }
}

function boundedRead(read, signal, dispose) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => {
      signal.throwIfAborted()
      return read()
    }).then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) dispose?.(value)
      else resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}

function ownerHeader(header) {
  return header && typeof header.cwd === 'string' && header.cwd.length <= 4096 && isAbsolute(header.cwd) &&
    header.isSeeded === false && header.parentSession === undefined && header.origin !== 'subagent' &&
    (header.delegationDepth === undefined || header.delegationDepth === 0)
}

function ownerText(event) {
  if (event?.type !== 'user/message' || event.surfaceOp !== 'append') return undefined
  const data = event.data?.message ?? event.data
  if (!data || data.role !== 'user' || data.source?.kind !== 'user' || typeof data.id !== 'string' ||
      !data.id.length || data.id.length > 300 || !Array.isArray(data.content) || !data.content.length || data.content.length > 16) return undefined
  const chunks = []
  let bytes = 0
  for (const part of data.content) {
    if (part?.type !== 'text' || typeof part.text !== 'string' || part.text.length > MAX_OWNER_BYTES) return undefined
    bytes += Buffer.byteLength(part.text) + (chunks.length ? 1 : 0)
    if (bytes > MAX_OWNER_BYTES) return undefined
    chunks.push(part.text)
  }
  const raw = chunks.join('\n')
  const text = normalizeText(raw).trim()
  if (!text || privateMemory(raw) || findSecrets(raw).length ||
      privateMemory(text) || findSecrets(text).length) return undefined
  if (text.length > MAX_TEXT_CHARS || bytes > MAX_TEXT_BYTES) {
    // A declared final paragraph is one bounded review unit. Never silently
    // trim a long reply or take an originally provisional middle paragraph.
    const paragraphs = text.split(/\r?\n[\t ]*\r?\n/u)
    const excerpt = paragraphs.at(-1).trim()
    if (paragraphs.length < 2 || paragraphs.slice(0, -1).some(part => correctionTarget(part.trim())) ||
        excerpt.length > MAX_QUOTE_CHARS || /[\r\n]/u.test(excerpt) || !correctionTarget(excerpt) ||
        !raw.trimEnd().endsWith(excerpt)) return undefined
    const wholeHash = hashText(text)
    return { text: excerpt, raw: excerpt, hash: replayTextHash(excerpt, wholeHash), wholeHash }
  }
  return { id: data.id, raw, text, hash: hashText(text) }
}

function correctionTarget(text) {
  return (/^(?:更正|纠正|修订)\s*[：:]?\s*[「『“"]([^」』”"\n]{2,200})[」』”"]\s*(?:[：:]|改为|改成|->|→)\s*\S/u.exec(text)
    ?? /^correction\s*:?\s*"([^"\n]{2,200})"\s*(?::|->|→)\s*\S/iu.exec(text))?.[1].trim()
}

/** Derive a reference from a real owner event. Keep transcript text in memory only. */
export function observeDreamCorrection(session, event) {
  const header = session?.header
  if (!ownerHeader(header) || header.id !== session.id || !SESSION_ID.test(session.id) ||
      !safeTime(header.createdAt) || !safeTime(event?.time) || event.time < header.createdAt ||
      !Number.isSafeInteger(event?.seq) || event.seq < 0 || event.seq >= MAX_EVENTS) return undefined
  const owner = ownerText(event)
  if (!owner || owner.text.length > MAX_QUOTE_CHARS) return undefined
  // The user names the old entry. A guess about relevance cannot create a
  // persisted link from arbitrary conversation to a memory.
  const targetSummary = correctionTarget(owner.text)
  if (!targetSummary) return undefined
  return {
    targetSummary,
    occurredAt: event.time,
    pointer: { sessionId: session.id, createdAt: header.createdAt, seq: event.seq, hash: owner.hash },
  }
}

function trustedCompaction(events, event, refs) {
  const source = (event.data?.message ?? event.data)?.source
  if (event.type !== 'user/message' || !(source?.kind === 'compact-checkpoint' ||
      source?.kind === 'plugin' && source.plugin === 'compact') ||
      typeof source.compactionId !== 'string' || !source.compactionId.length) return undefined
  const summary = events[event.seq - 1]
  const end = events[event.seq + 1]
  const start = events[refs[0]]
  const shadowed = summary?.data?.shadowedSeqs
  if (start?.type !== 'compaction/start' || summary?.type !== 'compaction/summary' || end?.type !== 'compaction/end' ||
      [start, summary, end].some(row => row.data?.compactionId !== source.compactionId) || end.data.error !== undefined ||
      !Array.isArray(shadowed) || !shadowed.length || refs.length !== shadowed.length + 2 || refs[1] !== summary.seq ||
      start.seq >= summary.seq || shadowed[0] !== event.surfaceOp.startSeq || shadowed.at(-1) !== event.surfaceOp.endSeq ||
      summary.data.shadowedRange?.start !== shadowed[0] || summary.data.shadowedRange?.end !== shadowed.at(-1) ||
      !shadowed.every((seq, index) => seq === refs[index + 2] && seq < start.seq) || new Set(shadowed).size !== shadowed.length) return undefined
  return shadowed
}

function sourceContext(events, indices, header) {
  const dirs = new Map()
  const replaced = new Set()
  const checkpoints = new Map()
  let cwd = header.cwd
  let refCount = 0
  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq]
    if (event?.seq !== seq) fail('source-changed')
    const op = event.surfaceOp
    if (op !== undefined && op !== 'append') {
      const refs = event.sourceEventSeqs
      // A validated DSH replacement names every shadowed node in
      // sourceEventSeqs. Reject any cited target conservatively. This avoids
      // readSurface(), which lists persisted sessions in the pinned host.
      if (op?.op !== 'replace' || !Array.isArray(refs) || !refs.length || refs.length > seq) fail('unknown-surface')
      refCount += refs.length
      if (refCount > 4 * MAX_EVENTS) fail('event-cap')
      if (
          refs.some(ref => !Number.isSafeInteger(ref) || ref < 0 || ref >= seq) ||
          !refs.includes(op.startSeq) || !refs.includes(op.endSeq)) fail('unknown-surface')
      const shadowed = trustedCompaction(events, event, refs)
      if (shadowed) {
        const origins = new Set(shadowed.filter(seq => indices.has(seq)))
        for (const seq of shadowed) {
          for (const origin of checkpoints.get(seq) ?? []) origins.add(origin)
          checkpoints.delete(seq)
        }
        if (origins.size) checkpoints.set(seq, origins)
      } else {
        for (const target of indices) if (refs.includes(target)) replaced.add(target)
        for (const ref of refs) {
          for (const origin of checkpoints.get(ref) ?? []) replaced.add(origin)
          checkpoints.delete(ref)
        }
      }
    }
    if (event.type === 'working-directory/change') {
      cwd = event.data?.cwd
      if (typeof cwd !== 'string' || cwd.length > 4096 || !isAbsolute(cwd)) fail('workspace-unavailable')
    }
    if (indices.has(seq)) dirs.set(seq, cwd)
  }
  return { dirs, replaced }
}

function observedProject(cwd, resolveProjectId) {
  try { return resolveProjectId(cwd) } catch { return undefined }
}

/** Capture only content for named pointers after folding the host's actual live event log. */
export function makeDreamReplaySnapshot(session, pointers) {
  const { header, id } = session
  const cursor = session.seq - 1
  if (!ownerHeader(header) || !safeTime(header.createdAt) || header.id !== id ||
      !Number.isSafeInteger(cursor) || cursor < 0 || cursor >= MAX_EVENTS || typeof session.eventAt !== 'function') return undefined
  const viable = pointers.filter(pointer => validPointer(pointer) && pointer.sessionId === id &&
    pointer.createdAt === header.createdAt && pointer.seq <= cursor)
  const events = Array.from({ length: cursor + 1 }, (_, seq) => session.eventAt(seq))
  const { dirs, replaced } = sourceContext(events, new Set(viable.map(pointer => pointer.seq)), header)
  const entries = []
  for (const pointer of viable) {
    const event = events[pointer.seq]
    const owner = ownerText(event)
    if (replaced.has(pointer.seq) || !owner || owner.hash !== pointer.hash || owner.text.length > MAX_QUOTE_CHARS ||
        !owner.raw.includes(owner.text) || !safeTime(event?.time) || event.time < header.createdAt) continue
    entries.push({ seq: pointer.seq, cwd: dirs.get(pointer.seq), time: event.time, text: owner.text,
      hash: owner.hash, ...(owner.wholeHash ? { wholeHash: owner.wholeHash } : {}) })
  }
  return { cursor, entries }
}

async function inspectSource(preflightSession, id, projectId, resolveProjectId, signal) {
  if (!preflightSession) return undefined
  const view = await boundedRead(() => preflightSession(id, { signal }), signal)
  if (view === undefined) fail('source-missing')
  if (!ownerHeader(view?.header) || view.header.id !== id || !safeTime(view.header.createdAt)) fail('not-owner-session')
  if (observedProject(view.header.cwd, resolveProjectId) !== projectId) fail('workspace-mismatch')
  if (view.source === 'live') {
    if (!Number.isSafeInteger(view.cursor) || view.cursor < -1 || view.cursor >= MAX_EVENTS) fail('event-cap')
  } else if (view.source === 'prepared') {
    if (!Number.isSafeInteger(view.sizeBytes) || view.sizeBytes < 0 ||
        typeof view.revision !== 'string' || !view.revision.length) fail('stored-size-unavailable')
  } else fail('observation-unavailable')
  return view
}

function sourceEvidence(pointer, owner, projectId, time, withdrawn) {
  const { sessionId, seq } = pointer
  const messageId = `${sessionId}:${seq}`
  if (withdrawn.has(sourceId(sessionId, messageId))) return { reason: 'source-withdrawn' }
  const quote = pointer.quote ?? owner.text
  if (pointer.hash !== owner.hash || quote.length < 8 || quote.length > MAX_QUOTE_CHARS ||
      !owner.raw.includes(quote) || !owner.text.includes(quote)) return { reason: 'source-changed' }
  return { evidence: {
    projectId, role: 'user', sourceComplete: true, sessionId, messageId,
    text: owner.text, quote, hash: hashText(owner.text), occurredAt: new Date(time).toISOString(),
  } }
}

async function readExactSession(query, pointers, projectId, resolveProjectId, withdrawn, signal, preflightSession, readIndexedSession) {
  const id = pointers[0].sessionId
  const preflight = await inspectSource(preflightSession, id, projectId, resolveProjectId, signal)
  if (preflight?.source === 'prepared' && preflight.sizeBytes > MAX_STORED_BYTES) {
    const indexed = await boundedRead(() => readIndexedSession?.(id, preflight), signal)
    if (!indexed) fail('stored-size-cap')
    const latest = await inspectSource(preflightSession, id, projectId, resolveProjectId, signal)
    if (latest.source !== 'prepared' || latest.revision !== preflight.revision) fail('source-changed')
    const verified = new Map()
    for (const pointer of pointers) {
      const entry = indexed.entries.find(row => row.seq === pointer.seq && row.hash === pointer.hash)
      if (withdrawn.has(sourceId(id, `${id}:${pointer.seq}`))) verified.set(pointer, { reason: 'source-withdrawn' })
      else if (!entry || pointer.createdAt !== preflight.header.createdAt) verified.set(pointer, { reason: 'stored-size-cap' })
      else if (observedProject(entry.cwd, resolveProjectId) !== projectId) verified.set(pointer, { reason: 'workspace-mismatch' })
      else verified.set(pointer, sourceEvidence(pointer, { ...entry, raw: entry.text }, projectId, entry.time, withdrawn))
    }
    return verified
  }
  if (typeof query?.observeSession !== 'function') fail('query-unavailable')
  const observation = await boundedRead(
    () => query.observeSession(id, { projectionMode: 'none', signal }), signal, disposeLate
  )
  try {
    if (typeof observation?.[Symbol.dispose] !== 'function' ||
        !['live', 'prepared'].includes(observation.source)) fail('observation-unavailable')
    const { header, cursor, inheritedEventCount } = observation
    if (!ownerHeader(header) || header.id !== id || !safeTime(header.createdAt) || inheritedEventCount !== 0) fail('not-owner-session')
    if (observedProject(header.cwd, resolveProjectId) !== projectId) fail('workspace-mismatch')
    if (preflight && (preflight.source !== observation.source || preflight.header.createdAt !== header.createdAt ||
        preflight.header.cwd !== header.cwd || preflight.header.version !== header.version ||
        (preflight.source === 'live' ? preflight.cursor !== cursor : preflight.revision !== observation.revision))) fail('source-changed')
    if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor >= MAX_EVENTS) fail('event-cap')
    const events = observation.events
    if (!Array.isArray(events) || events.length !== cursor + 1) fail('source-changed')

    const viable = pointers.filter(pointer => pointer.createdAt === header.createdAt && pointer.seq <= cursor)
    const { dirs, replaced } = sourceContext(events, new Set(viable.map(pointer => pointer.seq)), header)
    const verified = new Map()
    for (const pointer of pointers) {
      signal.throwIfAborted()
      if (!dirs.has(pointer.seq) || pointer.createdAt !== header.createdAt) {
        verified.set(pointer, { reason: 'source-missing' })
        continue
      }
      if (observedProject(dirs.get(pointer.seq), resolveProjectId) !== projectId) {
        verified.set(pointer, { reason: 'workspace-mismatch' })
        continue
      }
      const messageId = `${id}:${pointer.seq}`
      if (withdrawn.has(sourceId(id, messageId))) {
        verified.set(pointer, { reason: 'source-withdrawn' })
        continue
      }
      if (replaced.has(pointer.seq)) {
        verified.set(pointer, { reason: 'source-replaced' })
        continue
      }
      const event = events[pointer.seq]
      const owner = ownerText(event)
      if (!owner || !safeTime(event.time) || event.time < header.createdAt) {
        verified.set(pointer, { reason: 'source-unusable' })
        continue
      }
      verified.set(pointer, sourceEvidence(pointer, owner, projectId, event.time, withdrawn))
    }
    return verified
  } finally {
    observation?.[Symbol.dispose]?.()
  }
}

function skipReason(error, timedOut) {
  if (timedOut) return 'timeout'
  if (['SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_QUERY_EVENT_NOT_FOUND'].includes(error?.code)) return 'source-missing'
  if (typeof error?.code === 'string' && /^dream-transcripts-[a-z-]+$/.test(error.code)) {
    return error.code.slice('dream-transcripts-'.length)
  }
  return 'source-unavailable'
}

/**
 * Read only explicitly named sources. Pointers come from trusted scheduling or
 * source records, never model output. Resolve cwd using SoloPup's project
 * identity and authorization checks. Pass the returned evidence map directly
 * to buildDreamEvidence. An empty object marks a known missing pointer and
 * forces "needs evidence" rather than pretending all material was available.
 * Optional preflightSession checks live cursor or persisted file size and
 * revision before the host decodes a log. Stored size may be compressed.
 */
export async function readDreamTranscripts({
  query, projectId, pointersByTarget, resolveProjectId, withdrawnSourceIds = [], signal, preflightSession, readIndexedSession,
  timeoutMs = 1500, maxBytes = 12 * 1024
} = {}) {
  if (typeof projectId !== 'string' || !HASH.test(projectId) || !plain(pointersByTarget) ||
      typeof resolveProjectId !== 'function' || !Array.isArray(withdrawnSourceIds) ||
      (preflightSession !== undefined && typeof preflightSession !== 'function') ||
      (readIndexedSession !== undefined && typeof readIndexedSession !== 'function') ||
      !withdrawnSourceIds.every(id => typeof id === 'string' && HASH.test(id)) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 12 * 1024) fail('invalid-input')
  const entries = Object.entries(pointersByTarget)
  if (entries.length > MAX_TARGETS || entries.some(([target, pointers]) => !HASH.test(target) ||
    !Array.isArray(pointers) || pointers.length > MAX_PER_TARGET || !pointers.every(validPointer))) fail('invalid-pointers')
  signal?.throwIfAborted()
  const withdrawn = new Set(withdrawnSourceIds)
  const answers = new Map()
  const bySession = new Map()
  for (const [, pointers] of entries) {
    for (const pointer of pointers) {
      const group = bySession.get(pointer.sessionId)
      if (group) group.push(pointer)
      else if (bySession.size < MAX_SESSIONS) bySession.set(pointer.sessionId, [pointer])
      else answers.set(pointer, { reason: 'session-cap' })
    }
  }

  const timerSignal = new AbortController()
  const linked = signal ? AbortSignal.any([signal, timerSignal.signal]) : timerSignal.signal
  const timer = setTimeout(() => timerSignal.abort(Error('dream-transcripts-timeout')), timeoutMs)
  try {
    for (const pointers of bySession.values()) {
      signal?.throwIfAborted()
      try {
        const result = await readExactSession(query, pointers, projectId, resolveProjectId, withdrawn, linked, preflightSession, readIndexedSession)
        for (const [pointer, answer] of result) answers.set(pointer, answer)
      } catch (error) {
        signal?.throwIfAborted()
        const reason = skipReason(error, timerSignal.signal.aborted)
        for (const pointer of pointers) answers.set(pointer, { reason })
      }
    }
  } finally { clearTimeout(timer) }

  signal?.throwIfAborted()
  const additionalEvidenceByTarget = {}
  const skips = []
  let bytes = 0
  for (const [targetId, pointers] of entries) {
    if (!pointers.length) continue
    const result = []
    const seen = new Set()
    for (const pointer of pointers) {
      const dedupe = JSON.stringify([pointer.sessionId, pointer.seq, pointer.hash, pointer.quote ?? null])
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const { evidence, reason } = answers.get(pointer) ?? { reason: 'source-unavailable' }
      const size = evidence ? Buffer.byteLength(JSON.stringify(evidence)) : 0
      if (evidence && bytes + size <= maxBytes) {
        result.push(evidence)
        bytes += size
      } else {
        result.push({})
        skips.push({ targetId, reason: reason ?? 'byte-cap' })
      }
    }
    additionalEvidenceByTarget[targetId] = result
  }
  return { additionalEvidenceByTarget, skips, bytes }
}
