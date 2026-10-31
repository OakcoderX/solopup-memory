/** Closed, bounded archive family shared by withdrawal and publication recovery. */
import { readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { readSafely } from './security.mjs'

export const MANAGED_LOG_BYTES = 2 * 1024 * 1024
export const MANAGED_LOG_TOTAL_BYTES = 16 * 1024 * 1024
export const MANAGED_LOG_ARCHIVES = 16
const bases = ['.audit.jsonl', '.history.jsonl']

export function isManagedLogName(name) {
  if (bases.includes(name)) return true
  if (typeof name !== 'string') return false
  const match = /^(\.audit\.jsonl|\.history\.jsonl)\.([1-9]\d*)$/.exec(name)
  return match !== null && Number(match[2]) <= MANAGED_LOG_ARCHIVES
}

/** Unsupported archive-like entries block withdrawal instead of silently surviving. */
export function readManagedLogs(dir) {
  let names
  try { names = readdirSync(dir) } catch (error) { if (error.code === 'ENOENT') names = []; else throw error }
  const archiveNames = names.filter(name => bases.some(base => name.startsWith(base + '.')))
  if (archiveNames.some(name => !isManagedLogName(name))) throw new Error('withdrawal-unsupported-log-archive')
  archiveNames.sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  let totalBytes = 0
  return [...bases, ...archiveNames].map(name => {
    try { if (lstatSync(join(dir, name)).nlink !== 1) throw new Error('withdrawal-linked-log') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const raw = readSafely(join(dir, name), { maxBytes: MANAGED_LOG_BYTES })
    if (raw !== undefined) totalBytes += Buffer.byteLength(raw)
    if (totalBytes > MANAGED_LOG_TOTAL_BYTES) throw new Error('withdrawal-log-budget-exceeded')
    return { name, raw }
  })
}
