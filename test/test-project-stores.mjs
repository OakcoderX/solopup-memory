import {prepareMountedFixture} from '../fixture-host.mjs'
import {realpathSync} from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, existsSync, utimesSync, renameSync } from 'node:fs'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { projectStoreDir, projectIdentity, legacyProjectSlug, inspectProjectStore, migrateProjectStore, recoverProjectStore, linkWorktreeProject, unlinkWorktreeProject } from '../project-stores.mjs'
import { storeDirFor, writeMemory, indexLine, searchStore, apply } from '../index.mjs'

function box(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-project-store-'))), store = join(root, 'memory'), a = join(root, 'A B'), b = join(root, 'A-B')
  mkdirSync(a); mkdirSync(b)
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = root
  try { return run({ root, store, a, b }) } finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(root, { recursive: true, force: true }) }
}
function legacy(box) {
  const dir = join(box.store, 'projects', legacyProjectSlug(box.a))
  writeMemory({ type: 'project', dir, line: indexLine('project', '合成旧项目独有决定 cobalt-1234', undefined, false), provenance: { sessionId: 'synthetic-project', evidence: [{ messageId: 'm1', hash: 'a'.repeat(64), quote: '合成旧项目独有决定 cobalt-1234' }] } })
  return dir
}
function reviewed(box, extra = {}) {
  const view = inspectProjectStore(box.store, box.a)
  return { apply: true, reviewedTree: view.reviewedTree, reviewedClaim: view.reviewedClaim, ...extra }
}
const contents = dir => Object.fromEntries(readdirSync(dir).filter(name => name !== '.write.lock').map(name => [name, readFileSync(join(dir, name), 'utf8')]))

test('space, dash and separator collisions in legacy slugs have distinct full-hash project stores', () => box(({ root, store, a, b }) => {
  assert.equal(legacyProjectSlug(a), legacyProjectSlug(b))
  assert.notEqual(projectStoreDir(store, a), projectStoreDir(store, b))
  assert.notEqual(projectStoreDir(store, join(root, 'nested/path')), projectStoreDir(store, join(root, 'nested-path')))
  assert.match(projectStoreDir(store, a), /v2-[a-f0-9]{64}$/)
  assert.equal(existsSync(store), false)
}))
test('new projects cannot retrieve each other through write, search or runtime injection', () => box(box => {
  const a = storeDirFor('project', box.a), b = storeDirFor('project', box.b)
  writeMemory({ type: 'project', dir: a, line: indexLine('project', '合成A项目保密决定', undefined, false) })
  writeMemory({ type: 'project', dir: b, line: indexLine('project', '合成B项目独立决定', undefined, false) })
  assert.equal(searchStore(b, '保密决定').hits.length, 0)
  let context
  prepareMountedFixture()
  apply({ systemPrompt: { context: entry => context = entry }, tools: { register() {} }, workingDirectory: { get: () => box.b } }, { autoCapture: { enabled: false } })
  const text = context.text({ agent: { session: {} } })
  assert.match(text, /合成B项目独立决定/)
  assert.doesNotMatch(text, /合成A项目保密决定/)
}))
test('one provider resolves the current project afresh each render and stops when control disappears',()=>box(box=>{
 const a=storeDirFor('project',box.a),b=storeDirFor('project',box.b);
 writeMemory({type:'project',dir:a,line:indexLine('project','Synthetic-A-render-secret',undefined,false)});
 writeMemory({type:'project',dir:b,line:indexLine('project','Synthetic-B-render-private',undefined,false)});
 prepareMountedFixture();let provider,cwd=box.a;
 apply({systemPrompt:{context:value=>provider=value},tools:{register(){}},workingDirectory:{get:()=>cwd}},{autoCapture:{enabled:false}});
 const read=()=>provider.text({agent:{session:{id:'same-runtime-session'}}});
 let text=read();assert.match(text,/Synthetic-A-render-secret/);assert.doesNotMatch(text,/Synthetic-B-render-private/);
 cwd=box.b;text=read();assert.match(text,/Synthetic-B-render-private/);assert.doesNotMatch(text,/Synthetic-A-render-secret/);
 rmSync(box.store+'.control',{recursive:true});text=read();assert.match(text,/暂不可用/);assert.doesNotMatch(text,/Synthetic-[AB]-render-/);
}))
test('project roots remain stable in descendants and long names have bounded store basenames', () => box(box => {
  mkdirSync(join(box.a, '.git')); mkdirSync(join(box.a, 'child'))
  assert.equal(storeDirFor('project', box.a), storeDirFor('project', join(box.a, 'child')))
  assert.equal(projectStoreDir(box.store, join(box.root, 'x'.repeat(220))).split('/').at(-1).length, 67)
}))
test('inspection and migration preview do not change or create any source metadata', () => box(box => {
  assert.equal(inspectProjectStore(box.store, box.a).state, 'fresh')
  assert.equal(existsSync(box.store), false)
  const dir = legacy(box), before = contents(dir)
  assert.equal(migrateProjectStore(box.store, box.a).state, 'legacy-needs-review')
  assert.throws(() => migrateProjectStore(box.store, box.a, { apply: 'yes' }), /invalid-apply/)
  assert.deepEqual(contents(dir), before)
  assert.equal(existsSync(join(box.store, 'projects/.legacy-claims')), false)
}))
test('ambiguous old libraries are not assigned by first access; global memory stays visible', () => box(box => {
  legacy(box)
  assert.throws(() => storeDirFor('project', box.a), /legacy-needs-review/)
  assert.throws(() => storeDirFor('project', box.b), /legacy-needs-review/)
  writeMemory({ type: 'user', dir: box.store, line: indexLine('user', '合成全局偏好继续可用', undefined, false) })
  let context
  prepareMountedFixture()
  apply({ systemPrompt: { context: value => context = value }, tools: { register() {} }, workingDirectory: { get: () => box.b } }, { autoCapture: { enabled: false } })
  const text = context.text({ agent: { session: {} } })
  assert.match(text, /合成全局偏好继续可用/); assert.match(text, /归属审查/)
  assert.doesNotMatch(text, /合成旧项目独有决定/)
}))
test('reviewed migration copies original bytes and binds the legacy library to exactly one project', () => box(box => {
  const dir = legacy(box), before = contents(dir)
  const result = migrateProjectStore(box.store, box.a, reviewed(box))
  assert.equal(result.originalPreserved, true)
  assert.deepEqual(contents(dir), before)
  assert.equal(searchStore(storeDirFor('project', box.a), 'cobalt-1234').hits.length, 1)
  assert.equal(searchStore(storeDirFor('project', box.b), 'cobalt-1234').hits.length, 0)
  for (const [name, raw] of Object.entries(before)) assert.equal(readFileSync(join(result.targetDir, name), 'utf8'), raw)
  assert.throws(() => migrateProjectStore(box.store, box.b, { apply: true }), /legacy-owned-by-another-project/)
  assert.equal(inspectProjectStore(box.store, box.b).state, 'legacy-owned-by-another-project')
}))
test('stale source or claim review and an existing target are not overwritten', () => box(box => {
  const dir = legacy(box), options = reviewed(box)
  writeFileSync(join(dir, 'extra.md'), 'new synthetic source')
  assert.throws(() => migrateProjectStore(box.store, box.a, options), /stale-tree-review/)
  assert.throws(() => migrateProjectStore(box.store, box.a, { ...reviewed(box), reviewedClaim: 'f'.repeat(64) }), /stale-claim-review/)
  const target = inspectProjectStore(box.store, box.a).targetDir
  mkdirSync(target); writeFileSync(join(target, 'keep.txt'), 'independent target')
  assert.throws(() => migrateProjectStore(box.store, box.a, reviewed(box)), /target-exists-no-merge/)
  assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'independent target')
}))
for (const phase of ['prepared', 'renamed']) test(`interrupted migration at ${phase} is blocked until reviewed recovery`, () => box(box => {
  const dir = legacy(box), before = contents(dir)
  assert.throws(() => migrateProjectStore(box.store, box.a, reviewed(box, { fault: event => { if (event.phase === phase) throw Error('controlled interruption') } })), /controlled interruption/)
  assert.throws(() => storeDirFor('project', box.a), /migration-needs-recovery/)
  const view = recoverProjectStore(box.store, box.a)
  assert.throws(() => recoverProjectStore(box.store, box.a, { apply: 'yes' }), /invalid-apply/)
  assert.equal(view.recoverable, true)
  assert.equal(recoverProjectStore(box.store, box.a, { apply: true, reviewedMigration: view.reviewedMigration }).applied, true)
  assert.deepEqual(contents(dir), before)
  assert.equal(searchStore(storeDirFor('project', box.a), 'cobalt-1234').hits.length, 1)
}))
test('changed legacy source during interrupted copying cannot be silently superseded by a stale snapshot', () => box(box => {
  const dir = legacy(box)
  assert.throws(() => migrateProjectStore(box.store, box.a, reviewed(box, { fault: () => { throw Error('pause') } })))
  writeFileSync(join(dir, 'extra.md'), 'synthetic later source update')
  const view = recoverProjectStore(box.store, box.a)
  assert.throws(() => recoverProjectStore(box.store, box.a, { apply: true, reviewedMigration: view.reviewedMigration }), /legacy-diverged/)
  assert.throws(() => storeDirFor('project', box.a), /needs-recovery/)
}))
test('damaged staged copy or changed migration review refuses recovery with original source preserved', () => box(box => {
  const dir = legacy(box), before = contents(dir)
  assert.throws(() => migrateProjectStore(box.store, box.a, reviewed(box, { fault: () => { throw Error('pause') } })))
  const view = recoverProjectStore(box.store, box.a)
  assert.throws(() => recoverProjectStore(box.store, box.a, { apply: true, reviewedMigration: 'f'.repeat(64) }), /stale-migration-review/)
  const projects = join(box.store, 'projects'), stage = readdirSync(projects).find(name => name.startsWith('.migration-'))
  writeFileSync(join(projects, stage, 'MEMORY.md'), 'damaged synthetic staged copy')
  assert.equal(recoverProjectStore(box.store, box.a).recoverable, false)
  assert.throws(() => recoverProjectStore(box.store, box.a, { apply: true, reviewedMigration: view.reviewedMigration }), /migration-conflict/)
  assert.deepEqual(contents(dir), before)
}))
for (const kind of ['symlink', 'hardlink']) test(`${kind} cannot enter a reviewed legacy copy`, () => box(box => {
  const dir = legacy(box), target = join(box.root, 'outside.json')
  writeFileSync(target, '{"synthetic":"private other file"}\n')
  if (kind === 'symlink') symlinkSync(target, join(dir, 'linked.json'))
  else linkSync(target, join(dir, 'linked.json'))
  assert.throws(() => inspectProjectStore(box.store, box.a))
  assert.equal(readFileSync(target, 'utf8'), '{"synthetic":"private other file"}\n')
}))
test('symlinked memory directory, pending publication and tampered identity fail closed', () => box(box => {
  const outside = join(box.root, 'outside'); mkdirSync(outside); symlinkSync(outside, box.store)
  assert.throws(() => projectStoreDir(box.store, box.a), /unsafe-directory/)
  rmSync(box.store); const dir = legacy(box)
  writeFileSync(join(dir, '.publication.json'), '{}')
  assert.throws(() => inspectProjectStore(box.store, box.a), /needs-recovery/)
  rmSync(join(dir, '.publication.json'))
  const result = migrateProjectStore(box.store, box.a, reviewed(box))
  writeFileSync(join(result.targetDir, '.project-identity.json'), JSON.stringify({ schema: 1, projectId: projectIdentity(box.b) }))
  assert.throws(() => storeDirFor('project', box.a), /identity-mismatch/)
}))
test('a live loaded host blocks applying migration while read-only inspection remains available', () => box(box => {
  legacy(box); writeFileSync(join(box.store, '.loaded.json'), JSON.stringify({ pid: process.pid }))
  assert.equal(inspectProjectStore(box.store, box.a).state, 'legacy-needs-review')
  assert.throws(() => migrateProjectStore(box.store, box.a, reviewed(box)), /host-must-stop/)
}))
test('actual SIGKILL after directory publication is recoverable and never assigns the copy to a colliding project', () => box(box => {
  const dir = legacy(box), before = contents(dir), options = reviewed(box)
  const worker = `import {migrateProjectStore} from ${JSON.stringify(new URL('../project-stores.mjs', import.meta.url).href)};migrateProjectStore(process.argv[1],process.argv[2],{...JSON.parse(process.argv[3]),fault:event=>{if(event.phase==='renamed')process.kill(process.pid,'SIGKILL')}})`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker, box.store, box.a, JSON.stringify(options)], { encoding: 'utf8', timeout: 15000 })
  assert.equal(result.signal, 'SIGKILL', result.stderr)
  assert.throws(() => storeDirFor('project', box.a), /migration-needs-recovery/)
  const past = new Date(Date.now() - 20000)
  for (const path of [join(dir, '.write.lock'), join(box.store, 'projects/.legacy-claims/.write.lock')]) utimesSync(path, past, past)
  const view = recoverProjectStore(box.store, box.a)
  recoverProjectStore(box.store, box.a, { apply: true, reviewedMigration: view.reviewedMigration })
  assert.deepEqual(contents(dir), before)
  assert.equal(searchStore(storeDirFor('project', box.b), 'cobalt-1234').hits.length, 0)
  assert.equal(searchStore(storeDirFor('project', box.a), 'cobalt-1234').hits.length, 1)
}))

test('opaque binary files refuse migration without leaving a prepared claim or scratch copy', () => box(box => {
  const dir = legacy(box)
  writeFileSync(join(dir, 'unknown.bin'), Buffer.from([255, 254, 0, 128]))
  const before = contents(dir), options = reviewed(box)
  assert.throws(() => migrateProjectStore(box.store, box.a, options), /non-text-file-or-copy-diverged/)
  assert.equal(readdirSync(join(box.store, 'projects')).some(name => name.startsWith('.migration-')), false)
  assert.deepEqual(contents(dir), before)
  assert.equal(inspectProjectStore(box.store, box.a).state, 'legacy-needs-review')
}))
test('oversized files, overly deep trees and FIFO entries are refused before copying', () => box(box => {
  const dir = legacy(box)
  writeFileSync(join(dir, 'oversized.md'), 'x'.repeat(2 * 1024 * 1024 + 1))
  assert.throws(() => inspectProjectStore(box.store, box.a), /unsafe-file/)
  rmSync(join(dir, 'oversized.md'))
  const nested = join(dir, ...Array(9).fill('sub'))
  mkdirSync(nested, { recursive: true })
  assert.throws(() => inspectProjectStore(box.store, box.a), /tree-too-deep/)
  rmSync(join(dir, 'sub'), { recursive: true })
  const made = spawnSync('mkfifo', [join(dir, 'pipe')], { encoding: 'utf8', timeout: 3000 })
  assert.equal(made.status, 0, made.stderr)
  assert.throws(() => inspectProjectStore(box.store, box.a), /unsafe-file/)
}))
test('source edits after completed migration are diagnosed and never silently merged', () => box(box => {
  const dir = legacy(box)
  migrateProjectStore(box.store, box.a, reviewed(box))
  writeFileSync(join(dir, 'late.md'), 'synthetic old version later write')
  assert.equal(inspectProjectStore(box.store, box.a).sourceChangedSinceMigration, true)
  assert.equal(existsSync(join(storeDirFor('project', box.a), 'late.md')), false)
}))
test('local CLI previews and applies with both review hashes without package installation', () => box(box => {
  legacy(box)
  const cli = fileURLToPath(new URL('../scripts/projects.mjs', import.meta.url))
  const run = args => spawnSync(process.execPath, [cli, ...args, '--cwd', box.a], { env: process.env, encoding: 'utf8', timeout: 10000 })
  const preview = run(['migrate'])
  assert.equal(preview.status, 0, preview.stderr)
  const view = JSON.parse(preview.stdout)
  assert.equal(view.applied, false)
  const applied = run(['migrate', '--apply', '--reviewed-tree', view.reviewedTree, '--reviewed-claim', view.reviewedClaim])
  assert.equal(applied.status, 0, applied.stderr)
  assert.equal(JSON.parse(applied.stdout).originalPreserved, true)
  assert.equal(searchStore(storeDirFor('project', box.a), 'cobalt-1234').hits.length, 1)
}))

test('an old but live migration lock is not stolen by another apply attempt', () => box(box => {
  legacy(box)
  const options = reviewed(box), locks = join(box.store, 'projects/.legacy-claims')
  mkdirSync(locks)
  const lock = join(locks, '.write.lock'), raw = JSON.stringify({ pid: process.pid, token: 'synthetic-live-owner' })
  writeFileSync(lock, raw)
  const past = new Date(Date.now() - 600000); utimesSync(lock, past, past)
  assert.throws(() => migrateProjectStore(box.store, box.a, options), /migration-busy/)
  assert.equal(readFileSync(lock, 'utf8'), raw)
}))


test('explicit same-repository worktree link shares an existing owner store without merging other stores', () => box(({ root, store }) => {
  const repo = join(root, 'repo'), worker = join(root, 'worker'), conflicting = join(root, 'conflicting'), foreign = join(root, 'foreign')
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (...args) => execFileSync('git', args, { env, stdio: 'pipe' })
  mkdirSync(repo); git('init', '-q', repo)
  git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
  git('-C', repo, 'worktree', 'add', '-qb', 'worker', worker)
  git('-C', repo, 'worktree', 'add', '-qb', 'conflicting', conflicting)
  mkdirSync(foreign); git('init', '-q', foreign)
  const original = storeDirFor('project', repo), separate = storeDirFor('project', worker)
  assert.notEqual(original, separate)
  writeMemory({ type: 'project', dir: original, line: indexLine('project', 'Synthetic shared project violet775', undefined, false) })
  writeMemory({ type: 'project', dir: storeDirFor('project', conflicting), line: indexLine('project', 'Synthetic preexisting project', undefined, false) })
  assert.throws(() => linkWorktreeProject(store, foreign, repo), /worktree-not-same-repository/)
  assert.throws(() => linkWorktreeProject(store, conflicting, repo), /worktree-link-conflict/)
  const preview = linkWorktreeProject(store, worker, repo)
  assert.equal(preview.applied, false); assert.notEqual(storeDirFor('project', worker), original)
  assert.throws(() => linkWorktreeProject(store, worker, repo, { apply: true, reviewed: 'stale' }), /stale-worktree-link-review/)
  assert.equal(linkWorktreeProject(store, worker, repo, { apply: true, reviewed: preview.reviewed }).applied, true)
  assert.equal(storeDirFor('project', worker), original)
  const inspected = inspectProjectStore(store, worker)
  assert.equal(inspected.targetDir, original, 'inspection must report the store actually used by the worker')
  assert.equal(inspected.linkedOwner, realpathSync(repo))
  assert.throws(() => migrateProjectStore(store, worker), /worktree-unlink-before-migration/)
  assert.throws(() => recoverProjectStore(store, worker), /worktree-unlink-before-migration/)
  assert.equal(searchStore(storeDirFor('project', worker), 'violet775').hits.length, 1)
  mkdirSync(separate, { recursive: true })
  assert.throws(() => storeDirFor('project', worker), /worktree-link-conflict/, 'a later independently created store cannot be silently hidden')
  const unlink = unlinkWorktreeProject(store, worker)
  assert.throws(() => unlinkWorktreeProject(store, worker, { apply: true, reviewed: 'stale' }), /stale-worktree-link-review/)
  assert.equal(unlinkWorktreeProject(store, worker, { apply: true, reviewed: unlink.reviewed }).memoryDeleted, false)
  assert.equal(storeDirFor('project', worker), separate)
  // A previously resolved directory is an ordinary local path, not an access token.
  assert.equal(searchStore(original, 'violet775').hits.length, 1, 'unlink does not revoke an already resolved owner path')
  const cliworker = join(root, 'cliworker'); git('-C', repo, 'worktree', 'add', '-qb', 'cliworker', cliworker)
  const cli = fileURLToPath(new URL('../scripts/projects.mjs', import.meta.url)), cliEnv = { ...env, DSH_HOME: root }
  const runCli = (...args) => spawnSync(process.execPath, [cli, ...args], { env: cliEnv, encoding: 'utf8' })
  const cliPreview = runCli('link', '--cwd', cliworker, '--owner', repo)
  assert.equal(cliPreview.status, 0, cliPreview.stderr)
  const cliApplied = runCli('link', '--cwd', cliworker, '--owner', repo, '--apply', '--reviewed-link', JSON.parse(cliPreview.stdout).reviewed)
  assert.equal(cliApplied.status, 0, cliApplied.stderr)
  assert.equal(storeDirFor('project', cliworker), original)
  const cliInspect = runCli('inspect', '--cwd', cliworker)
  assert.equal(cliInspect.status, 0, cliInspect.stderr)
  assert.equal(JSON.parse(cliInspect.stdout).targetDir, original)
  assert.equal(JSON.parse(cliInspect.stdout).linkedOwner, realpathSync(repo))
  const cliMigrate = runCli('migrate', '--cwd', cliworker)
  assert.notEqual(cliMigrate.status, 0); assert.match(cliMigrate.stderr, /worktree-unlink-before-migration/)
  const moved = join(root, 'moved-worker'); git('-C', repo, 'worktree', 'move', cliworker, moved)
  assert.throws(() => storeDirFor('project', cliworker), /worktree-unavailable/, 'a moved worktree does not retain a stale mapping')
  assert.notEqual(storeDirFor('project', moved), original, 'moving requires an explicit new registration')
  const cliUnlink = runCli('unlink', '--cwd', cliworker)
  assert.equal(cliUnlink.status, 0, cliUnlink.stderr)
  const cliRemoved = runCli('unlink', '--cwd', cliworker, '--apply', '--reviewed-link', JSON.parse(cliUnlink.stdout).reviewed)
  assert.equal(cliRemoved.status, 0, cliRemoved.stderr)
  assert.notEqual(storeDirFor('project', cliworker), original)
  const autoworker = join(root, 'autoworker'); git('-C', repo, 'worktree', 'add', '-qb', 'autoworker', autoworker)
  const helper = fileURLToPath(new URL('../scripts/superagent-worktree.mjs', import.meta.url))
  const runHelper = (worktree, ...args) => spawnSync(process.execPath, [helper, ...args], { env: { ...cliEnv, ...(worktree === undefined ? {} : { DSH_SUPERAGENT_DIR: worktree }) }, encoding: 'utf8' })
  assert.notEqual(runHelper(undefined, '--owner', repo, '--apply').status, 0)
  assert.notEqual(runHelper(autoworker, '--owner', repo).status, 0)
  assert.notEqual(runHelper(foreign, '--owner', repo, '--apply').status, 0)
  const helperResult = runHelper(autoworker, '--owner', repo, '--apply')
  assert.equal(helperResult.status, 0, helperResult.stderr)
  assert.equal(storeDirFor('project', autoworker), original)
  assert.equal(runHelper(autoworker, '--owner', repo, '--apply').status, 0, 'preparing the same registered worktree is idempotent')
}))


test('a different repository recreated at the same paths cannot inherit a worktree link', () => box(({ root, store }) => {
  const repo = join(root, 'repo-replaced'), worker = join(root, 'worker-replaced')
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (...args) => execFileSync('git', args, { env, stdio: 'pipe' })
  mkdirSync(repo); git('init', '-q', repo)
  git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'original')
  git('-C', repo, 'worktree', 'add', '-qb', 'old-worker', worker)
  const original = storeDirFor('project', repo)
  writeMemory({ type: 'project', dir: original, line: indexLine('project', 'Synthetic old decision plum749', undefined, false) })
  const plan = linkWorktreeProject(store, worker, repo)
  linkWorktreeProject(store, worker, repo, { apply: true, reviewed: plan.reviewed })
  assert.equal(storeDirFor('project', worker), original)
  git('-C', repo, 'worktree', 'remove', '--force', worker)
  renameSync(join(repo, '.git'), join(root, 'old-git-preserved'))
  git('init', '-q', repo)
  git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'different')
  git('-C', repo, 'worktree', 'add', '-qb', 'new-worker', worker)
  assert.throws(() => storeDirFor('project', worker), /worktree-link-changed/)
}))


test('independent processes cannot both apply conflicting previews to an unmanaged store', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-project-link-race-'))), store = join(root, 'memory'), repo = join(root, 'repo'), a = join(root, 'a'), b = join(root, 'b')
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (...args) => execFileSync('git', args, { env, stdio: 'pipe' })
  const children = []
  try {
    mkdirSync(repo); git('init', '-q', repo)
    git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture')
    git('-C', repo, 'worktree', 'add', '-qb', 'a', a); git('-C', repo, 'worktree', 'add', '-qb', 'b', b)
    writeMemory({ type: 'project', dir: projectStoreDir(store, repo), line: indexLine('project', 'Synthetic concurrent project', undefined, false) })
    const reviews = [linkWorktreeProject(store, a, repo).reviewed, linkWorktreeProject(store, b, repo).reviewed]
    const moduleUrl = new URL('../project-stores.mjs', import.meta.url).href
    const source = `import {linkWorktreeProject} from ${JSON.stringify(moduleUrl)}; const [store,worker,owner,review]=process.argv.slice(1); process.send({ready:true}); process.on('message',()=>{try { const result=linkWorktreeProject(store,worker,owner,{apply:true,reviewed:review});process.send({status:result.applied?'applied':'other'}); } catch(error) {process.send({status:'denied',message:String(error.message)});} process.disconnect()})`
    const results = [a, b].map((worker, index) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, store, worker, repo, reviews[index]], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child)
      let result, errors = ''; child.stderr.on('data', data => { errors += data })
      return { child, ready: new Promise((resolve, reject) => { child.on('message', message => { if (message.ready) resolve(); else result = message }); child.on('error', reject); child.on('exit', code => { if (code && !result) reject(Error(errors)) }) }), done: new Promise((resolve, reject) => { child.on('exit', code => code === 0 && result ? resolve(result) : reject(Error(errors || `child exited ${code}`))); child.on('error', reject) }) }
    })
    await Promise.all(results.map(item => item.ready)); results.forEach(item => item.child.send('go'))
    const settled = await Promise.all(results.map(item => item.done))
    assert.equal(settled.filter(item => item.status === 'applied').length, 1, JSON.stringify(settled))
    assert.equal(settled.filter(item => item.status === 'denied' && /migration-busy|stale-worktree-link-review|memory-lock-busy|另一个写入占用/.test(item.message)).length, 1, JSON.stringify(settled))
    const owner = projectStoreDir(store, repo)
    assert.equal([a, b].filter(path => projectStoreDir(store, path) === owner).length, 1)
  } finally { children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL') }); rmSync(root, { recursive: true, force: true }) }
})
