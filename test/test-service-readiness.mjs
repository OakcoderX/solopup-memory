import { test } from 'node:test'
import assert from 'node:assert/strict'
import { watchOptionalService } from '../service-readiness.mjs'

test('compatibility lookup discovers a late active service and keeps stable snapshots unchanged', () => {
  let value
  const changes = [], cleanups = []
  const tracker = watchOptionalService({ get: () => value, effect: fn => cleanups.push(fn()) }, 'query', state => changes.push(state))
  assert.equal(tracker.current().value, undefined)
  const before = tracker.current()
  value = { synthetic: true }
  assert.equal(tracker.refresh().value, value)
  assert.equal(before.signal.aborted, true)
  assert.equal(tracker.refresh().generation, 1)
  assert.equal(changes.length, 1)
  cleanups[0]()
  assert.equal(tracker.refresh().value, undefined)
})
function managed() {
  let activate
  const cleanup = [], changes = []
  const tracker = watchOptionalService({ get: () => ({ mustNotBypassInjection: true }), effect: fn => cleanup.push(fn()), inject: (names, fn) => { assert.deepEqual(names, ['query']); activate = value => { const disposal = []; fn({ get: () => value, effect: callback => disposal.push(callback()) }); return () => disposal.reverse().forEach(run => run()) } } }, 'query', state => changes.push(state))
  return { tracker, cleanup, changes, activate: value => activate(value) }
}
test('native injection waits for readiness and revokes the previous generation when provider disappears', () => {
  const host = managed(), value = { synthetic: true }
  assert.equal(host.tracker.refresh().value, undefined)
  const dispose = host.activate(value), active = host.tracker.current()
  assert.equal(active.value, value)
  dispose()
  assert.equal(active.signal.aborted, true)
  assert.equal(host.tracker.current().value, undefined)
})
test('old provider cleanup cannot erase a newer provider even when both expose the same object', () => {
  const host = managed(), value = { synthetic: true }
  const oldDispose = host.activate(value), old = host.tracker.current(), newDispose = host.activate(value), current = host.tracker.current()
  assert.equal(old.signal.aborted, true)
  oldDispose()
  assert.equal(host.tracker.current(), current)
  assert.equal(current.signal.aborted, false)
  newDispose()
  assert.equal(current.signal.aborted, true)
})
test('root disposal prevents late injection from resurrecting an optional service', () => {
  const host = managed()
  host.cleanup[0]()
  host.activate({ synthetic: true })
  assert.equal(host.tracker.current().value, undefined)
  assert.equal(host.tracker.current().signal.aborted, true)
})
