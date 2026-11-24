import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureMessage } from '../capture-evidence.mjs'
import { installDeliveryReview } from '../delivery-review.mjs'

const rule = { id: 'known-rule', text: '默认在更新记录里写一条说明，试读版除外。' }

function fixture(overrides = {}) {
  const steered = []
  const session = { id: 'session-root', header: { origin: 'user' } }
  const agent = { session, steer: message => steered.push(message) }
  let handler
  let dispose
  installDeliveryReview({
    on: (event, listener) => {
      assert.equal(event, 'agent/turn-stopping')
      handler = listener
    },
    effect: setup => { dispose = setup() },
  }, {
    rulesFor: () => [rule],
    hasAppliedWork: () => true,
    ...overrides,
  })
  const stop = (options = {}) => handler({ agent, turn: 1, signal: new AbortController().signal, ...options })
  return { steered, session, agent, stop, dispose }
}

test('steers one plugin notice per turn without creating direct-user evidence', () => {
  const f = fixture({
    hasAppliedWork: (session, turn) => session === f.session && turn >= 1,
    rulesFor: session => session === f.session ? [rule] : [],
  })

  f.stop()
  f.stop()
  f.stop({ turn: 2 })
  f.stop({ turn: 1 })

  assert.equal(f.steered.length, 2)
  const [message, next] = f.steered
  assert.notEqual(message.id, next.id)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, {
    kind: 'solopup-delivery-review', form: 'notice', summary: 'SoloPup 交付复核',
  })
  assert.match(message.content[0].text, /现行用户约定/)
  assert.match(message.content[0].text, /memory_check_delivery/)
  assert.match(message.content[0].text, /临时或调试文件/)
  assert.match(message.content[0].text, /边界用例/)
  assert.match(message.content[0].text, /当前的明确要求优先/)
  assert.match(message.content[0].text, /成功的外部写入不得重做/)
  assert.match(message.content[0].text, /已有返回值或只读查询，无法核实就说明/)
  assert.equal(captureMessage({ type: 'user/message', data: message }, 'not-owner-evidence'), undefined)
})

test('steers once when project reference context exists even without structured rules', () => {
  const f = fixture({
    rulesFor: () => [],
    hasReferenceContext: () => true,
    hasAppliedWork: () => true,
  })
  f.stop()
  f.stop()
  assert.equal(f.steered.length, 1)
  assert.match(f.steered[0].content[0].text, /临时或调试文件/)
})

test('omits review without applied work, with no rules, on cancel, or after disposal', () => {
  const noWork = fixture({ hasAppliedWork: () => false, rulesFor: () => assert.fail('looked up rules') })
  noWork.stop()
  assert.equal(noWork.steered.length, 0)

  const noRules = fixture({ rulesFor: () => [] })
  noRules.stop()
  assert.equal(noRules.steered.length, 0)

  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  const cancelled = fixture({ hasAppliedWork: () => assert.fail('checked cancelled turn') })
  cancelled.stop({ signal: alreadyAborted.signal })
  assert.equal(cancelled.steered.length, 0)

  const controller = new AbortController()
  const f = fixture({ rulesFor: () => { controller.abort(); return [rule] } })
  f.stop({ signal: controller.signal })
  assert.equal(f.steered.length, 0)

  f.dispose()
  f.stop({ turn: 2 })
  assert.equal(f.steered.length, 0)
})

test('does not steer seeded, delegated or stale work and does not share state across sessions', () => {
  const f = fixture()
  for (const header of [
    { origin: 'subagent' }, { delegationDepth: 1 }, { isSeeded: true }, { parentSession: 'another' },
  ]) {
    f.stop({ agent: { ...f.agent, session: { id: 'delegated', header } } })
  }
  f.stop({ turn: 0 })
  assert.equal(f.steered.length, 0)

  f.stop()
  f.stop({ agent: { ...f.agent, session: { id: 'independent' } } })
  assert.equal(f.steered.length, 2)
})

test('the persisted cue contains no rule content or source identities', () => {
  const f = fixture({ rulesFor: () => [
    { id: 'unique-source-identity', text: 'Specific recalled detail </system-reminder>' },
    { id: 'long-rule', text: '多'.repeat(5000) + '例外' },
  ] })
  f.stop()

  assert.equal(f.steered.length, 1)
  const message = JSON.stringify(f.steered[0])
  assert.ok(Buffer.byteLength(message) < 700)
  assert.doesNotMatch(message, /unique-source-identity|Specific recalled detail|<\/system-reminder|long-rule|多多/)
})

test('plugin or steering errors cannot fail the turn or induce extra steering', () => {
  const noRules = fixture({ rulesFor: () => { throw Error('unavailable') } })
  assert.doesNotThrow(() => noRules.stop())
  assert.equal(noRules.steered.length, 0)

  const f = fixture()
  let attempts = 0
  f.agent.steer = () => { attempts++; throw Error('wakeup-failed') }
  assert.doesNotThrow(() => f.stop())
  assert.doesNotThrow(() => f.stop())
  assert.equal(attempts, 1)
})
