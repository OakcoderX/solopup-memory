import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openDreamQueue } from '../dream-queue.mjs'

const INITIAL_TIME = Date.UTC(2026, 10, 13, 12)
const inputHash = (text) => createHash('sha256').update(text).digest('hex')

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'solopup-dream-queue-'))
  const dataRoot = join(dir, 'memory')
  let clock = INITIAL_TIME
  const queues = new Set()
  t.after(() => {
    for (const queue of queues) queue.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const open = () => {
    const queue = openDreamQueue(dataRoot, { now: () => clock, ...options })
    queues.add(queue)
    return queue
  }
  return {
    dataRoot,
    open,
    queue: open(),
    close(queue) {
      queue.close()
      queues.delete(queue)
    },
    advance(ms) { clock += ms }
  }
}

function enqueue(queue, label, projectId = 'test-project', checkpoint = label) {
  return queue.enqueue({
    projectId,
    inputHash: inputHash(label),
    policyVersion: 'review-v1',
    checkpoint,
    metadata: { itemKeys: [label] }
  })
}

test('only one owner can claim, reserve, and commit the same batch and its item progress', (t) => {
  const env = fixture(t)
  const q = env.queue
  const second = env.open()
  const { runId } = enqueue(q, 'entry-v1')
  assert.equal(enqueue(second, 'entry-v1').runId, runId)
  assert.equal(q.scanCheckpoint('test-project'), 'entry-v1')
  assert.equal(q.wasReviewed('test-project', 'entry-v1'), false)
  const claim = q.claim({ owner: 'one' })
  assert.equal(claim.runId, runId)
  assert.deepEqual(claim.metadata, { itemKeys: ['entry-v1'] })
  assert.equal(second.claim({ owner: 'two' }), undefined)
  assert.equal(q.beginDispatch(claim, { reservedTokens: 600 }).status, 'dispatching')
  assert.equal(second.beginDispatch(claim, { reservedTokens: 600 }), undefined)
  assert.equal(q.markRunning(claim, { remoteId: 'worker-1' }).status, 'running')
  assert.equal(second.markRunning(claim, { remoteId: 'worker-2' }), undefined)

  const payload = { items: [{ targetId: 'entry', action: 'keep' }] }
  assert.throws(() => q.finish(claim, {
    status: 'completed', report: payload, usedTokens: 300, reviewedItemKeys: ['not-selected']
  }), /unexpected-reviewed-item/)
  assert.equal(q.report(runId), undefined)
  assert.equal(q.status().budget.tokens, 600)
  const completed = q.finish(claim, {
    status: 'completed', report: payload, usedTokens: 300, reviewedItemKeys: ['entry-v1']
  })
  assert.equal(completed.status, 'completed')
  assert.equal(second.finish(claim, { status: 'completed', report: payload, usedTokens: 300 }), undefined)
  env.close(q)
  const reopened = env.open()
  assert.deepEqual(reopened.report(runId), payload)
  assert.deepEqual(reopened.listReports(), [{ runId, projectId: 'test-project', mode: 'ordinary', completedAt: INITIAL_TIME }])
  assert.deepEqual(reopened.listReports({ projectId: 'other' }), [])
  assert.equal(reopened.wasReviewed('test-project', 'entry-v1'), true)
  assert.equal(reopened.status().budget.tokens, 300)
  assert.equal(reopened.status().budget.attempts, 1)
  assert.equal(reopened.invalidateReport(runId).status, 'invalidated')
  assert.equal(reopened.report(runId), undefined)
  assert.equal(reopened.wasReviewed('test-project', 'entry-v1'), false)
})

test('only selected projects compete for the next batch and a waiting project goes first', t => {
  const env = fixture(t, { autoIntervalMs: 1 })
  const q = env.queue
  enqueue(q, 'unapproved', 'unapproved')
  enqueue(q, 'first', 'project-a')
  assert.equal(q.claim({ owner: 'none', projectIds: [] }), undefined)
  const first = q.claim({ owner: 'runtime', projectIds: ['project-a', 'project-b'] })
  assert.equal(first.projectId, 'project-a')
  assert.equal(q.beginDispatch(first, { reservedTokens: 300 }).status, 'dispatching')
  assert.equal(q.finish(first, { status: 'completed', report: { items: [] }, usedTokens: 100 }).status, 'completed')
  env.advance(2)
  enqueue(q, 'second', 'project-a')
  enqueue(q, 'waiting', 'project-b')
  assert.equal(q.claim({ owner: 'runtime', projectIds: ['project-a', 'project-b'] }).projectId, 'project-b')
})

test('prepared handoff preserves the batch ID and fences the old claim', (t) => {
  const { queue } = fixture(t)
  const { runId } = enqueue(queue, 'transfer')
  const original = queue.claim({ owner: 'ordinary' })
  const cutover = queue.requestMode('superagent')
  assert.equal(cutover.mode, 'superagent')
  assert.equal(cutover.epoch, 2)
  assert.equal(queue.beginDispatch(original, { reservedTokens: 100 }), undefined)
  const next = queue.claim({ owner: 'worker' })
  assert.equal(next.mode, 'superagent')
  assert.equal(next.runId, runId)
  assert.equal(next.attempt, original.attempt + 1)
  assert.equal(queue.release(original), undefined)
  assert.equal(queue.release(next).status, 'queued')
  assert.equal(queue.status().budget.attempts, 0)
})

test('cutover drains a known active dispatch and rejects late completion from the old executor', (t) => {
  const env = fixture(t, { autoIntervalMs: 0 })
  const q = env.queue
  const first = enqueue(q, 'first')
  const old = q.claim({ owner: 'ordinary', runId: first.runId })
  q.beginDispatch(old, { reservedTokens: 50 })
  const second = enqueue(q, 'second')
  const waiting = q.requestMode('superagent')
  assert.equal(waiting.mode, 'ordinary')
  assert.equal(waiting.pendingMode, 'superagent')
  assert.equal(q.claim({ owner: 'worker', runId: second.runId }), undefined)

  env.close(q)
  const reopened = env.open()
  assert.equal(reopened.status().pendingMode, 'superagent')
  const receipt = reopened.finish(old, { status: 'completed', report: { items: [] }, usedTokens: 30 })
  assert.equal(receipt.mode, 'ordinary')
  assert.equal(reopened.status().mode, 'superagent')
  assert.equal(reopened.status().epoch, old.epoch + 1)
  assert.equal(reopened.finish(old, { status: 'completed', report: { items: [] }, usedTokens: 30 }), undefined)

  const next = reopened.claim({ owner: 'worker', runId: second.runId })
  reopened.beginDispatch(next, { reservedTokens: 50 })
  assert.equal(reopened.requestMode('ordinary').pendingMode, 'ordinary')
  assert.equal(reopened.finish(next, { status: 'cancelled', usedTokens: 0 }).status, 'cancelled')
  assert.equal(reopened.status().mode, 'ordinary')
  assert.equal(reopened.status().epoch, 3)
})

test('restart requeues expired preparation but freezes a potentially sent dispatch until explicit reconciliation', (t) => {
  const env = fixture(t, { leaseMs: 1000 })
  const q = env.queue
  const first = enqueue(q, 'first')
  const second = enqueue(q, 'second', 'other-project')
  const old = q.claim({ owner: 'gone', runId: first.runId })
  env.advance(1000)
  assert.equal(q.recover().active, undefined)
  const replacement = q.claim({ owner: 'replacement', runId: first.runId })
  assert.equal(replacement.runId, old.runId)
  q.beginDispatch(replacement, { reservedTokens: 800 })
  env.close(q)

  env.advance(1000)
  const reopened = env.open()
  assert.equal(reopened.recover().active.status, 'uncertain')
  assert.equal(reopened.status().budget.tokens, 800)
  assert.equal(reopened.requestMode('superagent').pendingMode, 'superagent')
  assert.equal(reopened.claim({ owner: 'new', runId: second.runId }), undefined)
  assert.equal(reopened.finish(replacement, { status: 'completed', report: { items: [] } }), undefined)
  assert.equal(reopened.beginDispatch(replacement, { reservedTokens: 800 }), undefined)
  assert.throws(() => reopened.resolveUncertain(first.runId, { status: 'queued' }), /invalid-reconciliation/)
  assert.equal(reopened.resolveUncertain(first.runId, { status: 'cancelled' }).status, 'cancelled')
  assert.equal(reopened.status().mode, 'superagent')
  assert.equal(reopened.status().budget.tokens, 800)
  assert.equal(reopened.claim({ owner: 'new', runId: first.runId }), undefined)
  assert.equal(reopened.claim({ owner: 'new', runId: second.runId }).mode, 'superagent')
})

test('daily reservation and per-project automatic interval are shared across executors', (t) => {
  const env = fixture(t, { maxDailyAttempts: 2, maxDailyTokens: 100 })
  const q = env.queue
  const first = enqueue(q, 'first')
  const followup = enqueue(q, 'followup')
  const other = enqueue(q, 'other', 'other-project')
  const claim = q.claim({ owner: 'ordinary', runId: first.runId })
  q.beginDispatch(claim, { reservedTokens: 80 })
  q.finish(claim, { status: 'completed', report: { items: [] }, usedTokens: 50 })
  q.requestMode('superagent')
  assert.equal(q.claim({ owner: 'worker', runId: followup.runId }), undefined)
  const next = q.claim({ owner: 'worker', runId: other.runId })
  assert.equal(q.beginDispatch(next, { reservedTokens: 51 }), undefined)
  assert.equal(q.beginDispatch(next, { reservedTokens: 50 }).mode, 'superagent')
  q.finish(next, { status: 'completed', report: { items: [] } })
  assert.equal(q.status().budget.tokens, 100)
  assert.equal(q.claim({ owner: 'manual', manual: true, runId: followup.runId }), undefined)

  env.advance(43_200_000)
  assert.equal(q.status().budget.attempts, 0)
  assert.equal(q.claim({ owner: 'worker', runId: followup.runId }), undefined)
  assert.equal(q.claim({ owner: 'manual', manual: true, runId: followup.runId }).runId, followup.runId)
})

test('next automatic wake accounts for lease, budget, and an empty queue', (t) => {
  const env = fixture(t, { leaseMs: 200, maxDailyAttempts: 1, autoIntervalMs: 0 })
  const q = env.queue
  assert.equal(q.nextAutomaticAt(), undefined)
  const first = enqueue(q, 'first')
  assert.equal(q.nextAutomaticAt(), INITIAL_TIME)
  const claim = q.claim({ owner: 'ordinary', runId: first.runId })
  assert.equal(q.nextAutomaticAt(), INITIAL_TIME + 200)
  q.beginDispatch(claim, { reservedTokens: 100 })
  q.finish(claim, { status: 'completed', report: { items: [] }, usedTokens: 80 })
  assert.equal(q.nextAutomaticAt(), undefined)
  enqueue(q, 'second')
  assert.equal(q.nextAutomaticAt(), Date.UTC(2026, 10, 14))
  env.advance(43_200_000)
  assert.equal(q.nextAutomaticAt(), Date.UTC(2026, 10, 14))
})

test('a local executor request needs readiness acknowledgment and stale acknowledgments do not switch mode', (t) => {
  const env = fixture(t)
  const first = env.queue.requestExecutor('superagent')
  assert.equal(env.queue.status().mode, 'ordinary')
  assert.equal(env.queue.requestExecutor('superagent').id, first.id)
  const reopened = env.open()
  assert.equal(reopened.pendingExecutorRequest().id, first.id)
  const second = reopened.requestExecutor('ordinary')
  assert.equal(env.queue.acceptExecutorRequest(first.id), undefined)
  assert.equal(env.queue.rejectExecutorRequest(second.id, { reason: 'unavailable' }).status, 'rejected')
  assert.equal(env.queue.status().executorRequest.reason, 'unavailable')
  assert.equal(env.queue.pendingExecutorRequest(), undefined)
  assert.equal(env.queue.status().mode, 'ordinary')
  const third = env.queue.requestExecutor('superagent')
  assert.equal(reopened.acceptExecutorRequest(third.id).status, 'accepted')
  assert.equal(env.queue.status().mode, 'superagent')
  assert.equal(reopened.acceptExecutorRequest(third.id), undefined)
})

test('validated Worker ticket binding is persisted, enrichable and fenced', (t) => {
  const env = fixture(t)
  const q = env.queue
  q.requestMode('superagent')
  const { runId, projectId } = enqueue(q, 'binding')
  const claim = q.claim({ owner: 'worker' })
  q.beginDispatch(claim, { reservedTokens: 600 })
  const binding = {
    runId, attempt: claim.attempt, projectId, inputDigest: inputHash('review-input'),
    runtimeId: 'runtime', isolationId: 'isolation', ticketId: 'ticket1',
  }
  assert.throws(() => q.markRunning(claim, { remoteId: 'ticket1', binding: { ...binding, attempt: 2 } }), /invalid-remote-binding/)
  assert.deepEqual(q.markRunning(claim, { remoteId: 'ticket1', binding }).remoteBinding, binding)
  const withWorker = { ...binding, workerSessionId: 'worker-ticket1' }
  assert.deepEqual(q.markRunning(claim, { remoteId: 'ticket1', binding: withWorker }).remoteBinding, withWorker)
  assert.throws(() => q.markRunning(claim, { remoteId: 'ticket1', binding: { ...withWorker, runtimeId: 'other' } }), /changed-remote-binding/)
  const reopened = env.open()
  assert.deepEqual(reopened.getRun(runId).remoteBinding, withWorker)
})

test('known retries are bounded, and known unused budget can be released', (t) => {
  const { queue: q } = fixture(t, { maxRunDispatches: 2 })
  const { runId } = enqueue(q, 'retry')
  const first = q.claim({ owner: 'one', manual: true, runId })
  q.beginDispatch(first, { reservedTokens: 700 })
  assert.throws(() => q.finish(first, { status: 'retryable' }), /retry-requires-termination-proof/)
  assert.equal(q.finish(first, {
    status: 'retryable', confirmedUnsent: true, retryAfterMs: 0
  }).status, 'queued')
  assert.equal(q.status().budget.attempts, 0)

  const second = q.claim({ owner: 'two', manual: true, runId })
  q.beginDispatch(second, { reservedTokens: 500 })
  assert.equal(q.finish(second, {
    status: 'retryable', usedTokens: 20, retryAfterMs: 0
  }).status, 'failed')
  assert.equal(q.claim({ owner: 'three', manual: true, runId }), undefined)
  assert.equal(q.status().budget.tokens, 20)
})

test('reported use beyond the reservation counts against budget and invalidates the report', (t) => {
  const { queue: q } = fixture(t)
  const { runId } = enqueue(q, 'over-budget')
  const claim = q.claim({ owner: 'worker', runId })
  q.beginDispatch(claim, { reservedTokens: 500 })
  const result = q.finish(claim, {
    status: 'completed', report: { items: [] }, usedTokens: 600, reviewedItemKeys: ['over-budget']
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'reservation-exceeded')
  assert.equal(q.report(runId), undefined)
  assert.equal(q.wasReviewed('test-project', 'over-budget'), false)
  assert.equal(q.status().budget.tokens, 600)
})

function runChild(script, args, expectedSignal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if ((expectedSignal && signal === expectedSignal) || (!expectedSignal && code === 0)) resolve(out.trim())
      else reject(new Error(`Child exit ${code ?? signal}: ${err}`))
    })
  })
}

test('simultaneous processes cannot both claim the same persisted batch', async (t) => {
  const env = fixture(t)
  const { runId } = enqueue(env.queue, 'race')
  const script = `
    import { openDreamQueue } from ${JSON.stringify(new URL('../dream-queue.mjs', import.meta.url).href)};
    const [path, owner, runId] = process.argv.slice(1);
    const queue = openDreamQueue(path, { now: () => Date.UTC(2026, 10, 13, 12) });
    const claim = queue.claim({ owner, runId });
    if (claim) queue.beginDispatch(claim, { reservedTokens: 100 });
    console.log(claim?.owner ?? 'none');
    queue.close();
  `
  const owners = await Promise.all([
    runChild(script, [env.dataRoot, 'one', runId]),
    runChild(script, [env.dataRoot, 'two', runId])
  ])
  assert.equal(owners.filter((value) => value !== 'none').length, 1)
  assert.equal(env.queue.status().active.status, 'dispatching')
})

test('an abruptly killed dispatcher leaves durable dispatch intent and budget', async (t) => {
  const env = fixture(t, { leaseMs: 500 })
  const { runId } = enqueue(env.queue, 'killed')
  const script = `
    import { openDreamQueue } from ${JSON.stringify(new URL('../dream-queue.mjs', import.meta.url).href)};
    const [path, runId] = process.argv.slice(1);
    const queue = openDreamQueue(path, { now: () => Date.UTC(2026, 10, 13, 12), leaseMs: 500 });
    const claim = queue.claim({ owner: 'crashing', runId });
    if (queue.beginDispatch(claim, { reservedTokens: 100 })?.status !== 'dispatching') process.exit(1);
    process.kill(process.pid, 'SIGKILL');
  `
  await runChild(script, [env.dataRoot, runId], 'SIGKILL')
  assert.equal(env.queue.status().active.status, 'dispatching')
  env.advance(500)
  assert.equal(env.queue.recover().active.status, 'uncertain')
  assert.equal(env.queue.status().budget.tokens, 100)
  assert.equal(env.queue.claim({ owner: 'recovery', runId }), undefined)
})

test('state is private and a symlinked database file is refused', (t) => {
  const env = fixture(t)
  const stateDir = env.dataRoot + '.dream'
  const path = join(stateDir, 'state.sqlite')
  assert.equal(statSync(stateDir).mode & 0o777, 0o700)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  env.close(env.queue)
  rmSync(path)
  symlinkSync('missing', path)
  assert.throws(() => env.open(), /unsafe-database-file/)
})

test('operator access never initializes a missing queue', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'solopup-dream-existing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'memory')
  assert.throws(() => openDreamQueue(root, { existingOnly: true }), /not-initialized/)
  assert.equal(existsSync(root + '.dream'), false)
  openDreamQueue(root).close()
  const existing = openDreamQueue(root, { existingOnly: true })
  try { assert.equal(existing.status().mode, 'ordinary') } finally { existing.close() }
})
