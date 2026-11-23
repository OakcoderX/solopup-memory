import test from 'node:test'
import assert from 'node:assert/strict'
import { archivedSearchEvidence, continuationQuery, defineContinuityTool, installContinuity } from '../continuity.mjs'

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
    assert.match(context.text({ agent }), /occurredAt 是 DSH 记录这条消息的时间/u)
    assert.match(context.text({ agent }), /缺失时保留未知/u)
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
  assert.doesNotMatch(value.evidence, /sourceOpening/u)
  assert.doesNotMatch(value.evidence, /<\/system-reminder>/u)
  await assert.rejects(tool.execute({ query: ' ' }, { agent: { session } }), /invalid-query/u)
})

test('an ordinary index miss can cite an authorized project quote and preserve the result limit', async () => {
  const agent = { session: { id: 'reader' } }
  const ctx = { tools: { schemas: subject => subject === agent ? [{name:'memory_continue'}] : [] } }
  const excerpt = { seq:9, messageId:'original-note', role:'user', matched:true, occurredAt:'2025-03-19T08:00:00Z', text:'水纹纸样。' }
  const sessions = ['first', 'second'].map(sessionId => ({ sessionId, excerpts:[excerpt] }))
  const lookup = async args => {
    assert.equal(args.session, agent.session)
    assert.equal(args.via, 'search')
    assert.equal(args.includeHistory, true)
    return {history:{status:'found',sessions,coverage:{}}}
  }
  const value = {query:'水纹纸样',hits:[],truncated:false}
  const out = await archivedSearchEvidence(ctx, lookup, {scope:'project',limit:1}, {agent}, value)
  assert.match(out, /历史引用/u)
  const { history } = JSON.parse(out.split('\n').at(-1))
  assert.deepEqual(history.sessions, [sessions[0]])
  assert.equal(history.coverage.resultLimitReached, true)
  assert.deepEqual(value.hits, [])
  const tooLarge = async () => ({history:{status:'found',sessions:[
    {sessionId:'long',excerpts:[{...excerpt,text:'很多字'.repeat(900)}]}, sessions[1]]}})
  const small = await archivedSearchEvidence(ctx, tooLarge, {}, {agent}, value)
  assert.deepEqual(JSON.parse(small.split('\n').at(-1)).history.sessions, [sessions[1]])
  assert.ok(Buffer.byteLength(small) < 4096)
})

test('fallback preserves scoped permissions, explicit filters and actual index hits', async () => {
  const exec = {agent:{session:{id:'reader'}}}
  const allow = {tools:{schemas:()=>[{name:'memory_continue'}]}}
  const miss = {query:'绿页',hits:[],truncated:false}
  const never = () => assert.fail('archive must stay closed for this search')
  for (const opts of [{scope:'global'}, {view:'current'}, {view:'history'}, {mode:'exact'},
    {mode:'ranked'}, {context:{}}, {task:{}}, {includePrivate:true}]) {
    assert.equal(await archivedSearchEvidence(allow, never, opts, exec, miss), undefined)
  }
  for (const result of [{...miss,query:'a'.repeat(64)}, {...miss,hits:[{}]}, {...miss,truncated:true}]) {
    assert.equal(await archivedSearchEvidence(allow, never, {}, exec, result), undefined)
  }
  for (const ctx of [{}, {tools:{schemas:()=>[{name:'memory_search'}]}}]) {
    assert.equal(await archivedSearchEvidence(ctx, never, {}, exec, miss), undefined)
  }
  let allowed=true
  const changing={tools:{schemas:()=>allowed?[{name:'memory_continue'}]:[]}}
  const lookup = async () => { allowed=false; return {history:{status:'found',sessions:[]}} }
  assert.equal(await archivedSearchEvidence(changing, lookup, {}, exec, miss), undefined)
})
