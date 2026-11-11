import {managedProjectOperation,registerManagedDestination} from './managed-access.mjs'
/** Collision-resistant project identity and reviewed, recoverable legacy copying. */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, lstatSync, openSync, fstatSync, readFileSync, closeSync, readdirSync, renameSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
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

// Explicit, same-local-Git-worktree mapping. This does not merge existing stores.
const WORKTREE_LINKS = '.worktree-links.json'
function worktreeIdentity(root) {
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
    const output = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')
    if (output.length !== 2) fail('worktree-unavailable')
    const [worktree, common] = output.map(path => realpathSync(path))
    if (realpathSync(root) !== worktree) fail('worktree-root-required')
    const commonStat = lstatSync(common, { bigint: true })
    if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) fail('worktree-unavailable')
    const commonId = hash(`${commonStat.dev}:${commonStat.ino}:${commonStat.birthtimeNs}`)
    return { worktree, common, commonId }
  } catch (error) { if (error.message?.startsWith('project-store-')) throw error; fail('worktree-unavailable') }
}
function readWorktreeLinks(store) {
  safeAncestors(join(store, 'projects'), store)
  const file = join(store, 'projects', WORKTREE_LINKS)
  let raw
  try { raw = readPrivateFile(file).toString('utf8') } catch (error) { if (error.code === 'ENOENT') return { links: [], revision: digest(null) }; throw error }
  let body
  try { body = JSON.parse(raw) } catch { fail('worktree-links-corrupt') }
  if (body?.schema !== 1 || !Array.isArray(body.links) || body.links.length > 128 || body.links.some(row => !row || Object.keys(row).sort().join('|') !== 'common|commonId|owner|worktree' || !hex(row.commonId) || !['common','owner','worktree'].every(key => typeof row[key] === 'string' && row[key].startsWith('/') && resolve(row[key]) === row[key])) || new Set(body.links.map(row => row.worktree)).size !== body.links.length) fail('worktree-links-corrupt')
  return { links: body.links, revision: hash(raw) }
}
function linkedRoot(store, root) {
  const links = readWorktreeLinks(store).links, physical = (() => { try { return realpathSync(root) } catch { return resolve(root) } })()
  const link = links.find(row => row.worktree === physical)
  if (!link) return root
  const worker = worktreeIdentity(link.worktree), owner = worktreeIdentity(link.owner)
  if (worker.common !== link.common || owner.common !== link.common || worker.commonId !== link.commonId || owner.commonId !== link.commonId || links.some(row => row.worktree === link.owner)) fail('worktree-link-changed')
  const old = paths(store, link.worktree)
  if (directory(old.target) || directory(old.legacy) || readClaim(old).value) fail('worktree-link-conflict')
  return link.owner
}
function unlinkWorktreeLocal(store, worktree, options = {}) {
  if (options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid-apply')
  let physical
  try { physical = realpathSync(worktree) } catch { physical = resolve(worktree) }
  const current = readWorktreeLinks(store), row = current.links.find(link => link.worktree === physical)
  if (!row) fail('worktree-link-not-found')
  const review = digest({ revision: current.revision, unlink: row })
  if (options.apply !== true) return { applied: false, worktree: row.worktree, owner: row.owner, reviewed: review }
  if (options.reviewed !== review) fail('stale-worktree-link-review')
  writeSafely(join(store, 'projects', WORKTREE_LINKS), JSON.stringify({ schema: 1, links: current.links.filter(link => link.worktree !== physical) }) + '\n')
  return { applied: true, worktree: row.worktree, owner: row.owner, memoryDeleted: false }
}
function linkWorktreeLocal(store, worktree, owner, options = {}) {
  if (options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid-apply')
  const a = worktreeIdentity(worktree), b = worktreeIdentity(owner)
  if (a.worktree === b.worktree || a.common !== b.common || a.commonId !== b.commonId) fail('worktree-not-same-repository')
  const links = readWorktreeLinks(store), prior = links.links.find(row => row.worktree === a.worktree)
  if (links.links.some(row => row.worktree === b.worktree) || links.links.some(row => row.owner === a.worktree)) fail('worktree-link-chain')
  if (prior && (prior.owner !== b.worktree || prior.common !== a.common || prior.commonId !== a.commonId)) fail('worktree-link-conflict')
  const old = paths(store, a.worktree), ownerPaths = paths(store, b.worktree)
  if (directory(old.target) || directory(old.legacy) || readClaim(old).value) fail('worktree-link-conflict')
  if (!directory(ownerPaths.target)) fail('worktree-owner-store-missing')
  projectStoreDirLocal(store, b.worktree)
  const review = digest({ revision: links.revision, worktree: a, owner: b })
  if (options.apply !== true) return { applied: false, worktree: a.worktree, owner: b.worktree, reviewed: review, alreadyLinked: Boolean(prior) }
  if (options.reviewed !== review) fail('stale-worktree-link-review')
  if (prior) return { applied: false, alreadyLinked: true, worktree: a.worktree, owner: b.worktree }
  ensureStoreDir(join(store, 'projects'))
  writeSafely(join(store, 'projects', WORKTREE_LINKS), JSON.stringify({ schema: 1, links: [...links.links, { worktree: a.worktree, owner: b.worktree, common: a.common, commonId: a.commonId }] }) + '\n')
  return { applied: true, worktree: a.worktree, owner: b.worktree }
}

/** No mkdir or metadata writes on normal lookup. Never read an ambiguous old store. */
function projectStoreDirLocal(store, root) {
  const p = paths(store, linkedRoot(store, root)), claim = readClaim(p).value
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
  const effectiveRoot = linkedRoot(store, root)
  const p = paths(store, effectiveRoot), claim = readClaim(p), source = tree(p.legacy), targetExists = directory(p.target)
  if (source) assertPublicationClear(p.legacy)
  return { applied: false, ...(effectiveRoot !== root ? { linkedWorktree: resolve(root), linkedOwner: effectiveRoot } : {}), projectId: p.id, legacyDir: p.legacy, targetDir: p.target, reviewedClaim: claim.revision,
    reviewedTree: source?.sha256, files: source?.files.length ?? 0, bytes: source?.bytes ?? 0, targetExists,
    state: claim.value ? claim.value.projectId !== p.id ? 'legacy-owned-by-another-project' : claim.value.state === 'prepared' ? 'needs-recovery' : 'migrated' : source ? 'legacy-needs-review' : 'fresh',
    sourceChangedSinceMigration: claim.value?.projectId === p.id && source ? source.sha256 !== claim.value.sourceHash : false }
}

/** Copies, never merges or deletes the old library. Both revisions are required. */
function migrateProjectStoreLocal(store, root, options = {}) {
  if (linkedRoot(store, root) !== root) fail('worktree-unlink-before-migration')
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
  if (linkedRoot(store, root) !== root) fail('worktree-unlink-before-migration')
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

function changeWorktreeLinks(store, run) {
  const dir = join(store, 'projects')
  safeAncestors(dir, store); ensureStoreDir(dir)
  return migrationLock(dir, run)
}
export function linkWorktreeProject(store,worktree,owner,options={}){return managedProjectOperation(store,()=>options.apply===true?changeWorktreeLinks(store,()=>linkWorktreeLocal(store,worktree,owner,options)):linkWorktreeLocal(store,worktree,owner,options),{write:options.apply===true})}
export function unlinkWorktreeProject(store,worktree,options={}){return managedProjectOperation(store,()=>options.apply===true?changeWorktreeLinks(store,()=>unlinkWorktreeLocal(store,worktree,options)):unlinkWorktreeLocal(store,worktree,options),{write:options.apply===true})}
