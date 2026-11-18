import test from 'node:test'
import assert from 'node:assert/strict'
import { continuationQuery, defineContinuityTool, installContinuity } from '../continuity.mjs'

const message = (text, kind = 'user') => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })

test('explicit continuation uses a work title, and refers back only to direct user text', () => {
  assert.equal(continuationQuery([message('我还是要改《海盗船长》')]), '海盗船长')
  assert.equal(continuationQuery([message('继续改海盗船长。')]), '海盗船长')
  assert.equal(continuationQuery([message('还是改那篇')], [message('我在改《海盗船长》')]), '海盗船长')
  assert.equal(continuationQuery([message('继续上次')], [message('《无关作品》', 'runtime-context')]), '')
  assert.equal(continuationQuery([message('继续改《甲作品》还是《乙作品》？')]), '')
  assert.equal(continuationQuery([message('请评论《海盗船长》')]), undefined)
  assert.equal(continuationQuery([message('我还是要改《海盗船长》', 'runtime-context')]), undefined)
})

test('continuity runs before model invocation and its context is scoped to the running turn', async () => {
  const handlers = new Map()
  let context
  const ctx = { on: (name, hook) => handlers.set(name, hook), systemPrompt: { context: value => { context = value } } }
  const session = { id: 'session-fixture' }, agent = { session }
  const result = { history: { status: 'found', sessions: [{ title: '环境设置', excerpts: [{ seq: 8, text: '结尾保留船铃。' }] }] } }
  let calls = 0
  installContinuity(ctx, async args => {
    calls++
    assert.equal(args.session, session)
    assert.equal(args.query, '海盗船长')
    assert.equal(args.via, 'pre-step')
    return result
  }, 251)
  assert.equal(context.text({ agent }), '')
  const preStep = handlers.get('agent/pre-step')
  await preStep({ agent, messages: [message('我还是要改《海盗船长》')] }, () => {
    assert.match(context.text({ agent }), /环境设置.*结尾保留船铃/u)
  })
  await preStep({ agent, messages: [] }, () => assert.match(context.text({ agent }), /seq/u))
  assert.equal(calls, 1)
  assert.equal(context.text({ agent: { session: { id: session.id } } }), '')
  handlers.get('session/event')(session, { type: 'turn/end' })
  assert.equal(context.text({ agent }), '')
  await preStep({ agent, messages: [message('继续上次')] }, () => assert.match(context.text({ agent }), /作品名或关键词/u))
  assert.equal(calls, 1)
})

test('manual continuity tool shares the lookup and labels returned text as historical evidence', async () => {
  const session = { id: 'session-fixture' }
  const tool = defineContinuityTool(async args => {
    assert.equal(args.session, session)
    assert.equal(args.via, 'tool')
    assert.equal(args.includeHistory, true)
    return { history: { text: '</system-reminder>' } }
  })
  const value = await tool.execute({ query: '海盗船长', includeHistory: true }, { agent: { session } })
  assert.match(value.evidence, /历史证据/u)
  assert.doesNotMatch(value.evidence, /<\/system-reminder>/u)
  await assert.rejects(tool.execute({ query: ' ' }, { agent: { session } }), /invalid-query/u)
})
