import {managedProjectOperation,registerManagedDestination} from './managed-access.mjs'
/** Collision-resistant project identity and reviewed, recoverable legacy copying. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, readdirSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { readSafely, writeSafely, ensureStoreDir, withLock } from './security.mjs'
import { assertPublicationClear } from './publication.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => hash(JSON.stringify(value))
const MAX_FILES = 512, MAX_BYTES = 32 * 1024 * 1024, MAX_FILE_BYTES = 2 * 1024 * 1024
const IDENTITY = '.project-identity.json'
const fail = code => { throw new Error('project-store-' + code) }
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const legacyProjectSlug = root => resolve(root).replace(/^[/\\]+/, '').replace(/[/\\:\s]+/g, '-')
export const projectIdentity = root => hash(resolve(root))

function directory(path) {
  try { const info = lstatSync(path); if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe-directory'); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function safeAncestors(path, boundary) {
  for (let current = resolve(path);;) {
    directory(current)
    if (current === resolve(boundary)) break
    const parent = dirname(current); if (parent === current) fail('unsafe-boundary'); current = parent
  }
}
function paths(store, root) {
  const id = projectIdentity(root), legacy = legacyProjectSlug(root), projects = join(store, 'projects')
  safeAncestors(projects, store)
  return { id, store, projects, legacy: join(projects, legacy), target: join(projects, 'v2-' + id), claims: join(projects, '.legacy-claims'), claim: join(projects, '.legacy-claims', hash(legacy) + '.json') }
}
function readPrivateFile(path) {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) fail('unsafe-file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES || info.ino !== before.ino || info.dev !== before.dev) fail('unsafe-file')
    const value = readFileSync(fd), after = fstatSync(fd), current = lstatSync(path)
    if (value.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink()) fail('concurrent-edit')
    return value
  } finally { closeSync(fd) }
}
function tree(path) {
  if (!directory(path)) return undefined
  const files = []; let bytes = 0, directories = 0
  const walk = (dir, prefix, depth) => {
    if (depth > 8) fail('tree-too-deep')
    if (++directories > MAX_FILES) fail('migration-budget-exceeded')
    const names = readdirSync(dir).sort()
    if (names.length > MAX_FILES * 2) fail('migration-budget-exceeded')
    for (const name of names) {
      if (!prefix && name === '.write.lock') continue
      const relative = prefix ? prefix + '/' + name : name, full = join(dir, name), info = lstatSync(full)
      if (info.isSymbolicLink()) fail('unsafe-file')
      if (info.isDirectory()) { walk(full, relative, depth + 1); continue }
      const value = readPrivateFile(full)
      bytes += value.length
      if (bytes > MAX_BYTES || files.length >= MAX_FILES) fail('migration-budget-exceeded')
      files.push({ path: relative, bytes: value.length, sha256: hash(value) })
    }
  }
  walk(path, '', 0)
  return { files, bytes, sha256: digest(files) }
}
function readClaim(p) {
  safeAncestors(p.claims, p.store)
  let raw
  try { raw = readPrivateFile(p.claim).toString('utf8') } catch (error) { if (error.code === 'ENOENT') return { revision: digest(null) }; throw error }
  let value
  try { value = JSON.parse(raw) } catch { fail('corrupt-claim') }
  if (value?.schema !== 1 || !['prepared', 'complete'].includes(value.state) || !hex(value.projectId) || !hex(value.sourceHash) || !hex(value.copiedHash) ||
      typeof value.stage !== 'string' || !/^\.migration-[a-f0-9-]{36}$/.test(value.stage) || !Number.isSafeInteger(value.files) || value.files < 1 || value.files > MAX_FILES) fail('corrupt-claim')
  return { value, revision: hash(raw) }
}
function identityMatches(p) {
  const raw = readSafely(join(p.target, IDENTITY))
  if (raw === undefined) return false
  let value; try { value = JSON.parse(raw) } catch { fail('identity-mismatch') }
  return value?.schema === 1 && value.projectId === p.id
}
function assertHostStopped(store) {
  const raw = readSafely(join(store, '.loaded.json'))
  if (raw === undefined) return
  let marker; try { marker = JSON.parse(raw) } catch { fail('invalid-host-marker') }
  if (!Number.isSafeInteger(marker.pid) || marker.pid < 1) fail('invalid-host-marker')
  try { process.kill(marker.pid, 0); fail('host-must-stop-before-migration') }
  catch (error) { if (error.code !== 'ESRCH') throw error }
}
function migrationLock(dir, run) {
  const lock = join(dir, '.write.lock')
  if (lstatExists(lock)) {
    let owner
    try { owner = JSON.parse(readPrivateFile(lock)) } catch { fail('migration-busy') }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) fail('migration-busy')
    // A slow or paused live migration must never lose its lock merely due to age.
    try { process.kill(owner.pid, 0); fail('migration-busy') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  return withLock(dir, run, { timeoutMs: 0 })
}

/** No mkdir or metadata writes on normal lookup. Never read an ambiguous old store. */
function projectStoreDirLocal(store, root) {
  const p = paths(store, root), claim = readClaim(p).value
  if (directory(p.target) && lstatExists(join(p.target, IDENTITY)) && !identityMatches(p)) fail('identity-mismatch')
  if (claim?.projectId === p.id) {
    if (claim.state !== 'complete') fail('migration-needs-recovery')
    if (!directory(p.target) || !identityMatches(p)) fail('identity-mismatch')
    return p.target
  }
  if (directory(p.legacy) && !claim) fail('legacy-needs-review')
  return p.target
}

function lstatExists(path) {
  try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function inspectProjectStoreLocal(store, root) {
  const p = paths(store, root), claim = readClaim(p), source = tree(p.legacy), targetExists = directory(p.target)
  if (source) assertPublicationClear(p.legacy)
  return { applied: false, projectId: p.id, legacyDir: p.legacy, targetDir: p.target, reviewedClaim: claim.revision,
    reviewedTree: source?.sha256, files: source?.files.length ?? 0, bytes: source?.bytes ?? 0, targetExists,
    state: claim.value ? claim.value.projectId !== p.id ? 'legacy-owned-by-another-project' : claim.value.state === 'prepared' ? 'needs-recovery' : 'migrated' : source ? 'legacy-needs-review' : 'fresh',
    sourceChangedSinceMigration: claim.value?.projectId === p.id && source ? source.sha256 !== claim.value.sourceHash : false }
}

/** Copies, never merges or deletes the old library. Both revisions are required. */
function migrateProjectStoreLocal(store, root, options = {}) {
  if (options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid-apply')
  if (options.apply !== true) return inspectProjectStore(store, root)
  const p = paths(store, root)
  assertHostStopped(store)
  if (!directory(p.legacy)) fail('legacy-missing')
  safeAncestors(p.claims, store); ensureStoreDir(p.claims)
  return migrationLock(p.claims, () => migrationLock(p.legacy, () => {
    const claim = readClaim(p)
    if (claim.value) fail(claim.value.projectId === p.id ? 'already-claimed-use-recovery' : 'legacy-owned-by-another-project')
    if (!hex(options.reviewedClaim) || options.reviewedClaim !== claim.revision) fail('stale-claim-review')
    assertPublicationClear(p.legacy)
    const source = tree(p.legacy)
    if (!hex(options.reviewedTree) || source.sha256 !== options.reviewedTree) fail('stale-tree-review')
    if (!source.files.length) fail('legacy-empty')
    if (source.files.some(file => file.path === IDENTITY)) fail('reserved-identity-file')
    if (directory(p.target)) fail('target-exists-no-merge')
    const stageName = '.migration-' + randomUUID(), stage = join(p.projects, stageName)
    const identity = JSON.stringify({ schema: 1, projectId: p.id }) + '\n'
    if (source.files.length >= MAX_FILES || source.bytes + Buffer.byteLength(identity) > MAX_BYTES) fail('migration-budget-exceeded')
    mkdirSync(stage, { mode: 0o700 })
    let prepared = false
    try {
    for (const file of source.files) {
      const value = readPrivateFile(join(p.legacy, file.path))
      if (hash(value) !== file.sha256) fail('concurrent-edit')
      writeSafely(join(stage, file.path), value.toString('utf8'))
    }
    writeSafely(join(stage, IDENTITY), identity)
    if (tree(p.legacy).sha256 !== source.sha256) fail('concurrent-edit')
    // Verify copied bytes before claiming ownership. Never count lossy text decoding.
    const copied = tree(stage)
    if (source.files.some(file => !copied.files.some(after => after.path === file.path && after.sha256 === file.sha256))) fail('non-text-file-or-copy-diverged')
    const value = { schema: 1, state: 'prepared', projectId: p.id, sourceHash: source.sha256, copiedHash: copied.sha256, stage: stageName, files: copied.files.length }
    writeSafely(p.claim, JSON.stringify(value) + '\n')
    prepared = true
    options.fault?.({ phase: 'prepared' })
    renameSync(stage, p.target)
    options.fault?.({ phase: 'renamed' })
    writeSafely(p.claim, JSON.stringify({ ...value, state: 'complete' }) + '\n')
    return { applied: true, projectId: p.id, targetDir: p.target, originalPreserved: true, files: source.files.length, bytes: source.bytes }
    } catch (error) {
      // Before an authoritative claim exists, only our private scratch tree was created.
      if (!prepared) rmSync(stage, { recursive: true, force: true })
      throw error
    }
  }))
}

function recoverProjectStoreLocal(store, root, options = {}) {
  if (options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid-apply')
  const p = paths(store, root), claim = readClaim(p)
  if (!claim.value || claim.value.projectId !== p.id) fail('no-owned-migration')
  const stage = join(p.projects, claim.value.stage), target = directory(p.target), staged = directory(stage)
  const actual = target ? tree(p.target) : staged ? tree(stage) : undefined
  const recoverable = !!actual && actual.sha256 === claim.value.copiedHash && !(target && staged)
  const preview = { applied: false, state: claim.value.state, reviewedMigration: claim.revision, recoverable, targetExists: target, stageExists: staged }
  if (options.apply !== true) return preview
  assertHostStopped(store)
  return migrationLock(p.claims, () => {
    const current = readClaim(p)
    if (!hex(options.reviewedMigration) || current.revision !== options.reviewedMigration || current.revision !== claim.revision) fail('stale-migration-review')
    if (current.value.state === 'complete') {
      if (!identityMatches(p)) fail('identity-mismatch')
      return { applied: false, duplicate: true }
    }
    if (tree(p.legacy)?.sha256 !== current.value.sourceHash) fail('legacy-diverged-during-migration')
    const nowTarget = directory(p.target), nowStage = directory(stage)
    const now = nowTarget ? tree(p.target) : nowStage ? tree(stage) : undefined
    if (!now || now.sha256 !== current.value.copiedHash || nowTarget && nowStage) fail('migration-conflict')
    if (!nowTarget) renameSync(stage, p.target)
    writeSafely(p.claim, JSON.stringify({ ...current.value, state: 'complete' }) + '\n')
    return { applied: true, projectId: p.id, originalPreserved: true }
  })
}

function finishManagedMigration(store,root,run){
  const result=run(),p=paths(store,root)
  if(!directory(p.target))return result
  const before=tree(p.target)
  if(!registerManagedDestination(store,p.target))return result
  const after=tree(p.target)
  if(before.files.some(file=>!after.files.some(row=>row.path===file.path&&row.sha256===file.sha256))||after.files.some(file=>!before.files.some(row=>row.path===file.path)&&file.path!=='.managed-policy.json'))fail('managed-binding-changed-copy')
  const claim=readClaim(p).value
  if(claim?.projectId===p.id&&claim.state==='complete')writeSafely(p.claim,JSON.stringify({...claim,copiedHash:after.sha256,files:after.files.length})+'\n')
  return result
}
export function projectStoreDir(store,...args){return managedProjectOperation(store,()=>projectStoreDirLocal(store,...args))}
export function inspectProjectStore(store,...args){return managedProjectOperation(store,()=>inspectProjectStoreLocal(store,...args))}
export function migrateProjectStore(store,root,options={}){return managedProjectOperation(store,()=>options.apply===true?finishManagedMigration(store,root,()=>migrateProjectStoreLocal(store,root,options)):migrateProjectStoreLocal(store,root,options),{write:options.apply===true})}
export function recoverProjectStore(store,root,options={}){return managedProjectOperation(store,()=>options.apply===true?finishManagedMigration(store,root,()=>recoverProjectStoreLocal(store,root,options)):recoverProjectStoreLocal(store,root,options),{write:options.apply===true})}
