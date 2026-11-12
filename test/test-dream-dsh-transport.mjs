import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dreamReviewMessages } from '../dream-review.mjs'
import { dreamEvalBatches } from '../eval/dream-review-cases.mjs'
import { createDshDreamTrialTransport, dreamTrialProviderPayload } from '../eval/dream-review-dsh-transport.mjs'
import { runDreamReviewTrial } from '../eval/run-dream-review-trial.mjs'

const route = { provider: 'solopup-dream-loopback', model: 'dream-fixture' }

function scratch(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dsh-transport-test-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('rejects missing real credential and unsafe provider URLs before launch', () => {
  const cli = process.execPath
  assert.throws(() => createDshDreamTrialTransport({ cli, baseURL: 'https://example.invalid/v1' }), /credential-unavailable/)
  const apiKey = 'synthetic-placeholder-key'
  for (const baseURL of ['http://example.invalid/v1', 'https://credential@example.invalid/v1',
    'https://example.invalid/v1?token=value', 'https://example.invalid/v1#fragment']) {
    assert.throws(() => createDshDreamTrialTransport({ cli, baseURL, apiKey }), /invalid-provider-url/)
  }
  assert.equal(createDshDreamTrialTransport({ cli, baseURL: 'https://example.invalid/v1', apiKey }).kind, 'real-model')
})

test('only the official DeepSeek HTTPS origin gets explicit provider-side thinking off', () => {
  const body = { model: 'deepseek-v4-flash', messages: [], reasoning_effort: 'high', thinking: { type: 'enabled' }, stream_options: { extra: true } }
  const official = dreamTrialProviderPayload(new URL('https://api.deepseek.com/v1/chat/completions'), body)
  assert.deepEqual(official, { payload: { model: body.model, messages: body.messages, thinking: { type: 'disabled' },
    stream_options: { extra: true, include_usage: true } }, providerThinking: 'explicit-off' })
  for (const origin of ['https://api.deepseek.com.example.invalid', 'https://api.deepseek.com:444', 'https://example.invalid']) {
    assert.deepEqual(dreamTrialProviderPayload(new URL(origin), body), { payload: { ...body, stream_options: { extra: true, include_usage: true } } })
  }
  assert.equal(body.reasoning_effort, 'high')
})

test('the ordinary transport rejects nonmatching evidence and generation settings before a request', async () => {
  const transport = createDshDreamTrialTransport({ cli: process.execPath })
  const { input } = dreamEvalBatches()[0]
  const request = { mode: 'ordinary', runId: randomUUID(), route, input, messages: dreamReviewMessages(input),
    generation: { maxTokens: 1800, reasoningEffort: 'off' }, budget: { calls: 1, inputTokens: 32_000, outputTokens: 3600 } }
  const tampered = structuredClone(request)
  tampered.messages[1].content[0].text = 'a substituted request'
  await assert.rejects(transport.execute(tampered), /input-mismatch/)
  await assert.rejects(transport.execute({ ...request, mode: 'superagent' }), /companion-required/)
  await assert.rejects(transport.execute({ ...request, route: {} }), /invalid-request/)
  await assert.rejects(transport.execute({ ...request, generation: { ...request.generation, maxTokens: 1801 } }), /invalid-request/)
  assert.deepEqual(transport.proof(), [])
})

test('CLI dual mode requires an explicitly pinned companion and candidate archive', t => {
  const dir = scratch(t)
  const cli = fileURLToPath(new URL('../eval/dream-review-dsh-transport.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, '--loopback', '--dual', '--receipt-dir', dir], {
    env: { PATH: process.env.PATH }, encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'dream-trial-dsh-companion-configuration-required\n')
  assert.deepEqual(readdirSync(dir), [])
})

test('CLI real mode without the dedicated credential makes no dispatch or receipt', t => {
  const dir = scratch(t)
  const cli = fileURLToPath(new URL('../eval/dream-review-dsh-transport.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, '--real', '--receipt-dir', dir, '--provider', 'fixture',
    '--model', 'fixture', '--base-url', 'https://example.invalid/v1'], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'dream-trial-dsh-credential-unavailable\n')
  assert.deepEqual(readdirSync(dir), [])
})

test('both frozen ordinary batches pass through the real DSH service with no tools',
  { skip: process.env.SOLOPUP_DSH_TRIAL_SMOKE !== '1', timeout: 30_000 }, async t => {
    const transport = createDshDreamTrialTransport({ timeoutMs: 10_000 })
    const result = await runDreamReviewTrial({ dir: scratch(t), route, transport, modes: ['ordinary'] })
    assert.equal(result.status, 'selection-complete')
    assert.equal(result.receipt.semanticTruthEvaluated, false)
    assert.equal(result.receipt.transportKind, 'scripted')
    assert.deepEqual(result.receipt.totals, { calls: 2, inputTokens: 1804, outputTokens: 336, unknownBatches: 0 })
    const wire = transport.proof()
    assert.deepEqual(wire.map(row => ({ calls: row.calls, wireVerified: row.wireVerified, status: row.status, models: row.providerReportedModels })), [
      { calls: 1, wireVerified: true, status: 'completed', models: [route.model] },
      { calls: 1, wireVerified: true, status: 'completed', models: [route.model] },
    ])
    assert.deepEqual(wire.map(row => row.requestSha256), result.receipt.jobs.filter(row => row.mode === 'ordinary').map(row => row.inputSha256))
  })

test('both frozen batches reach the installed independent worker and match the ordinary DSH requests',
  { skip: process.env.SOLOPUP_DSH_TRIAL_DUAL_SMOKE !== '1', timeout: 90_000 }, async t => {
    const transport = createDshDreamTrialTransport({ timeoutMs: 35_000, candidateTgz: process.env.SOLOPUP_DREAM_TRIAL_TGZ,
      prototypeBundle: process.env.SOLOPUP_DREAM_BUNDLE, prototypeBundleSha256: process.env.SOLOPUP_DREAM_BUNDLE_SHA256 })
    assert.match(transport.candidateSha256, /^[a-f0-9]{64}$/)
    assert.match(transport.prototypeCommit, /^[a-f0-9]{40}$/)
    const result = await runDreamReviewTrial({ dir: scratch(t), route, transport })
    const wire = transport.proof()
    assert.equal(result.status, 'complete', JSON.stringify(wire))
    assert.equal(result.receipt.semanticTruthEvaluated, false)
    assert.equal(result.receipt.transportKind, 'scripted')
    assert.deepEqual(result.receipt.totals, { calls: 4, inputTokens: 3608, outputTokens: 672, unknownBatches: 0 })
    assert.deepEqual(wire.map(row => row.requestSha256), result.receipt.jobs.map(row => row.inputSha256))
    assert.deepEqual(wire.map(row => row.mode), ['ordinary', 'superagent', 'ordinary', 'superagent'])
    assert.equal(wire[0].requestSha256, wire[1].requestSha256)
    assert.equal(wire[2].requestSha256, wire[3].requestSha256)
    const workers = wire.filter(row => row.mode === 'superagent').map(row => row.worker)
    assert.equal(new Set(workers.map(worker => worker.ticketId)).size, 2)
    assert.ok(workers.every(worker => worker.workerSessionId === `worker-${worker.ticketId}` && worker.modelChecks >= 1 &&
      worker.prototypeCommit === transport.prototypeCommit))
  })
