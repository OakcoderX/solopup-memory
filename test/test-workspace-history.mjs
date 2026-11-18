import test from 'node:test'
import assert from 'node:assert/strict'
import { searchWorkspaceHistory, workspaceHistoryAvailable } from '../workspace-history.mjs'

const workspace = '/fixture/current'
const other = '/fixture/other'
const query = '海盗船长'
const header = (id, cwd = workspace) => ({ id, cwd, isSeeded: false, createdAt: 1000 })
const caller = { id: 'new-chat', header: header('new-chat') }

function event(seq, type, data, extra) {
  return { seq, time: 1000 + seq, type, data, ...extra }
}

function message(seq, text, role = 'user', source = { kind: role === 'user' ? 'user' : 'model' }, extra) {
  const body = { id: `message-${seq}`, role, source, content: [{ type: 'text', text }] }
  return event(seq, `${role}/message`, role === 'assistant' ? { message: body } : body, { surfaceOp: 'append', ...extra })
}

function fixture(data) {
  const reads = []
  const ctx = {
    workingDirectory: { get(session) { return session.header.cwd } },
    sessionPersistence: { stat(id) { return { header: data[id].header, sizeBytes: data[id].sizeBytes ?? 5000 } } },
    sessionQuery: {
      filterSessions(filters) {
        assert.deepEqual(filters, [{ kind: 'cwd', values: [workspace] }, { kind: 'parent', values: [null] }])
        // The adapter must still authorize metadata even if the provider is overbroad.
        return Object.values(data).map(({ header, live = false }) => ({ header, live }))
      },
      inspectSession(id, read) {
        reads.push(id)
        const { header, events, observedHeader, inheritedEventCount = 0 } = data[id]
        return read({ header: observedHeader ?? header, inheritedEventCount, seq: events.length, eventAt: seq => events[seq] })
      },
    },
  }
  return { ctx, reads, search: options => searchWorkspaceHistory(ctx, { session: caller, query, ...options }) }
}

test('search reaches Chinese body text and returns chronological user evidence and earlier assistant advice', async () => {
  const { ctx, reads, search } = fixture({
    'old-chat': { header: header('old-chat'), events: [
      event(0, 'session/title', { title: '环境设置' }),
      message(1, '无关的技术安装消息。'),
      message(2, '来改海盗船长的结尾。'),
      message(3, '建议让主角独自逃走。', 'assistant'),
      message(4, '不用独自逃走。我确认结尾留船铃，主角在甲板停住。'),
    ] },
    'new-chat': { header: caller.header, events: [message(0, '海盗船长当前对话。')] },
    'wrong-workspace': { header: header('wrong-workspace', other), events: [message(0, '海盗船长隔壁工作区的结尾。')] },
  })
  assert.equal(workspaceHistoryAvailable(ctx), true)
  const result = await search()
  assert.equal(result.status, 'found')
  assert.deepEqual(reads, ['old-chat'])
  assert.deepEqual(result.sessions.map(({ sessionId, title }) => [sessionId, title]), [['old-chat', '环境设置']])
  assert.deepEqual(result.sessions[0].excerpts.map(e => [e.seq, e.role, e.messageId, e.matched]), [
    [2, 'user', 'message-2', true], [3, 'assistant', 'message-3', false], [4, 'user', 'message-4', false],
  ])
  assert.match(result.sessions[0].excerpts[2].text, /确认结尾留船铃/u)
})

test('same-title foreign workspace and per-event directory changes create no eligible match', async () => {
  const { reads, search } = fixture({
    moving: { header: header('moving'), events: [
      event(0, 'session/title', { title: query }),
      event(1, 'working-directory/change', { cwd: other }),
      message(2, '海盗船长换到其他工作区。'),
      event(3, 'working-directory/change', { cwd: workspace }),
      message(4, '这里没有在讨论那部作品。'),
    ] },
    foreign: { header: header('foreign', other), events: [message(0, query)] },
    raced: { header: header('raced'), live: true, observedHeader: header('raced', other), events: [message(0, query)] },
    fork: { header: { ...header('fork'), isSeeded: true }, events: [message(0, query)] },
  })
  const result = await search()
  assert.equal(result.status, 'no-match')
  assert.deepEqual(result.sessions, [])
  assert.deepEqual(reads, ['moving', 'raced'])
})

test('a nearby veto and the assistant proposal it responds to survive an assistant-only title match', async () => {
  const { search } = fixture({ old: { header: header('old'), events: [
    message(0, '这一段怎么改？'),
    message(1, '建议烧掉船。', 'assistant'),
    message(2, '取消烧船。决定保留铜铃。'),
    message(3, '收到，海盗船长保留铜铃。', 'assistant'),
    message(4, '继续'),
  ] } })
  const result = await search()
  assert.equal(result.status, 'found')
  assert.deepEqual(result.sessions[0].excerpts.map(e => e.seq), [1, 2, 3])
})

test('withdrawn, replaced, private, tool and non-owner content cannot become excerpts', async () => {
  const { search } = fixture({ old: { header: header('old'), live: true, events: [
    message(0, '海盗船长已经撤回的材料'),
    message(1, '海盗船长已经撤回的回答', 'assistant'),
    message(2, '海盗船长已删除的消息'),
    message(3, '已编辑为这个消息。', 'user', { kind: 'user' }, {
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2],
    }),
    event(4, 'tool/result', { message: { role: 'tool', content: [{ type: 'text', text: query }] } }),
    message(5, '海盗船长[private] 这个正文包含私密档案。'),
    message(6, '海盗船长远程注入', 'user', { kind: 'user-rpc', principal: 'remote-owner' }),
    message(7, '海盗船长远程回答', 'assistant'),
    message(8, '修改海盗船长：保留船铃。'),
  ] } })
  const allowSource = ({ sessionId, messageId, seq }) => {
    assert.equal(sessionId, 'old')
    assert.equal(messageId, `message-${seq}`)
    return seq !== 0
  }
  const result = await search({ allowSource })
  assert.equal(result.status, 'found')
  assert.deepEqual(result.sessions[0].excerpts.map(e => e.seq), [8])
})

test('bounded preflight and missing query never open oversized or unspecified sessions', async () => {
  const { reads, search } = fixture({ old: { header: header('old'), sizeBytes: 9 * 1024 * 1024, events: [] } })
  assert.equal((await search({ query: '' })).status, 'query-required')
  const result = await search()
  assert.equal(result.status, 'partial')
  assert.equal(result.coverage.skippedSources, 1)
  assert.deepEqual(reads, [])
})
