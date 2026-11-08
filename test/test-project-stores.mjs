import {prepareMountedFixture} from '../fixture-host.mjs'
import {realpathSync} from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, existsSync, utimesSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { projectStoreDir, projectIdentity, legacyProjectSlug, inspectProjectStore, migrateProjectStore, recoverProjectStore } from '../project-stores.mjs'
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
