import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, linkSync, existsSync, utimesSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageCandidate, listCandidates } from './candidates.mjs'
import { adoptCandidate, withdrawManagedSource, recoverMemoryPublication, storeRevision, searchStore, writeMemory, indexLine } from './index.mjs'
import { commitPublication } from './publication.mjs'
import { withLock } from './security.mjs'
import { MANAGED_LOG_BYTES, MANAGED_LOG_TOTAL_BYTES, isManagedLogName } from './managed-logs.mjs'

function box(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-archive-withdrawal-'))
  try { return run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}
function seed(dir, type = 'user', sessionId = 'archive-source') {
  const item = stageCandidate(dir, { type, scope: 'project', summary: `Archive synthetic ${type} durable choice`, detail: `Synthetic ${type} detail from withdrawn evidence.`, sessionId,
    indexRevision: storeRevision(dir), evidence: [{ messageId: 'message-1', hash: 'b'.repeat(64), quote: 'Synthetic source evidence for archive withdrawal.' }] })
  const view = adoptCandidate(dir, item.id)
  adoptCandidate(dir, item.id, { apply: true, reviewedIndex: view.reviewedIndex, candidateRevision: view.candidateRevision })
}
function apply(dir, extra = {}) {
  const preview = withdrawManagedSource(dir, 'archive-source', 'message-1')
  return withdrawManagedSource(dir, 'archive-source', 'message-1', { apply: true, reviewedIndex: preview.reviewedIndex, candidateRevision: preview.candidateRevision, ...extra })
}
const snapshot = dir => new Map(readdirSync(dir).map(name => [name, readFileSync(join(dir, name), 'utf8')]))

test('more than one rotated log is scrubbed with current logs and preserves unrelated rows', () => box(dir => {
  seed(dir)
  const independent = JSON.stringify({ op: 'unrelated', id: 'independent-row', note: 'Keep the other source intact.' }) + '\n'
  for (const base of ['.audit.jsonl', '.history.jsonl']) for (const suffix of [1, 2, 9, 16]) writeFileSync(join(dir, `${base}.${suffix}`), readFileSync(join(dir, base), 'utf8') + independent)
  const before = snapshot(dir)
  const preview = withdrawManagedSource(dir, 'archive-source', 'message-1')
  assert.ok(preview.files.includes('.history.jsonl.16'))
  for (const [name, raw] of before) assert.equal(readFileSync(join(dir, name), 'utf8'), raw, name)
  assert.equal(apply(dir).effectiveRemoved, 1)
  for (const base of ['.audit.jsonl', '.history.jsonl']) for (const suffix of [1, 2, 9, 16]) {
    const raw = readFileSync(join(dir, `${base}.${suffix}`), 'utf8')
    assert.doesNotMatch(raw, /durable choice|withdrawn evidence|Synthetic source evidence/)
    assert.match(raw, /Keep the other source intact/)
  }
  assert.equal(searchStore(dir, 'durable choice').hits.length, 0)
}))

test('audit lineage in a later archive can withdraw a summary after current logs rotated away', () => box(dir => {
  writeMemory({ dir, type: 'user', line: indexLine('user', 'Summary only recorded in later archive', undefined, false), provenance: { sessionId: 'archive-source', evidence: [{ messageId: 'message-1', hash: 'b'.repeat(64), quote: 'Synthetic source evidence for archive withdrawal.' }] } })
  writeFileSync(join(dir, '.audit.jsonl.7'), readFileSync(join(dir, '.audit.jsonl')))
  writeFileSync(join(dir, '.audit.jsonl'), '')
  assert.equal(apply(dir).effectiveRemoved, 1)
  assert.equal(searchStore(dir, 'Summary only').hits.length, 0)
  assert.doesNotMatch(readFileSync(join(dir, '.audit.jsonl.7'), 'utf8'), /Summary only|Synthetic source evidence/)
}))

test('all four types, history ledger and thirty-two archives fit one recoverable forty-one-file withdrawal', () => box(dir => {
  for (const type of ['user', 'feedback', 'project', 'reference']) seed(dir, type)
  for (const base of ['.audit.jsonl', '.history.jsonl']) for (let suffix = 1; suffix <= 16; suffix++) writeFileSync(join(dir, `${base}.${suffix}`), readFileSync(join(dir, base)))
  const preview = withdrawManagedSource(dir, 'archive-source', 'message-1')
  assert.equal(preview.files.length, 40) // Candidate state is added at commit.
  assert.ok(preview.files.includes('.episodes.json'))
  assert.equal(apply(dir).effectiveRemoved, 4)
  for (const name of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, name), 'utf8'), /durable choice|withdrawn evidence|Synthetic source evidence/, name)
  assert.equal(listCandidates(dir, { status: 'withdrawn' }).total, 4)
  assert.equal(searchStore(dir,'durable choice',{view:'history'}).hits.length,0)
}))

for (const name of ['.audit.jsonl.17', '.history.jsonl.0', '.history.jsonl.02', '.audit.jsonl.gz']) test(`unsupported archive ${name} refuses before changing authoritative files`, () => box(dir => {
  seed(dir)
  writeFileSync(join(dir, name), 'synthetic unclassified archive\n')
  const before = snapshot(dir)
  assert.throws(() => withdrawManagedSource(dir, 'archive-source', 'message-1'), /unsupported-log-archive/)
  for (const [file, raw] of before) assert.equal(readFileSync(join(dir, file), 'utf8'), raw)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
}))

for (const kind of ['symlink', 'hardlink']) test(`${kind} in numeric archives is rejected without changing the target`, () => box(dir => {
  seed(dir)
  const target = join(dir, 'unrelated.txt')
  const untouched = JSON.stringify({ op: 'unrelated', note: 'unrelated synthetic text' }) + '\n'
  writeFileSync(target, untouched)
  if (kind === 'symlink') symlinkSync(target, join(dir, '.audit.jsonl.2'))
  else linkSync(target, join(dir, '.audit.jsonl.2'))
  assert.throws(() => withdrawManagedSource(dir, 'archive-source', 'message-1'), kind === 'hardlink' ? /linked-log/ : undefined)
  assert.equal(readFileSync(target, 'utf8'), untouched)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
}))

test('corrupt older archive refuses before partially clearing other source copies', () => box(dir => {
  seed(dir)
  writeFileSync(join(dir, '.history.jsonl.3'), '{incomplete')
  const before = snapshot(dir)
  assert.throws(() => withdrawManagedSource(dir, 'archive-source', 'message-1'), /corrupt-log/)
  for (const [name, raw] of before) assert.equal(readFileSync(join(dir, name), 'utf8'), raw)
}))

test('per-file and combined archive read limits refuse with original data preserved', () => box(dir => {
  seed(dir)
  const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
  writeFileSync(join(dir, '.audit.jsonl.2'), 'x'.repeat(MANAGED_LOG_BYTES + 1))
  assert.throws(() => withdrawManagedSource(dir, 'archive-source', 'message-1'))
  rmSync(join(dir, '.audit.jsonl.2'))
  const raw = JSON.stringify({ op: 'unrelated', note: 'x'.repeat(1024 * 1024 - 100) }) + '\n'
  const count = Math.floor(MANAGED_LOG_TOTAL_BYTES / Buffer.byteLength(raw)) + 1
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `${i < 16 ? '.audit' : '.history'}.jsonl.${i % 16 + 1}`), raw)
  assert.throws(() => withdrawManagedSource(dir, 'archive-source', 'message-1'), /log-budget-exceeded/)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), before)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
}))

for (const phase of ['journal', 8]) test(`archive withdrawal interrupted at ${phase} blocks reads and recovers remaining archives`, () => box(dir => {
  seed(dir)
  for (let i = 1; i <= 16; i++) writeFileSync(join(dir, `.audit.jsonl.${i}`), readFileSync(join(dir, '.audit.jsonl')))
  assert.throws(() => apply(dir, { publicationFault: event => { if (event.phase === phase || event.phase === 'file' && event.index === phase) throw new Error('controlled-interruption') } }), /controlled-interruption/)
  assert.throws(() => searchStore(dir, 'durable choice'), /needs-recovery/)
  assert.equal(recoverMemoryPublication(dir, { apply: true }).applied, true)
  for (let i = 1; i <= 16; i++) assert.doesNotMatch(readFileSync(join(dir, `.audit.jsonl.${i}`), 'utf8'), /durable choice|Synthetic source evidence/)
  assert.equal(searchStore(dir, 'durable choice').hits.length, 0)
}))

test('restored earlier log cannot reintroduce withdrawn current-view records', () => box(dir => {
  seed(dir)
  const index = readFileSync(join(dir, 'MEMORY.md')), audit = readFileSync(join(dir, '.audit.jsonl'))
  writeFileSync(join(dir, '.audit.jsonl.2'), audit)
  apply(dir)
  writeFileSync(join(dir, '.audit.jsonl.2'), audit)
  writeFileSync(join(dir, 'MEMORY.md'), index)
  assert.equal(searchStore(dir, 'durable choice').hits.length, 0)
}))

test('archive publication targets remain a closed filename family', () => box(dir => {
  for (const name of ['../.audit.jsonl.2', '.history.jsonl.17', '.audit.jsonl.01', '.audit.jsonl.2/escape', 'other.jsonl.2']) {
    assert.equal(isManagedLogName(name), false)
    assert.throws(() => withLock(dir, () => commitPublication(dir, [{ name, text: '{}' }])), /invalid-writes/)
    assert.equal(existsSync(join(dir, '.publication.json')), false)
  }
}))

test('forty-one-file withdrawal survives actual SIGKILL and finishes history/archive cleanup after lock expiry', () => box(dir => {
  for (const type of ['user', 'feedback', 'project', 'reference']) seed(dir, type)
  for (const base of ['.audit.jsonl', '.history.jsonl']) for (let suffix = 1; suffix <= 16; suffix++) writeFileSync(join(dir, `${base}.${suffix}`), readFileSync(join(dir, base)))
  const preview = withdrawManagedSource(dir, 'archive-source', 'message-1')
  const options = { apply: true, reviewedIndex: preview.reviewedIndex, candidateRevision: preview.candidateRevision }
  const worker = `import {withdrawManagedSource} from ${JSON.stringify(new URL('./index.mjs', import.meta.url).href)};withdrawManagedSource(process.argv[1],'archive-source','message-1',{...JSON.parse(process.argv[2]),publicationFault:event=>{if(event.phase==='file'&&event.index===34)process.kill(process.pid,'SIGKILL')}})`
  const stopped = spawnSync(process.execPath, ['--input-type=module', '-e', worker, dir, JSON.stringify(options)], { encoding: 'utf8', timeout: 15000 })
  assert.equal(stopped.signal, 'SIGKILL', stopped.stderr)
  const journal=JSON.parse(readFileSync(join(dir, '.publication.json')))
  assert.equal(journal.files.length, 41)
  assert.ok(journal.files.some(file=>file.name==='.episodes.json'))
  assert.throws(() => searchStore(dir, 'durable choice'), /needs-recovery/)
  const expired = new Date(Date.now() - 20000)
  utimesSync(join(dir, '.write.lock'), expired, expired)
  assert.equal(recoverMemoryPublication(dir, { apply: true }).applied, true)
  assert.equal(listCandidates(dir, { status: 'withdrawn' }).total, 4)
  assert.equal(searchStore(dir,'durable choice',{view:'history'}).hits.length,0)
  for (const name of readdirSync(dir)) assert.doesNotMatch(readFileSync(join(dir, name), 'utf8'), /durable choice|withdrawn evidence|Synthetic source evidence/, name)
}))
