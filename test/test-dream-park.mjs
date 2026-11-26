import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { openDreamQueue } from '../dream-queue.mjs'
import { moveDream } from '../scripts/dream-park.mjs'

const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dream-park-')), root = join(dir, 'memory')
try {
  mkdirSync(root, { mode: 0o700 })
  let q = openDreamQueue(root, { now: () => 100000 })
  const run = q.enqueue({ projectId: 'p', inputHash: 'a'.repeat(64), policyVersion: 'v1' })
  const claim = q.claim({ owner: 'worker' })
  q.beginDispatch(claim, { reservedTokens: 123 })
  q.close()
  moveDream(root, 'park')
  // A mistakenly created replacement cannot silently overwrite the archive.
  mkdirSync(root + '.dream', { mode: 0o700 })
  assert.throws(() => moveDream(root, 'reattach'), /target-exists/)
  rmSync(root + '.dream', { recursive: true })
  moveDream(root, 'reattach')
  q = openDreamQueue(root, { now: () => 100001 })
  assert.equal(q.getRun(run.runId).status, 'uncertain')
  assert.equal(q.status().budget.tokens, 123)
  assert.equal(q.claim({ owner: 'another' }), undefined)
  q.close()
  // Exercise the installed pnpm-style symlink entry point, not just imports.
  const link = join(dir, 'node_modules', 'solopup-memory')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(dirname(dirname(fileURLToPath(import.meta.url))), link, 'dir')
  const cli = (...args) => spawnSync(process.execPath, [join(link, 'scripts', 'dream-park.mjs'), ...args], { encoding: 'utf8' })
  const parked = cli('park', root, '--offline-dream-disabled')
  assert.equal(parked.status, 0, parked.stderr)
  assert.equal(JSON.parse(parked.stdout).direction, 'park')
  assert.throws(() => openDreamQueue(root, { existingOnly: true }), /not-initialized/)
  const restored = cli('reattach', root, '--offline-dream-disabled')
  assert.equal(restored.status, 0, restored.stderr)
  assert.equal(JSON.parse(restored.stdout).direction, 'reattach')
  q = openDreamQueue(root, { now: () => 100001 })
  assert.equal(q.getRun(run.runId).status, 'uncertain')
  assert.equal(q.status().budget.tokens, 123)
  q.close()
  console.log('dream park: ok')
} finally { rmSync(dir, { recursive: true, force: true }) }
