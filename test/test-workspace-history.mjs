import test from 'node:test'
import assert from 'node:assert/strict'
import { readWorkspaceHistorySources, searchWorkspaceHistory, workspaceHistoryAvailable } from '../workspace-history.mjs'

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

test('all query terms can anchor a single nearby passage late in the same message', async () => {
  const prefix = 'Earlier irrelevant material. '.repeat(65)
  const text = prefix + 'Mira: the cobalt label belongs on the lantern.'
  const { search } = fixture({ archive: { header: header('archive'), events: [message(0, text)] } })
  const result = await search({ query: 'lantern Mira cobalt' })
  assert.equal(result.status, 'found')
  const [excerpt] = result.sessions[0].excerpts
  assert.equal(excerpt.messageId, 'message-0')
  assert.equal(excerpt.matched, true)
  assert.equal(excerpt.truncated, true)
  assert.ok(excerpt.text.includes('Mira: the cobalt label belongs on the lantern.'))
})

test('nearby fallback respects line, message, source, word, span and permission boundaries', async () => {
  const { search } = fixture({
    first: { header: header('first'), events: [
      message(0, 'Mira: I chose cobalt.'), message(1, 'The lantern is ready.'),
      message(2, 'Mira: we chose cobalt.\nAna: the lantern is ready.'),
      message(3, 'Mira: cobalt ' + 'long '.repeat(30) + 'lantern.'),
      message(4, 'Miranda: I chose a cobalt lantern.'),
      message(5, 'Mira: the cobalt lantern has been withdrawn.'),
    ] },
    other: { header: header('other'), events: [message(0, 'The lantern looks blue.')] },
  })
  const result = await search({ query: 'Mira cobalt lantern',
    allowSource: ({ seq }) => seq !== 5 })
  assert.equal(result.status, 'no-match')
})

test('older exact evidence wins over a full page of more recent nearby matches', async () => {
  const entries = ['first', 'second', 'third', 'fourth'].map(id => [id,
    { header: header(id), events: [message(0, 'Cobalt glass on the lantern.')] }])
  const { search } = fixture({ ...Object.fromEntries(entries),
    exact: { header: header('exact'), events: [message(0, 'Use the cobalt lantern.')] } })
  const result = await search({ query: 'cobalt lantern' })
  assert.deepEqual(result.sessions.map(s => s.sessionId), ['exact'])
})

test('Chinese spaced query terms stay bound to one passage; tighter matches rank first', async () => {
  const { search } = fixture({
    broad: { header: header('broad'), events: [message(0, '正文里有一盏蓝灯，作者强调末句应由编辑核实。')] },
    close: { header: header('close'), events: [message(0, '主稿末句保留蓝灯。')] },
  })
  const result = await search({ query: '蓝灯 末句' })
  assert.deepEqual(result.sessions.map(s => s.sessionId), ['close','broad'])
})

test('separate editions retain their own dated source headings and the shared receipt time', async () => {
  const receiptTime = Date.parse('2025-03-01T08:09:10Z')
  const headings = { rehearsal: '排练笔记 · 2024年3月8日', screening: '展映笔记 · 2024年9月12日' }
  const entries = Object.entries(headings).map(([id, heading]) => {
    const text = heading + '\n' + '逐场检查灯光与台词。'.repeat(160) + '片尾铃声保留。'
    return [id, { header: header(id), events: [message(0, text, 'user', { kind: 'user' }, { time: receiptTime })] }]
  })
  const result = await fixture(Object.fromEntries(entries)).search({ query: '片尾铃声' })
  assert.equal(result.sessions.length, 2)
  for (const { sessionId, excerpts } of result.sessions) {
    const [item] = excerpts
    assert.equal(item.occurredAt, new Date(receiptTime).toISOString())
    assert.equal(item.sourceOpening.split('\n')[0], headings[sessionId])
    assert.equal(item.messageId, 'message-0')
    assert.ok(item.text.includes('片尾铃声保留。'))
    assert.ok(!item.text.includes('笔记'))
  }
})

test('weekly and undated material keep their written precision, with no duplicate opening on early hits', async () => {
  for (const heading of ['巡演第二周（周次记录）', '导演修改便笺']) {
    const text = heading + '\n' + '等待统筹反馈。'.repeat(180) + '舞台入口换在东侧。'
    const { search } = fixture({ tour: { header: header('tour'), events: [message(0, text)] } })
    const [late] = (await search({ query: '舞台入口' })).sessions[0].excerpts
    assert.ok(text.startsWith(late.sourceOpening))
    assert.ok(late.sourceOpening.startsWith(heading))
    assert.ok(!/\d{4}/u.test(late.sourceOpening + late.text))
    assert.equal(late.truncated, true)
    const [early] = (await search({ query: heading })).sessions[0].excerpts
    assert.ok(early.text.startsWith(heading))
    assert.equal(early.sourceOpening, undefined)
  }
})

test('archive quotes preserve the full match and share the original message and session limits', async () => {
  const needle = '本次约定'.repeat(45)
  const events = Array.from({ length: 8 }, (_, i) => message(i,
    '修改回执 ' + i + '\n' + '编排留档。'.repeat(240) + needle + '待确认。'.repeat(180)))
  const result = await fixture({ revisions: { header: header('revisions'), events } }).search({ query: needle })
  const excerpts = result.sessions[0].excerpts
  assert.ok(excerpts.length >= 4)
  let total = 0
  for (const item of excerpts) {
    assert.ok(item.sourceOpening.startsWith('修改回执 ' + item.seq + '\n'))
    assert.ok(item.sourceOpening.length <= 160)
    assert.ok(item.text.includes(needle))
    const count = item.text.length + item.sourceOpening.length
    assert.ok(count <= 700)
    total += count
  }
  assert.equal(total, 2600)
})

test('a distant speaker label and inflected event are linked through their own sentence', async () => {
  const filler = 'We went over the workshop minutes in some detail. '.repeat(23)
  const text = 'Minutes of the workshop, 2021-04-15\nRae: ' + filler + 'We are testing a revised pump tomorrow.'
  const { search } = fixture({ minutes:{header:header('minutes'),events:[message(0,text)]} })
  const result = await search({query:'Rae tested revised pump'})
  const excerpt = result.sessions[0].excerpts[0]
  assert.equal(excerpt.quotedSpeaker,'Rae:')
  assert.match(excerpt.text,/testing a revised pump tomorrow/u)
  assert.match(excerpt.sourceOpening,/2021-04-15/u)
  assert.ok(excerpt.quotedSpeaker.length + excerpt.sourceOpening.length + excerpt.text.length <= 700)
})

test('a Chinese wording change still requires an exact event clue and independent evidence in the same sentence', async () => {
  const text = '徐弦：只提议先改侧门的位置，铜色把手留作下次讨论。'
  const { search } = fixture({ minutes:{header:header('minutes'),events:[message(0,text)]} })
  const result = await search({query:'更改位置 铜色把手'})
  assert.equal(result.sessions[0].excerpts[0].quotedSpeaker,'徐弦：')
  assert.equal((await search({query:'点亮大灯 铜色把手'})).status,'no-match')
  const split = '徐弦：只提议先改侧门的位置。铜色把手留作下次讨论。'
  const next = fixture({ minutes:{header:header('minutes'),events:[message(0,split)]} })
  assert.equal((await next.search({query:'更改位置 铜色把手'})).status,'no-match')
})

test('a surname with an extra qualifying role, a different speaker, and a dated heading do not authorize attribution', async () => {
  const filler='继续确认会议纪要，现场暂未做决定。'.repeat(16)
  const text='赵丁：'+filler+'旧灯罩下周再装。\n剪辑师赵丁：缓办。\n苏芸：另有用途。\n日期：'+filler+'北岸要拆板。'
  const { search } = fixture({minutes:{header:header('minutes'),events:[message(0,text)]}})
  for(const query of ['剪辑师赵丁 旧灯罩','苏芸 旧灯罩','日期 北岸']) {
    assert.equal((await search({query})).status,'no-match',query)
  }
})

test('speaker retrieval requires intact alphanumeric IDs and preserves exact matches in other sessions', async () => {
  const filler='An unrelated exchange is noted in the meeting. '.repeat(6)
  const quoted='Lee: '+filler+'I tested platform 3829 yesterday.'
  const other='test platform 3829 was discussed.'
  const { search }=fixture({a:{header:header('a'),events:[message(0,quoted)]},b:{header:header('b'),events:[message(0,other)]}})
  assert.equal((await search({query:'Lee tests platform 3820'})).status,'no-match')
  assert.deepEqual((await search({query:'test platform 3829'})).sessions.map(s=>s.sessionId),['b'])
})

test('pointer dereference returns only the bound source message, isolates same-name roles and enforces withdrawal/workspace bounds', async () => {
  const targetText = '《夜渡》后期通话纪要，2024年10月17日。\n周原：在制片签字之前，请先给我留个试听文件，暂时别替换交付母版。展映版先试留船尾最后一声铃。'
  const distractorText = '《夜渡》物料分工，2024年11月1日。\n剪辑助理周原：我在校出口型字幕。'
  const foreignText = '其他项目的记录。'
  const data = {
    distractor: { header: header('distractor'), events: [event(0, 'session/title', { title: '《夜渡》物料分工' }), message(1, distractorText)] },
    target: { header: header('target'), events: [event(0, 'session/title', { title: '《夜渡》后期通话纪要' }), message(1, targetText)] },
    foreign: { header: header('foreign', other), events: [message(0, foreignText)] },
  }
  const { ctx, reads } = fixture(data)
  const res = await readWorkspaceHistorySources(ctx, {
    session: caller,
    pointers: [
      { sessionId: 'target', messageIds: ['target:1'], quotes: ['展映版先试留船尾最后一声铃。'] },
      { sessionId: 'foreign', messageIds: ['foreign:0'], quotes: [foreignText] },
    ],
  })
  assert.equal(res.status, 'found')
  assert.equal(res.resolution, 'source-pointer')
  assert.deepEqual(res.sessions.map(s => s.sessionId), ['target'])
  assert.deepEqual(reads, ['target'])
  assert.equal(res.sessions[0].excerpts.length, 1)
  assert.equal(res.sessions[0].excerpts[0].text, targetText)
  assert.doesNotMatch(JSON.stringify(res), /剪辑助理|其他项目/u)
  const revoked = await readWorkspaceHistorySources(ctx, {
    session: caller,
    pointers: [{ sessionId: 'target', messageIds: ['target:1'], quotes: ['展映版先试留船尾最后一声铃。'] }],
    allowSource: ({ sessionId, seq }) => !(sessionId === 'target' && seq === 1),
  })
  assert.equal(revoked.status, 'no-match')
  assert.deepEqual(revoked.sessions, [])
})
