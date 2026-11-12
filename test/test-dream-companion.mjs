import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createDreamCompanion } from '../dream-companion.mjs'
import { createSuperAgentDreamExecutor } from '../dream-superagent.mjs'
import { encodeFrame, readFrames } from '../scripts/dream-companion-wire.mjs'

test('companion pipe rejects oversized and truncated frames', async () => {
  assert.throws(() => encodeFrame({ value: 'x'.repeat(40_000) }), /frame-too-large/)
  const stream = new PassThrough()
  const frames = []
  const done = new Promise((resolve, reject) => readFrames(stream, frame => frames.push(frame),
    () => reject(Error('unexpected clean end')), resolve))
  stream.write('{"x":')
  stream.write('1}\n{"x":2}\n')
  stream.end('{"missing":')
  assert.match((await done).message, /invalid-frame/)
  assert.deepEqual(frames, [{ x: 1 }, { x: 2 }])
})

const bundle = process.env.SOLOPUP_DREAM_BUNDLE
test('optional actual companion: one Seatbelt DSH Worker, one parent model call, durable local status',
  { skip: process.platform !== 'darwin' || !bundle }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'solopup-dream-companion-test-'))
    const input = { schema: 1, projectId: 'a'.repeat(64), storeRevision: 'b'.repeat(64),
      items: [{ id: 'c'.repeat(64), summary: 'The approved product label is teal.', sources: [{ id: 'd'.repeat(64),
        hash: 'e'.repeat(64), quote: 'Companion synthetic evidence: use teal for the product label.', kind: 'original' }] }] }
    const output = JSON.stringify({ items: [{ id: 'm1', verdict: 'keep', sourceIds: ['s1'], reason: 'The source supports the memory.' }] })
    const calls = [], streamCalls = [], receipts = []
    let heldCall, startedModel
    const getLlm = () => ({ value: { async prepareCall(config) {
      calls.push(config)
      return { config, async *stream(request) {
        streamCalls.push(request.sessionId)
        assert.equal(request.purpose, 'memory-dream-superagent-review')
        assert.deepEqual(request.tools, [])
        assert.match(request.messages[0].content[0].text, /Companion synthetic evidence/)
        assert.ok(!JSON.stringify(request.messages).includes('d'.repeat(64)))
        if (request.sessionId === 'memory-dream-companion-cancel' || request.sessionId === 'memory-dream-companion-unload') {
          heldCall = request.signal
          startedModel()
          await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))
          request.signal.throwIfAborted()
        }
        yield { type: 'text-delta', index: 0, text: output }
        yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 475, outputTokens: 20 } }
      } }
    } } })
    const config = { dshCli: process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
      prototypeBundle: bundle, prototypeBundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
      stateDir: join(root, 'state'), getLlm }
    let companion
    try {
      companion = createDreamCompanion(config)
      let executor = createSuperAgentDreamExecutor({ getBridge: () => companion.bridge, getIsolation: () => companion.isolation })
      assert.deepEqual(await executor.ready(), { ready: true })
      const options = { runId: 'companion-live', attempt: 1, signal: AbortSignal.timeout(15_000),
        route: { provider: 'test-parent-model', model: 'test' }, maxTokens: 1800, maxTotalTokens: 8000,
        beforeDispatch() {}, beforeModel() {}, onReceipt: value => receipts.push(value) }
      const result = await executor.execute(input, options)
      assert.equal(result.output, output)
      assert.deepEqual(result.usage, { inputTokens: 475, outputTokens: 20, totalTokens: 495 })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].provider, 'test-parent-model')
      assert.equal(result.receipt.workerSessionId, `worker-${result.receipt.ticketId}`)
      assert.equal(receipts[0].ticketId, result.receipt.ticketId)
      await companion.close()
      companion = createDreamCompanion(config)
      executor = createSuperAgentDreamExecutor({ getBridge: () => companion.bridge, getIsolation: () => companion.isolation })
      assert.deepEqual(await executor.status(result.receipt), { state: 'completed', receipt: result.receipt })
      await assert.rejects(executor.execute(input, options), /dispatch-uncertain/)
      assert.equal(calls.length, 1)

      const alteredBridge = { ...companion.bridge, dispatch(envelope, options) {
        const messages = structuredClone(envelope.messages)
        messages[1].content[0].text = 'changed evidence'
        return companion.bridge.dispatch({ ...envelope, messages }, options)
      } }
      const alteredExecutor = createSuperAgentDreamExecutor({ getBridge: () => alteredBridge, getIsolation: () => companion.isolation })
      await assert.rejects(alteredExecutor.execute(input, { ...options, runId: 'companion-altered' }), /dispatch-uncertain/)
      assert.equal(calls.length, 1)

      let modelStarted = new Promise(resolve => { startedModel = resolve })
      const cancelling = executor.execute(input, { ...options, runId: 'companion-cancel', signal: AbortSignal.timeout(15_000) })
      const cancelled = assert.rejects(cancelling, /dispatch-uncertain/)
      await modelStarted
      const cancelledReceipt = receipts.at(-1)
      assert.equal((await executor.cancel(cancelledReceipt)).state, 'cancelled')
      await cancelled
      assert.equal(heldCall.aborted, true)

      modelStarted = new Promise(resolve => { startedModel = resolve })
      const unloading = executor.execute(input, { ...options, runId: 'companion-unload', signal: AbortSignal.timeout(15_000) })
      const unloaded = assert.rejects(unloading, /dispatch-uncertain/)
      await modelStarted
      const unloadedReceipt = receipts.at(-1)
      await companion.close()
      await unloaded
      assert.equal(heldCall.aborted, true)
      assert.equal((await executor.ready()).ready, false)
      companion = createDreamCompanion(config)
      executor = createSuperAgentDreamExecutor({ getBridge: () => companion.bridge, getIsolation: () => companion.isolation })
      assert.equal((await executor.status(cancelledReceipt)).state, 'cancelled')
      assert.equal((await executor.status(unloadedReceipt)).state, 'cancelled')
      assert.equal(calls.length, 3)
      assert.equal(streamCalls.length, 3)

      let evidenceChecks = 0
      await assert.rejects(executor.execute(input, { ...options, runId: 'companion-revoked', signal: AbortSignal.timeout(15_000),
        async beforeModel() {
          if (++evidenceChecks === 2) throw Error('synthetic-source-revoked-after-prepare')
        },
      }), { notDispatched: true })
      assert.equal(evidenceChecks, 2)
      assert.equal(calls.length, 4)
      assert.equal(streamCalls.length, 3)
      assert.equal((await executor.status(receipts.at(-1))).state, 'failed')
      const durableBytes = readFileSync(join(config.stateDir, 'runs.sqlite'))
      assert.ok(!durableBytes.includes(Buffer.from('Companion synthetic evidence')))
      assert.ok(!durableBytes.includes(Buffer.from('The source supports the memory.')))
    } finally {
      await companion?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
