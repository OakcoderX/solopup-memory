import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupMemoryHistory } from '../context-history.mjs'
import { apply } from '../index.mjs'

function deferredRegistration() {
  let resolve, reject, calls = 0
  const pending = new Promise((yes, no) => { resolve = yes; reject = no })
  // Real DSH deliberately returns a callable thenable, not a native Promise.
  const registration = Object.assign(() => { calls++ }, { then: pending.then.bind(pending) })
  return { registration, resolve, reject, get calls() { return calls } }
}
const header = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
function oldSession() {
  const sections = [{ name: 'memory:index', text: 'old synthetic memory' }]
  let messages = [{ id: 'old', role: 'user', source: { kind: 'runtime-context', sections }, content: [{ type: 'text', text: `${header}\n\nold synthetic memory` }] }]
  return { id: 'synthetic-session', surface: { nodes: [1] }, deriveMessages: () => messages,
    append(type, message, options) { assert.equal(type, 'user/message'); assert.deepEqual(options.sourceEventSeqs, [1]); messages = [message] } }
}

test('callable asynchronous projection registration publishes no hooks before its retained handle is ready', async () => {
  const deferred = deferredRegistration(), handlers = new Map(), session = oldSession()
  let reads = 0
  const ctx = { sessionProjections: { register: () => deferred.registration,
    stateOf() { throw Error('deprecated registry reader must not be used') } },
    workingDirectory: { get: () => '/synthetic' }, on: (name, fn) => handlers.set(name, fn) }
  const pending = setupMemoryHistory(ctx, () => 'new synthetic memory')
  assert.equal(handlers.size, 0)
  deferred.resolve({ stateOf(value) { assert.equal(value, session); reads++; return { nodes: [{ id: 'old', seq: 1 }], overflow: false } } })
  const history = await pending
  assert.equal(history.available, true)
  assert.equal(deferred.calls, 0, 'await must not invoke the legacy disposer')
  assert.equal(handlers.get('agent/request')({ agent: { session } }, () => 'continued'), 'continued')
  assert.equal(reads, 1)
  assert.doesNotMatch(JSON.stringify(session.deriveMessages()), /old synthetic memory/)
})

test('handle-only hosts need no deprecated registry stateOf method', async () => {
  const handlers = new Map()
  const history = await setupMemoryHistory({ sessionProjections: { register: async () => ({ stateOf: () => ({ nodes: [], overflow: false }) }) }, on: (name, fn) => handlers.set(name, fn) }, () => '')
  assert.equal(history.available, true)
  assert.equal(handlers.size, 4)
})

test('rejected projection registration installs no history consumers', async () => {
  const deferred = deferredRegistration(), handlers = []
  const pending = setupMemoryHistory({ sessionProjections: { register: () => deferred.registration }, on: (...args) => handlers.push(args) }, () => '')
  deferred.reject(Error('synthetic-registration-rejected'))
  await assert.rejects(pending, /synthetic-registration-rejected/)
  assert.deepEqual(handlers, [])
})

test('malformed ready handle is rejected rather than advertised as available', async () => {
  await assert.rejects(setupMemoryHistory({ sessionProjections: { register: async () => ({}) } }, () => ''), /memory-context-reader-unavailable/)
})

for (const success of [true, false]) test(`apply awaits registration before tools, prompts and success marker (${success ? 'success' : 'failure'})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-registration-')), previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const deferred = deferredRegistration(), tools = [], prompts = [], effects = [], handlers = []
  const ctx = { sessionProjections: { register: () => deferred.registration },
    systemPrompt: { context: value => prompts.push(value) }, workingDirectory: { get: () => root }, tools: { register: value => tools.push(value) },
    on: (...args) => handlers.push(args), effect(fn) { effects.push(fn()) } }
  try {
    const pending = apply(ctx, { autoCapture: { enabled: false } })
    assert.equal(typeof pending?.then, 'function')
    assert.deepEqual(tools, []); assert.deepEqual(prompts, []); assert.deepEqual(handlers, [])
    const marker = join(root, 'memory', '.loaded.json')
    assert.equal(existsSync(marker), false)
    if (success) {
      deferred.resolve({ stateOf: () => ({ nodes: [], overflow: false }) })
      await pending
      assert.equal(prompts.length, 2)
      const status = JSON.parse(readFileSync(marker))
      assert.equal(status.memoryHistory.available, true)
      assert.equal(tools.length, status.sourceControl?.state === 'managed' ? 9 : 6)
      assert.equal(tools.some(tool => tool.name === 'memory_document'), status.sourceControl?.state === 'managed')
      assert.equal(tools.some(tool => tool.name === 'memory_check_delivery'), status.sourceControl?.state === 'managed')
      assert.equal(tools.some(tool => tool.name === 'memory_receipt'), status.sourceControl?.state === 'managed')
    } else {
      deferred.reject(Error('synthetic-owner-disposed'))
      await assert.rejects(pending, /synthetic-owner-disposed/)
      assert.equal(existsSync(marker), false); assert.deepEqual(tools, []); assert.deepEqual(prompts, []); assert.deepEqual(handlers, [])
    }
    assert.equal(deferred.calls, 0)
  } finally {
    for (const dispose of effects.reverse()) dispose?.()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})


test('a successful handle arriving after owner disposal cannot activate history or tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-disposed-registration-')), previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const deferred = deferredRegistration(), consumers = [], fiber = { uid: 1 }
  const ctx = { fiber, sessionProjections: { register: () => deferred.registration },
    systemPrompt: { context: value => consumers.push(value) }, workingDirectory: { get: () => root },
    tools: { register: value => consumers.push(value) }, on: (...args) => consumers.push(args) }
  try {
    const pending = apply(ctx, { autoCapture: { enabled: false } })
    fiber.uid = null
    deferred.resolve({ stateOf: () => ({ nodes: [], overflow: false }) })
    await pending
    assert.deepEqual(consumers, [])
    assert.equal(existsSync(join(root, 'memory', '.loaded.json')), false)
    assert.equal(deferred.calls, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})


test('managed host without projections exposes turn receipts independently of automatic delivery review', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-receipt-registration-')))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const tools = new Map(), handlers = [], effects = []
  try {
    apply({ systemPrompt: { context() {} }, workingDirectory: { get: () => root },
      tools: { register: tool => tools.set(tool.name, tool) }, on(name, handle) { handlers.push([name, handle]) },
      effect(factory) { effects.push(factory()) },
    }, { autoCapture: { enabled: false }, deliveryReview: false })
    const session = { id: 'synthetic-session' }
    const exec = { agent: { session } }
    const emit = event => {
      for (const [name, handle] of handlers) if (name === 'session/event') handle(session, event)
    }
    assert.equal(JSON.parse(readFileSync(join(root, 'memory', '.loaded.json'))).memoryHistory.available, false)
    assert.ok(tools.has('memory_receipt'))
    assert.ok(!handlers.some(([name]) => name === 'agent/request'))
    const receipt = tools.get('memory_receipt')
    assert.deepEqual(await receipt.execute({}, exec), { status: 'unavailable' })
    emit({ type: 'turn/start', data: { turn: 1 } })
    const current = await receipt.execute({}, exec)
    assert.deepEqual(current, { status: 'observed', view: 'current', turn: 1,
      writes: [], sources: [], delivery: [], truncated: false })
    emit({ type: 'turn/end', data: { turn: 1 } })
    assert.deepEqual(await receipt.execute({ view: 'previous' }, exec), { ...current, view: 'previous' })
  } finally {
    for (const dispose of effects.reverse()) dispose?.()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})
