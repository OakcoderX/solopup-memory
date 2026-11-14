/** Bounded cache of explicitly named corrections, sealed to a persisted DSH revision. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { makeDreamReplaySnapshot, replayTextHash } from './dream-transcripts.mjs'
import { assertRestorationInactive } from './restoration-lock.mjs'
import { privateMemory } from './privacy.mjs'
import { findSecrets, normalizeText, writeSafely } from './security.mjs'

const MAX_BYTES = 32 * 1024
const MAX_ENTRIES = 12
const HASH = /^[a-f0-9]{64}$/
const dateTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
const rev = value => typeof value === 'string' && value.length > 0 && value.length <= 1024

function safeEntry(row, cursor, createdAt) {
  return row && Number.isSafeInteger(row.seq) && row.seq >= 0 && row.seq <= cursor &&
    typeof row.cwd === 'string' && row.cwd.length <= 4096 && dateTime(row.time) && row.time >= createdAt &&
    HASH.test(row.hash ?? '') && typeof row.text === 'string' && row.text.length >= 8 && row.text.length <= 500 &&
    (row.wholeHash === undefined || HASH.test(row.wholeHash)) && replayTextHash(row.text, row.wholeHash) === row.hash &&
    row.text === normalizeText(row.text).trim() && !privateMemory(row.text) && !findSecrets(row.text).length
}

function readCache(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size < 1 || stat.size > MAX_BYTES) return undefined
    const bytes = Buffer.alloc(stat.size)
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return undefined
    return JSON.parse(bytes.toString('utf8'))
  } finally { closeSync(fd) }
}

export function createDreamReplayIndex(root) {
  const absolute = resolve(root)
  function fileFor(id, create) {
    const base = join(realpathSync(dirname(absolute)), `${basename(absolute)}.dream`)
    const dir = join(base, 'replay')
    for (const path of [base, dir]) {
      if (create) {
        try { mkdirSync(path, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.mode & 0o077) throw Error('dream-replay-index-unsafe-path')
    }
    // A fixed number of slots bounds disk quota. Collisions become cache misses.
    const slot = createHash('sha256').update(id).digest('hex').slice(0, 2)
    return join(dir, `${slot}.json`)
  }

  return {
    save(session, pointers, revision) {
      if (!rev(revision) || !pointers.length) return false
      assertRestorationInactive(absolute)
      const { id, header } = session
      if (typeof id !== 'string' || !header) return false
      const snapshot = makeDreamReplaySnapshot(session, pointers.slice(0, MAX_ENTRIES))
      if (!snapshot?.entries.length) return false
      const encoded = JSON.stringify({ schema: 1, id, revision, createdAt: header.createdAt, ...snapshot })
      if (Buffer.byteLength(encoded) > MAX_BYTES) return false
      writeSafely(fileFor(id, true), encoded)
      return true
    },
    read(id, preflight) {
      try {
        assertRestorationInactive(absolute)
        const row = readCache(fileFor(id, false))
        if (row?.schema !== 1 || row.id !== id || row.revision !== preflight.revision ||
            row.createdAt !== preflight.header.createdAt || !Number.isSafeInteger(row.cursor) ||
            row.cursor < 0 || row.cursor > 4095 || !Array.isArray(row.entries) || row.entries.length > MAX_ENTRIES ||
            !row.entries.every(entry => safeEntry(entry, row.cursor, row.createdAt))) return undefined
        return row
      } catch { return undefined }
    },
  }
}
