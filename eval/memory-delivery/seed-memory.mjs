import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [armPath, packagePath, sourcesPath, rawIndexPath, rawArchivePath] = process.argv.slice(2)
assert.ok(armPath && packagePath && sourcesPath, 'Supply isolated arm, unpacked package, and sources')
const arm = resolve(armPath)
const receipt = JSON.parse(readFileSync(join(arm, 'prepared.json'), 'utf8'))
assert.equal(receipt.arm, arm)
const { indexLine, initializeManagedMemory, writeMemory } = await import(pathToFileURL(join(packagePath, 'index.mjs')))
const { candidateSnapshot } = await import(pathToFileURL(join(packagePath, 'candidates.mjs')))
const { projectStoreDir } = await import(pathToFileURL(join(packagePath, 'project-stores.mjs')))
const digest = data => createHash('sha256').update(data).digest('hex')
const root = join(receipt.home, 'memory')
mkdirSync(root, { mode: 0o700 })
const dir = projectStoreDir(root, receipt.cwd)
mkdirSync(dir, { mode: 0o700, recursive: true })
const inputs = JSON.parse(readFileSync(sourcesPath, 'utf8'))
const records = new Map()
for (const source of inputs.preferences) {
  const { id, quote, summary, supersedes, kind = 'preference', sourceMessageSha256 } = source
  const predecessor = records.get(supersedes)
  assert.ok(id && quote && summary && !records.has(id) && (!supersedes || predecessor))
  assert.ok(['preference', 'decision'].includes(kind))
  assert.ok(sourceMessageSha256 === undefined || /^[a-f0-9]{64}$/.test(sourceMessageSha256))
  const type = kind === 'decision' ? 'project' : 'user'
  const line = indexLine(type, summary, undefined, false)
  writeMemory({
    type, scope: 'project', dir, line, summary, meaning: { kind },
    ...(predecessor && { supersedes: predecessor.line }),
    provenance: {
      basis: 'tool-context', via: 'memory_write', sessionId: inputs.sourceSession ?? 'preapproved-evaluation-history',
      callHash: digest('approved-source\n' + id + '\n' + quote),
      evidence: [{ messageId: id, hash: sourceMessageSha256 ?? digest(quote), quote }],
    },
  })
  records.set(id, { line, sourceSha256: digest(quote), supersedes: supersedes ?? null })
}
if (rawIndexPath && rawArchivePath) {
  const indexPath = join(dir, 'MEMORY.md')
  const index = readFileSync(indexPath, 'utf8')
  writeFileSync(indexPath, index + '\n' + readFileSync(rawIndexPath, 'utf8'), { mode: 0o600 })
  writeFileSync(join(dir, 'reference.md'), readFileSync(rawArchivePath), { mode: 0o600 })
}
const stores = [{ name: '.', role: 'global' }, { name: dir.slice(root.length + 1), role: 'project', scope: 'project' }]
const options = { importLegacy: true }
const plan = initializeManagedMemory(root, stores, options)
initializeManagedMemory(root, stores, { ...options, apply: true, reviewed: plan.review })
const active = candidateSnapshot(dir, 'project').records.filter(row => row.status === 'recorded')
const current = [...records.keys()].filter(id => ![...records.values()].some(row => row.supersedes === id))
assert.equal(active.length, current.length)
for (const id of current) assert.ok(active.some(row => row.indexLine === records.get(id).line))
writeFileSync(join(arm, 'seed-receipt.json'), JSON.stringify({
  inputSha256: digest(readFileSync(sourcesPath)), sources: [...records].map(([id, value]) => ({
    id, sourceSha256: value.sourceSha256, supersedes: value.supersedes,
  })),
  active: active.map(row => ({ id: row.id, sourceRoots: row.sources })),
  rawHistorySha256: rawArchivePath ? digest(readFileSync(rawArchivePath)) : null,
}, null, 2) + '\n', { mode: 0o600 })
