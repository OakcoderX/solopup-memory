import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  createSuperAgentDreamExecutor, SUPER_AGENT_DREAM_PROTOCOL, SUPER_AGENT_DREAM_PROTOTYPE,
} from '../dream-superagent.mjs'

const ticketId = 'f'.repeat(32)
const projectId = 'a'.repeat(64)
const recordId = 'b'.repeat(64)
const sourceId = 'c'.repeat(64)
const input = {
  schema: 1, projectId, storeRevision: 'd'.repeat(64),
  items: [{ id: recordId, summary: 'The approved product label is teal.',
    sources: [{ id: sourceId, hash: 'e'.repeat(64), quote: 'Use teal for the product label.', kind: 'original' }] }],
}
const route = { provider: 'deepseek', model: 'deepseek/deepseek-chat' }
const output = JSON.stringify({ items: [{ id: 'm1', verdict: 'keep', sourceIds: ['s1'], reason: 'The user explicitly approved teal.' }] })
const usage = { inputTokens: 460, outputTokens: 120, totalTokens: 580 }
const run = { runId: 'dream-opaque-run', attempt: 1, route, maxTokens: 1800, maxTotalTokens: 3300, beforeDispatch() {} }

function proof(challenge) {
  return { protocol: SUPER_AGENT_DREAM_PROTOCOL, challenge, source: 'solopup-dream', prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE,
    runtimeId: 'runtime-one', isolationId: 'os-isolation-one' }
}

function receipt(binding, worker = false, id = ticketId) {
  return { ...binding, ticketId: id, ...(worker ? { workerSessionId: `worker-${id}` } : {}) }
}

function fixture(overrides = {}, verifyIsolation = async () => true) {
  const envelopeLog = []
  const service = {
    async probe({ challenge }) { return proof(challenge) },
    async dispatch(envelope, { onReceipt }) {
      envelopeLog.push(envelope)
      onReceipt(receipt(envelope.binding))
      return { receipt: receipt(envelope.binding, true), output, usage }
    },
    async status(binding) { return { state: 'completed', receipt: receipt(binding, true) } },
    async cancel(binding) { return { state: 'cancelled', receipt: receipt(binding) } },
    ...overrides,
  }
  const owner = new AbortController()
  const state = { value: service, generation: 1, signal: owner.signal }
  const executor = createSuperAgentDreamExecutor({ getBridge: () => state, verifyIsolation, now: () => 0 })
  return { executor, envelopeLog, owner, state }
}

test('installation or a self-reported probe cannot establish Super Agent readiness', async () => {
  assert.deepEqual(await createSuperAgentDreamExecutor().ready(), { ready: false, reason: 'dream-superagent-bridge-unavailable' })
  assert.deepEqual(await createSuperAgentDreamExecutor({ getBridge: () => ({ receive() {} }) }).ready(),
    { ready: false, reason: 'dream-superagent-bridge-incompatible' })
  const f = fixture()
  const withoutVerifier = createSuperAgentDreamExecutor({ getBridge: () => f.state })
  assert.deepEqual(await withoutVerifier.ready(), { ready: false, reason: 'dream-superagent-isolation-unverified' })
  await assert.rejects(withoutVerifier.execute(input, run), { notDispatched: true })
  assert.equal(f.envelopeLog.length, 0)
})

test('rejects stale challenges, unknown prototype commits and independently rejected isolation', async () => {
  const invalid = [
    fixture({ probe: () => proof('old-challenge') }),
    fixture({ probe: ({ challenge }) => ({ ...proof(challenge), prototypeCommit: '0'.repeat(40) }) }),
    fixture({}, () => false),
  ]
  for (const f of invalid) {
    assert.equal((await f.executor.ready()).ready, false)
    await assert.rejects(f.executor.execute(input, run), { notDispatched: true })
    assert.equal(f.envelopeLog.length, 0)
  }
})

test('passes only the frozen scoped messages to the companion after admission; the router sees metadata only', async () => {
  let inspected
  const f = fixture({}, ({ request }) => { inspected = request; return true })
  const receipts = []
  let checked = false
  const result = await f.executor.execute(input, { ...run, beforeDispatch: () => { checked = true },
    onReceipt(value) { assert.equal(checked, true); receipts.push(value) } })
  assert.equal(f.envelopeLog.length, 1)
  assert.deepEqual(result, { output, usage, receipt: receipts.at(-1) })
  const envelope = f.envelopeLog[0]
  assert.equal(inspected.projectId, projectId)
  assert.equal(inspected.inputDigest, envelope.binding.inputDigest)
  assert.equal(envelope.maxTotalTokens, run.maxTotalTokens)
  assert.ok(Object.isFrozen(envelope) && Object.isFrozen(envelope.messages[1].content[0]))
  assert.match(envelope.messages[1].content[0].text, /Use teal/)
  for (const privateField of [input.storeRevision, recordId, sourceId, 'Use teal']) {
    assert.ok(!JSON.stringify(envelope.trigger).includes(privateField))
  }
  for (const stableId of [input.storeRevision, recordId, sourceId]) assert.ok(!JSON.stringify(envelope).includes(stableId))
  assert.equal(envelope.trigger.human, false)
  assert.equal(receipts.length, 2)
  assert.equal(receipts[1].workerSessionId, `worker-${ticketId}`)
  const first = envelope.trigger.id
  await f.executor.execute(input, { ...run })
  await f.executor.execute(input, { ...run, attempt: 2 })
  assert.equal(f.envelopeLog[1].trigger.id, first)
  assert.notEqual(f.envelopeLog[2].trigger.id, first)
})

test('stale evidence, missing budget or unloading during the probe prevents dispatch', async () => {
  const f = fixture()
  await assert.rejects(f.executor.execute(input, { ...run, beforeDispatch() { throw Error('dream-evidence-changed') } }), /dream-evidence-changed/)
  await assert.rejects(f.executor.execute(input, { ...run, maxTotalTokens: undefined }), { notDispatched: true })
  await assert.rejects(f.executor.execute({ ...input, items: [] }, run), { notDispatched: true })
  const uninstalled = fixture({}, () => { uninstalled.owner.abort(); return true })
  await assert.rejects(uninstalled.executor.execute(input, run), { notDispatched: true })
  assert.equal(f.envelopeLog.length + uninstalled.envelopeLog.length, 0)
})

test('rejects wrong project, competing tickets, a missing worker receipt and over-budget usage after dispatch', async () => {
  const badResults = [
    (binding, onReceipt) => { onReceipt({ ...receipt(binding), projectId: '1'.repeat(64) }); return {} },
    (binding, onReceipt) => { onReceipt(receipt(binding)); return { receipt: receipt(binding, true, 'e'.repeat(32)), output, usage } },
    binding => ({ receipt: receipt(binding), output, usage }),
    binding => ({ receipt: receipt(binding, true), output, usage: { inputTokens: 3500, outputTokens: 1, totalTokens: 3501 } }),
  ]
  for (const result of badResults) {
    const f = fixture({ dispatch: (envelope, { onReceipt }) => result(envelope.binding, onReceipt) })
    await assert.rejects(f.executor.execute(input, run), { notDispatched: false })
  }
})

test('unloading after submission aborts and fences late output and late receipts', async () => {
  let admitted, complete, receiptLater
  const started = new Promise(resolve => { admitted = resolve })
  const f = fixture({
    dispatch(envelope, { signal, onReceipt }) {
      receiptLater = () => onReceipt(receipt(envelope.binding, true))
      admitted(signal)
      return new Promise(resolve => { complete = () => resolve({ receipt: receipt(envelope.binding, true), output, usage }) })
    },
  })
  const receipts = []
  const pending = f.executor.execute(input, { ...run, onReceipt: value => receipts.push(value) })
  const signal = await started
  f.owner.abort()
  assert.equal(signal.aborted, true)
  await assert.rejects(pending, { code: 'dream-superagent-dispatch-uncertain', notDispatched: false })
  assert.throws(receiptLater, { code: 'dream-superagent-invalid-receipt' })
  complete()
  assert.deepEqual(receipts, [])
})

test('status and cancellation require a verified matching runtime and ticket binding', async () => {
  const f = fixture()
  const result = await f.executor.execute(input, run)
  assert.deepEqual(await f.executor.status(result.receipt), { state: 'completed', receipt: result.receipt })
  assert.equal((await f.executor.cancel(result.receipt)).state, 'cancelled')
  assert.deepEqual(await f.executor.status({ ...result.receipt, ticketId: 'e'.repeat(32) }), { state: 'uncertain' })
  assert.deepEqual(await f.executor.cancel({ ...result.receipt, runtimeId: 'different-runtime' }), { state: 'uncertain' })
  f.owner.abort()
  assert.deepEqual(await f.executor.status(result.receipt), { state: 'uncertain' })
})

test('removing the independent verifier also aborts a running dispatch', async () => {
  let started
  const executing = new Promise(resolve => { started = resolve })
  const f = fixture({ dispatch(_envelope, { signal }) { started(signal); return new Promise(() => {}) } })
  const verifier = new AbortController()
  const isolation = { value: { verify: () => true }, signal: verifier.signal, generation: 1 }
  const executor = createSuperAgentDreamExecutor({ getBridge: () => f.state, getIsolation: () => isolation })
  const pending = executor.execute(input, run)
  const executionSignal = await executing
  verifier.abort()
  assert.equal(executionSignal.aborted, true)
  await assert.rejects(pending, { code: 'dream-superagent-dispatch-uncertain', notDispatched: false })
  assert.equal((await executor.ready()).ready, false)
})

const prototypeCore = process.env.SOLOPUP_DREAM_SUPERAGENT_CORE
test('optional upstream Engine intake smoke: local Source creates one Ticket without exposing evidence', { skip: !prototypeCore }, async () => {
  const { Engine, MemoryRepositories } = await import(pathToFileURL(prototypeCore).href)
  const repo = new MemoryRepositories()
  let candidate, assignment
  const allowed = trigger => trigger.source === 'solopup-dream' && trigger.actor.id === 'solopup-runtime'
  const policy = { version: 'lab', paused: false, evalTimeoutMs: 60_000, revalidate: () => true, admitsInferred: () => true,
    gate: trigger => allowed(trigger) ? { admissible: true, strength: 'inferred', basis: { via: 'solopup-lab' } } : { admissible: false, reason: 'unknown-source' } }
  const engine = new Engine({ repo, policy: () => policy,
    scope: { scope: trigger => ({ listened: allowed(trigger), observed: true }) },
    assessor: { request(value) { candidate = value }, release() {} },
    executor: { start(ticket) { assignment = ticket }, deliver() {}, stop() {} },
    outbox: { send() {}, withdraw() {}, status() {} }, now: () => new Date(1000).toISOString(),
  })
  const f = fixture({ dispatch(envelope, { onReceipt }) {
    assert.equal(engine.receive(envelope.trigger), 'stored')
    assert.equal(engine.receive(envelope.trigger), 'duplicate')
    engine.evaluateDue()
    assert.ok(candidate)
    assert.ok(!JSON.stringify(candidate).includes('Use teal'))
    const decision = engine.decide(envelope.trigger.id, { kind: 'accept', title: 'Review project evidence', scope: 'isolated memory review',
      reason: 'locally admitted', acknowledgement: '', ruleIds: [], evalId: candidate.evalId })
    assert.equal(assignment.id, decision.ticketId)
    onReceipt(receipt(envelope.binding, false, decision.ticketId))
    return { receipt: receipt(envelope.binding, true, decision.ticketId), output, usage }
  } })
  const result = await f.executor.execute(input, run)
  assert.equal(result.receipt.ticketId, assignment.id)
})

// Separate from the Engine smoke: this proves a real process boundary for synthetic
// files and network access, not that an installed Super Agent uses this boundary.
test('optional macOS isolation smoke: a process reads its evidence and cannot reach another project or a network canary',
  { skip: process.platform !== 'darwin' || process.env.SOLOPUP_DREAM_SEATBELT_SMOKE !== '1' }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-isolation-')))
    const network = createServer()
    try {
      await new Promise((resolve, reject) => network.once('error', reject).listen(0, '127.0.0.1', resolve))
      const evidence = join(root, 'evidence')
      const reports = join(root, 'reports')
      const other = join(root, 'other-project.txt')
      mkdirSync(evidence)
      mkdirSync(reports)
      writeFileSync(join(evidence, 'input.txt'), 'allowed synthetic evidence')
      writeFileSync(other, 'other project canary')
      symlinkSync(other, join(evidence, 'outside-link'))
      const profile = `(version 1)
        (allow default)
        (deny network*)
        (deny file-read* file-write* (literal ${JSON.stringify(other)}))
        (deny file-write* (subpath ${JSON.stringify(evidence)}))`
      const source = `
        test "$(/bin/cat "$1/input.txt")" = 'allowed synthetic evidence' || exit 10
        /bin/cat "$3" && exit 11
        /bin/cat "$1/outside-link" && exit 12
        (printf overwrite > "$1/input.txt") && exit 13
        /bin/ln "$3" "$2/hardlink" && exit 14
        /usr/bin/nc -G 2 -z 127.0.0.1 "$4" && exit 15
        printf 'report allowed' > "$2/result.txt"`
      const child = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', source, 'solopup-isolation-probe',
        evidence, reports, other, String(network.address().port)], { cwd: reports, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 })
      assert.equal(child.status, 0, [child.error?.message, child.signal, child.stderr].filter(Boolean).join('\n'))
      assert.equal(readFileSync(join(reports, 'result.txt'), 'utf8'), 'report allowed')
      assert.equal(readFileSync(other, 'utf8'), 'other project canary')
    } finally {
      network.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
