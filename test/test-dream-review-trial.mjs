import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runDreamReviewTrial } from '../eval/run-dream-review-trial.mjs'
import { DREAM_REVIEW_FIXTURE_SHA256, DREAM_REVIEW_PROMPT_SHA256 } from '../eval/dream-review-cases.mjs'
import { dreamReviewMessages } from '../dream-review.mjs'

const route = { provider: 'deepseek', model: 'test-v1' }
const parse = path => JSON.parse(readFileSync(path, 'utf8'))

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-trial-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function response(request, overrides) {
  return {
    route: request.route,
    usage: { calls: 1, inputTokens: 4800, outputTokens: 110 },
    output: { items: request.input.items.map((_, index) => ({
      id: `m${index + 1}`, verdict: 'needs-evidence', sourceIds: [], reason: '用于验证执行回执的虚构输出。',
    })) }, ...overrides,
  }
}

test('the default dry plan schedules both frozen batches per mode without filesystem effects', async t => {
  const dir = scratch(t)
  const preview = await runDreamReviewTrial({ dir, route })
  assert.equal(preview.status, 'dry-run')
  assert.equal(preview.semanticTruthEvaluated, false)
  assert.equal(preview.fixtureSha256, DREAM_REVIEW_FIXTURE_SHA256)
  assert.equal(preview.promptSha256, DREAM_REVIEW_PROMPT_SHA256)
  assert.deepEqual(preview.jobs.map(row => [row.batchId, row.mode, row.cases]), [
    ['A', 'ordinary', 5], ['A', 'superagent', 5], ['B', 'ordinary', 5], ['B', 'superagent', 5],
  ])
  assert.equal(preview.jobs[0].inputSha256, preview.jobs[1].inputSha256)
  assert.equal(preview.jobs[2].inputSha256, preview.jobs[3].inputSha256)
  assert.deepEqual(readdirSync(dir), [])
})

test('a clean pause resumes only remaining batches and keeps blind outputs apart from routing metadata', async t => {
  const dir = scratch(t)
  const seen = []
  const transport = { kind: 'scripted', execute(request) {
    assert.deepEqual(request.route, route)
    assert.deepEqual(request.messages, dreamReviewMessages(request.input))
    assert.doesNotMatch(JSON.stringify(request), /criticalReason|expectedVerdict|C01/)
    seen.push(request)
    return response(request)
  } }
  const metadata = { hostVersion: '0.15.1', candidateSha256: 'a'.repeat(64), prototypeCommit: 'b'.repeat(40) }
  const first = await runDreamReviewTrial({ dir, route, transport, metadata, maxBatches: 1 })
  assert.equal(first.status, 'paused')
  assert.equal(first.receipt.jobs.filter(job => job.status === 'completed').length, 1)
  assert.equal(seen.length, 1)
  const second = await runDreamReviewTrial({ dir, route, transport, metadata })
  assert.equal(second.status, 'complete')
  assert.equal(second.receipt.trialId, first.receipt.trialId)
  assert.equal(second.receipt.semanticTruthEvaluated, false)
  assert.deepEqual(second.receipt.totals, { calls: 4, inputTokens: 19_200, outputTokens: 440, unknownBatches: 0 })
  assert.equal(new Set(seen.map(request => request.runId)).size, 4)
  assert.deepEqual(seen[0].messages, seen[1].messages)
  assert.deepEqual(seen[2].messages, seen[3].messages)
  assert.deepEqual(parse(join(dir, 'receipt.json')), second.receipt)
  const files = readdirSync(join(dir, 'blind'))
  assert.equal(files.length, 4)
  for (const file of files) {
    const path = join(dir, 'blind', file)
    const saved = parse(path)
    assert.equal(file, `${saved.label}.json`)
    assert.deepEqual(Object.keys(saved), ['label', 'batchId', 'output'])
    assert.doesNotMatch(JSON.stringify(saved), /ordinary|superagent|deepseek|candidateSha256|criticalReason/)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  }
  assert.equal(statSync(join(dir, 'receipt.json')).mode & 0o777, 0o600)
  assert.doesNotMatch(JSON.stringify(second.receipt), /用于验证执行回执/)
  await assert.rejects(runDreamReviewTrial({ dir, route: { ...route, model: 'changed' }, transport, metadata }), /resume-mismatch/)
  assert.equal(seen.length, 4)
})

test('the driver prevents concurrent claim and preserves an uncertain call without resending', async t => {
  const dir = scratch(t)
  let release, started
  const holding = new Promise(resolve => { release = resolve })
  const dispatch = new Promise(resolve => { started = resolve })
  let calls = 0
  const transport = { kind: 'scripted', async execute() { calls += 1; started(); await holding; throw Error('transport error with a credential') } }
  const first = runDreamReviewTrial({ dir, route, transport })
  await dispatch
  const concurrent = await runDreamReviewTrial({ dir, route, transport })
  assert.equal(concurrent.status, 'busy')
  assert.equal(calls, 1)
  release()
  const uncertain = await first
  assert.equal(uncertain.status, 'needs-review')
  assert.equal(uncertain.receipt.jobs[0].status, 'uncertain')
  assert.equal(uncertain.receipt.totals.unknownBatches, 1)
  assert.doesNotMatch(JSON.stringify(uncertain.receipt), /with a credential/)
  assert.equal((await runDreamReviewTrial({ dir, route, transport })).status, 'needs-review')
  assert.equal(calls, 1)
})

test('an interrupted process cannot send a second request for the same batch', async t => {
  const dir = scratch(t)
  const moduleUrl = new URL('../eval/run-dream-review-trial.mjs', import.meta.url).href
  const source = `
    import { runDreamReviewTrial } from ${JSON.stringify(moduleUrl)};
    await runDreamReviewTrial({ dir: process.argv[1], route: ${JSON.stringify(route)}, transport: {
      kind: 'scripted', execute: async () => { process.stdout.write('dispatched\\n'); await new Promise(() => {}); }
    } });
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir], { stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => child.kill('SIGKILL'))
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('child exited before dispatch') })])
  child.kill('SIGKILL')
  await once(child, 'exit')
  let calls = 0
  const resumed = await runDreamReviewTrial({ dir, route, transport: { kind: 'scripted', execute(request) { calls += 1; return response(request) } } })
  assert.equal(resumed.status, 'needs-review')
  assert.equal(resumed.receipt.jobs[0].reason, 'owner-lost')
  assert.equal(resumed.receipt.jobs[0].status, 'uncertain')
  assert.equal(calls, 0)
})

test('aggregate budgets are enforced before dispatch and mismatched routes cannot complete a batch', async t => {
  const dir = scratch(t)
  let calls = 0
  const transport = { kind: 'scripted', execute(request) {
    assert.equal(request.budget.calls, 1)
    calls += 1
    return response(request)
  } }
  const limits = { calls: 2, inputTokens: 18_000, outputTokens: 500 }
  const batchCaps = { calls: 1, inputTokens: 6500, outputTokens: 130 }
  const result = await runDreamReviewTrial({ dir, route, transport, limits, batchCaps })
  assert.equal(result.status, 'budget-exhausted')
  assert.equal(calls, 2)
  assert.equal(result.receipt.totals.calls, 2)
  assert.equal(result.receipt.jobs.filter(job => job.status === 'queued').length, 2)
  const mismatch = await runDreamReviewTrial({ dir: scratch(t), route, transport: { kind: 'scripted', execute: request =>
    response(request, { route: { ...route, model: 'unexpected' } }) } })
  assert.equal(mismatch.status, 'needs-review')
  assert.equal(mismatch.receipt.jobs[0].reason, 'route-mismatch')
})

test('a response containing an encoded credential is withheld from receipt and blind artifacts', async t => {
  const dir = scratch(t)
  const encoded = '{"items":[{"reason":"\\u0073k-' + 'a'.repeat(30) + '"}]}'
  const result = await runDreamReviewTrial({ dir, route, transport: { kind: 'scripted', execute: request => response(request, { output: encoded }) } })
  assert.equal(result.status, 'needs-review')
  assert.equal(result.receipt.jobs[0].reason, 'sensitive-output')
  assert.deepEqual(readdirSync(join(dir, 'blind')), [])
  assert.doesNotMatch(readFileSync(join(dir, 'receipt.json'), 'utf8'), /a{30}|\\u0073/)
})
