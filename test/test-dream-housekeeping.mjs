import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deduplicateDreamIndex } from '../dream-housekeeping.mjs'
import { indexLine, readDreamProject, tidyDreamIndex, writeMemory } from '../index.mjs'
import { ensureManagedProject } from '../managed-access.mjs'
import { projectStoreDir } from '../project-stores.mjs'
import { startManagedRuntime } from '../runtime-startup.mjs'

const line = '- [project] 交付说明统一用中文 — 索引摘要'
const other = '- [project] 仅这一次交付用中文 — 索引摘要'
const digest = text => createHash('sha256').update(text).digest('hex')

test('exact dedup preserves frontmatter, headings, similar rows, and fenced content', () => {
  const lines = ['---', 'description: fixture', '---', '# 项目', line, other, line,
    '~~~md', line, line, '~~~', '## 另一节', line]
  const source = lines.join('\r\n')
  const expected = lines.filter((_, index) => index !== 6).join('\r\n')
  assert.deepEqual(deduplicateDreamIndex(source), { text: expected, removed: 1 })
  assert.deepEqual(deduplicateDreamIndex(expected), { text: expected, removed: 0 })
})

test('housekeeping publishes only the duplicate project index and leaves its history and sources unchanged', t => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-tidy-')))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const root = join(temp, 'memory'), cwd = join(temp, 'project'), otherCwd = join(temp, 'other')
  mkdirSync(cwd)
  mkdirSync(otherCwd)
  assert.equal(startManagedRuntime(root).state, 'managed')
  const dir = projectStoreDir(root, cwd)
  ensureManagedProject(root, dir)
  const summary = '交付说明统一用中文'
  const added = writeMemory({ dir, scope: 'project', type: 'project', summary, line: indexLine('project', summary, undefined, false),
    meaning: { kind: 'decision' },
    provenance: { basis: 'tool-context', sessionId: 'fixture-session', callHash: digest('write'),
      evidence: [{ messageId: 'fixture-source', hash: digest(summary), quote: summary }] } })
  const index = join(dir, 'MEMORY.md')
  const original = readFileSync(index, 'utf8')
  writeFileSync(index, original + added.indexLine + '\n')
  const storeBytes = file => readFileSync(join(dir, file))
  const prior = new Map(['.candidates.json', '.history.jsonl', '.episodes.json'].map(file => [file, storeBytes(file)]))
  assert.equal(existsSync(join(root, 'MEMORY.md')), false)
  const before = readDreamProject(root, cwd, project => project.records)
  assert.deepEqual(tidyDreamIndex(root, otherCwd), { removed: 0 })
  assert.deepEqual(tidyDreamIndex(root, cwd), { removed: 1 })
  assert.equal(readFileSync(index, 'utf8'), original)
  for (const [file, bytes] of prior) assert.deepEqual(storeBytes(file), bytes)
  assert.deepEqual(readDreamProject(root, cwd, project => project.records), before)
  assert.equal(existsSync(join(root, 'MEMORY.md')), false)
  assert.deepEqual(tidyDreamIndex(root, cwd), { removed: 0 })
})
