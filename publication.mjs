/** Recoverable multi-file roll-forward. Call commit/recover only under the store lock. */
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readSafely, writeSafely } from './security.mjs'
import { isManagedLogName, MANAGED_LOG_BYTES } from './managed-logs.mjs'
import { SOURCE_LEDGER_BYTES } from './source-retirement.mjs'
import {EPISODE_FILE,EPISODE_BYTES} from './episodes.mjs'

const JOURNAL = '.publication.json'
const TARGETS = new Set(['MEMORY.md', 'user.md', 'feedback.md', 'project.md', 'reference.md', '.candidates.json',EPISODE_FILE])
const targetAllowed = name => TARGETS.has(name) || isManagedLogName(name)
// Index + four topics + candidate state + two current logs + sixteen archives each.
const MAX_FILES = 41
const limitFor = (name) => name===EPISODE_FILE?EPISODE_BYTES:name === '.candidates.json' ? SOURCE_LEDGER_BYTES : isManagedLogName(name) ? MANAGED_LOG_BYTES : 512 * 1024
const readTarget = (dir, name, stage = name) => readSafely(join(dir, stage), { maxBytes: limitFor(name) })
export const contentHash = (text) => text === undefined ? null : createHash('sha256').update(text).digest('hex')
export const publicationPending = (dir) => existsSync(join(dir, JOURNAL))
export function assertPublicationClear(dir) {
  if (publicationPending(dir)) throw new Error('publication-needs-recovery')
}

function load(dir) {
  const raw = readSafely(join(dir, JOURNAL))
  if (raw === undefined) return undefined
  let journal
  try { journal = JSON.parse(raw) } catch { throw new Error('publication-corrupt-journal') }
  if (journal?.schema !== 1 || !Array.isArray(journal.files) || !journal.files.length || journal.files.length > MAX_FILES) throw new Error('publication-corrupt-journal')
  const seen = new Set()
  for (const file of journal.files) {
    if (!targetAllowed(file.name) || seen.has(file.name) || !/^\.publication-[a-f0-9-]+-\d+\.stage$/.test(file.stage) ||
        !(file.before === null || /^[a-f0-9]{64}$/.test(file.before)) || !/^[a-f0-9]{64}$/.test(file.after)) throw new Error('publication-invalid-file')
    seen.add(file.name)
  }
  return journal
}

export function inspectPublication(dir) {
  const journal = load(dir)
  if (!journal) return { pending: false, recoverable: true, files: [] }
  const files = journal.files.map((file) => {
    const current = contentHash(readTarget(dir, file.name))
    const stage = readTarget(dir, file.name, file.stage)
    return { name: file.name, state: current === file.after ? 'after' : current === file.before ? 'before' : 'conflict', validStage: contentHash(stage) === file.after }
  })
  return { pending: true, recoverable: files.every((f) => f.state !== 'conflict' && f.validStage), files }
}

export function recoverPublication(dir, { apply = false, fault } = {}) {
  const report = inspectPublication(dir)
  if (!apply || !report.pending) return { ...report, applied: false }
  if (!report.recoverable) throw new Error('publication-conflict-or-corrupt-stage')
  const journal = load(dir)
  for (const [index, file] of journal.files.entries()) {
    // Recheck immediately before replacement; an external editor need not share our lock.
    const current = contentHash(readTarget(dir, file.name))
    if (current !== file.before && current !== file.after) throw new Error('publication-concurrent-edit')
    const desired = readTarget(dir, file.name, file.stage)
    if (contentHash(desired) !== file.after) throw new Error('publication-stage-changed')
    if (current !== file.after) writeSafely(join(dir, file.name), desired)
    fault?.({ phase: 'file', index })
  }
  unlinkSync(join(dir, JOURNAL))
  for (const file of journal.files) { try { unlinkSync(join(dir, file.stage)) } catch { /* orphan stage is non-authoritative */ } }
  return { pending: false, recoverable: true, applied: true, files: report.files }
}

export function commitPublication(dir, writes, { fault } = {}) {
  assertPublicationClear(dir)
  if (!Array.isArray(writes) || !writes.length || writes.length > MAX_FILES) throw new Error('publication-invalid-writes')
  const seen = new Set()
  for (const file of writes) {
    if (!targetAllowed(file.name) || seen.has(file.name) || typeof file.text !== 'string' || Buffer.byteLength(file.text) > limitFor(file.name)) throw new Error('publication-invalid-writes')
    seen.add(file.name)
  }
  const id = randomUUID()
  const journal = { schema: 1, files: [] }
  try {
    for (const [index, file] of writes.entries()) {
      const stage = `.publication-${id}-${index}.stage`
      const before = contentHash(readTarget(dir, file.name))
      writeSafely(join(dir, stage), file.text)
      journal.files.push({ name: file.name, stage, before, after: contentHash(file.text) })
    }
    writeSafely(join(dir, JOURNAL), JSON.stringify(journal) + '\n')
  } catch (error) {
    for (const file of journal.files) { try { unlinkSync(join(dir, file.stage)) } catch { /* preserve original error */ } }
    throw error
  }
  fault?.({ phase: 'journal' })
  return recoverPublication(dir, { apply: true, fault })
}
