/** Offline only. Move the complete Dream directory; never make a replacement queue. */
import { lstatSync, realpathSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { snapshotIO } from '../snapshots.mjs'

const fail = code => { throw Error(`dream-park-${code}`) }
const exists = path => { try { return lstatSync(path) } catch (e) { if (e.code === 'ENOENT') return; throw e } }
export function moveDream(root, direction) {
  if (!['park', 'reattach'].includes(direction)) fail('invalid-direction')
  root = resolve(root)
  // A live DSH or memory writer invalidates the cold-move assumption.
  snapshotIO.inventory(root, { offline: true })
  const parent = realpathSync(dirname(root)), base = basename(root)
  const live = join(parent, base + '.dream'), parked = join(parent, base + '.dream.parked')
  const source = direction === 'park' ? live : parked, target = direction === 'park' ? parked : live
  const info = exists(source)
  if (!info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) fail('unsafe-source')
  if (exists(target)) fail('target-exists')
  for (const suffix of ['-wal', '-shm', '-journal']) if (exists(join(source, 'state.sqlite' + suffix))) fail('journal-present')
  const dbpath = join(source, 'state.sqlite'), dbinfo = exists(dbpath)
  if (!dbinfo?.isFile() || dbinfo.isSymbolicLink() || dbinfo.nlink !== 1 || (dbinfo.mode & 0o077)) fail('unsafe-database')
  const db = new DatabaseSync(dbpath)
  try {
    db.exec('PRAGMA busy_timeout=750; PRAGMA trusted_schema=OFF;')
    if (db.prepare('PRAGMA application_id').get().application_id !== 0x53504452 || db.prepare('PRAGMA user_version').get().user_version !== 5 || db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete' || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('incompatible-database')
    if (direction === 'park') {
      db.exec('BEGIN IMMEDIATE')
      try {
        // Never re-arm an uncompleted claim after a version change. A request
        // that may have reached a provider remains uncertain and budgeted.
        db.exec("UPDATE runs SET status='cancelled', lease_until=NULL, reason='rollback-prepared-discarded' WHERE status='prepared'; UPDATE runs SET status='uncertain', lease_until=NULL, reason='rollback-dispatch-unconfirmed' WHERE status IN ('dispatching','running'); COMMIT")
      } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
    }
  } finally { db.close() }
  if (exists(target)) fail('target-exists')
  renameSync(source, target)
  return { direction, source, target }
}
let invokedDirectly = false
try { invokedDirectly = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { /* Imported from an environment without a filesystem entry point. */ }
if (invokedDirectly) {
  try {
    const [, , direction, root, acknowledgement] = process.argv
    if (!root || acknowledgement !== '--offline-dream-disabled' || process.argv.length !== 5) fail('usage: park|reattach MEMORY_ROOT --offline-dream-disabled')
    console.log(JSON.stringify(moveDream(root, direction)))
  } catch (e) { console.error(e.message); process.exitCode = 1 }
}
