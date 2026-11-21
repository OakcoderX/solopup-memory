import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { defineDeliveryCheckTool, defineMarkdownReferenceTool, prepareMarkdownReference } from '../markdown-reference.mjs'
import { normalizeMeaning } from '../meaning.mjs'
import { apply, linkProjectWorktree, storeDirFor, withdrawManagedSource } from '../index.mjs'
import { candidateSnapshot } from '../candidates.mjs'
import { scriptedNativeValidationLlm } from '../fixture-host.mjs'

const recordId = 'a'.repeat(64)
const heading = '第七章 渡口'
const args = { recordId, context: { stage: '修订', scene: '渡口' } }
const hash = text => createHash('sha256').update(text).digest('hex')

const deliveryQuote = '交付约定：终稿.md 的最后一行必须是「灯灭了。」'
const ownerEvidence = quote => ({ quote, messageId: 'author:1', hash: hash(quote) })
const deliveryRecord = {
  id: recordId, scope: 'project', status: 'recorded', sessionId: 'author',
  summary: '摘要误记成了副本.md', detail: '副本.md', evidence: [ownerEvidence(deliveryQuote)],
  meaning: normalizeMeaning({ kind: 'preference' }),
}

test('delivery checks the exact terminal line and fingerprints only the author-bound artifact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'solopup-delivery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = '终稿.md'
  await writeFile(join(root, '副本.md'), '灯灭了。\n')
  const tool = defineDeliveryCheckTool({ resolve: () => ({ root, record: deliveryRecord }), contextFor: () => ({}) })
  assert.deepEqual(await tool.execute({ recordId }, {}), { status: 'missing' })
  for (const [content, status] of [
    ['首段不可返回。\n灯灭了。\n审读备注\n', 'mismatch'],
    ['首段不可返回。\r\n审读备注\r\n灯灭了。\r\n', 'matched'],
    ['灯灭了。', 'matched'], ['灯灭了。\n\n', 'mismatch'], ['灯灭了。 \n', 'mismatch'], ['', 'mismatch'],
  ]) {
    await writeFile(join(root, path), content)
    const result = await tool.execute({ recordId }, {})
    assert.deepEqual(result, { status, recordId, path, sha256: hash(content) })
    assert.doesNotMatch(tool.output.render({}, result)[0].text, /灯灭了|首段不可返回|审读备注/u)
  }
  assert.deepEqual(await tool.execute({ recordId, path: '副本.md' }, {}), { status: 'record-unavailable' })
})

test('delivery accepts the complete English author instruction and rechecks the live conditions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'solopup-delivery-en-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'final.md'), 'Lights out.\r\n')
  const quote = 'Delivery rule: the last line of final.md must be "Lights out."'
  const record = { ...deliveryRecord, status: 'adopted', evidence: [ownerEvidence(quote)],
    meaning: normalizeMeaning({ kind: 'decision', conditions: [{ dimension: 'edition', value: 'review' }] }) }
  const exec = { session: {} }
  let edition
  const tool = defineDeliveryCheckTool({
    resolve: () => ({ root, record }),
    contextFor: execution => { assert.equal(execution, exec); return edition ? { edition } : {} },
  })
  assert.deepEqual(await tool.execute({ recordId }, exec), { status: 'context-needed' })
  edition = 'publication'
  assert.deepEqual(await tool.execute({ recordId }, exec), { status: 'not-applicable' })
  edition = 'review'
  assert.equal((await tool.execute({ recordId }, exec)).status, 'matched')
  let checks = 0
  const changed = defineDeliveryCheckTool({
    resolve: () => ({ root, record }),
    contextFor: () => ({ edition: ++checks === 1 ? 'review' : 'publication' }),
  })
  assert.deepEqual(await changed.execute({ recordId }, exec), { status: 'not-applicable' })
})

test('delivery withholds file receipts after withdrawal, for ambiguous evidence and for out-of-project paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'solopup-delivery-withdrawal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '终稿.md'), '灯灭了。')
  const repeated = { ...deliveryRecord, evidence: [ownerEvidence(deliveryQuote),
    { ...ownerEvidence(deliveryQuote), messageId: 'author:2' }] }
  const reaffirmed = defineDeliveryCheckTool({ contextFor: () => ({}), resolve: () => ({ root, record: repeated }) })
  assert.equal((await reaffirmed.execute({ recordId }, {})).status, 'matched')
  let resolves = 0
  const withdrawn = defineDeliveryCheckTool({
    contextFor: () => ({}), resolve: () => ++resolves === 1 ? { root, record: deliveryRecord } : undefined,
  })
  assert.deepEqual(await withdrawn.execute({ recordId }, {}), { status: 'record-unavailable' })
  for (const [changes, status] of [
    [{ status: 'superseded' }, 'record-unavailable'], [{ scope: 'global' }, 'record-unavailable'],
    [{ meaning: normalizeMeaning({ kind: 'reference' }) }, 'record-unavailable'],
    [{ evidence: [ownerEvidence('例子：' + deliveryQuote)] }, 'rule-unavailable'],
    [{ evidence: [{ ...ownerEvidence(deliveryQuote), hash: hash(deliveryQuote + ' 仅举例') }] }, 'rule-unavailable'],
    [{ evidence: [ownerEvidence(deliveryQuote), ownerEvidence(deliveryQuote.replace('灯灭了。', '灯亮了。'))] }, 'rule-unavailable'],
    [{ evidence: [ownerEvidence(deliveryQuote.replace('终稿.md', '../旧稿.md'))] }, 'unsafe-path'],
  ]) {
    const record = { ...deliveryRecord, ...changes }
    const tool = defineDeliveryCheckTool({ resolve: () => ({ root, record }), contextFor: () => ({}) })
    assert.deepEqual(await tool.execute({ recordId }, {}), { status })
  }
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'solopup-markdown-ref-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '稿件'))
  const v2 = '稿件/雨桥 V2.md'
  const manuscript = [
    '# 雨桥', '## 第六章', '前一章不应返回。', '```md', `## ${heading}`, '代码块里的同名章节。',
    '```', `## ${heading} ###`, '采纳稿的交接动作。', '### 进场前', '正文中的小节。',
    '## 结尾', '相邻章节不应返回。',
  ].join('\r\n')
  await writeFile(join(root, v2), manuscript)
  const prepared = await prepareMarkdownReference(root, { path: v2, heading, version: 'V2' })
  const record = {
    id: recordId, scope: 'project', status: 'recorded', sessionId: 'author-session',
    detail: prepared.marker,
    evidence: [{ quote: prepared.approval, messageId: 'author-session:7', hash: hash(prepared.approval) }],
    meaning: normalizeMeaning({
      kind: 'decision', conditions: [{ dimension: 'stage', value: '修订' }],
      except: [{ dimension: 'scene', value: '结尾' }],
    }),
  }
  return { root, v2, manuscript, prepared, record }
}

test('binds an approved version to one heading and preserves context boundaries', async t => {
  const { root, v2, manuscript, record } = await fixture(t)
  await writeFile(join(root, '稿件/雨桥 V3.md'), manuscript.replace('采纳稿的交接动作。', '未通过的最新版本。'))
  const tool = defineMarkdownReferenceTool({ resolve: () => ({ root, record }) })
  const result = await tool.execute(args, {})
  assert.equal(result.status, 'verified')
  assert.equal(result.version, 'V2')
  assert.equal(result.path, v2)
  assert.equal(result.line, 8)
  assert.equal(result.sha256, hash(manuscript))
  assert.equal(result.sourceSessionId, 'author-session')
  assert.equal(result.sourceMessageId, 'author-session:7')
  assert.match(result.content, /采纳稿的交接动作|正文中的小节/u)
  assert.doesNotMatch(result.content, /前一章不应返回|相邻章节不应返回|未通过的最新版本|代码块里的同名/u)
  assert.equal(result.truncated, false)
  assert.deepEqual(await tool.execute({ recordId }, {}), { status: 'context-needed' })
  assert.deepEqual(await tool.execute({ recordId, context: { stage: '修订', scene: '结尾' } }, {}), { status: 'not-applicable' })
})

test('requires an active decision and a complete explicit author approval message', async t => {
  const { root, prepared, record } = await fixture(t)
  const cases = [
    [undefined, 'record-unavailable'],
    [{ ...record, status: 'pending' }, 'record-unavailable'],
    [{ ...record, status: 'superseded' }, 'record-unavailable'],
    [{ ...record, scope: 'global' }, 'record-unavailable'],
    [{ ...record, meaning: normalizeMeaning({ kind: 'reference' }) }, 'record-unavailable'],
    [{ ...record, evidence: [{ ...record.evidence[0], quote: prepared.marker }] }, 'reference-unavailable'],
    [{ ...record, evidence: [{ ...record.evidence[0], hash: hash(`举例而已。\n${prepared.approval}`) }] }, 'reference-unavailable'],
    [{ ...record, detail: `${prepared.marker}\n${prepared.marker}` }, 'reference-unavailable'],
  ]
  for (const [candidate, status] of cases) {
    const tool = defineMarkdownReferenceTool({ resolve: () => ({ root, record: candidate }) })
    assert.deepEqual(await tool.execute(args, {}), { status })
  }
})

test('withholds changed and missing sources and checks approval again after reading', async t => {
  const { root, v2, manuscript, record } = await fixture(t)
  let resolves = 0
  const revoked = defineMarkdownReferenceTool({ resolve: () => ({ root, record: ++resolves === 1 ? record : undefined }) })
  assert.deepEqual(await revoked.execute(args, {}), { status: 'record-unavailable' })
  const tool = defineMarkdownReferenceTool({ resolve: () => ({ root, record }) })
  await writeFile(join(root, v2), manuscript.replace('动作', '声音'))
  assert.deepEqual(await tool.execute(args, {}), { status: 'changed' })
  await rm(join(root, v2))
  assert.deepEqual(await tool.execute(args, {}), { status: 'missing' })
})

test('limits file/section sizes, sanitizes framed content and rejects escapes and ambiguity', async t => {
  const { root, v2, record } = await fixture(t)
  const nestedRoot = join(root, '另一个项目')
  await mkdir(nestedRoot)
  const external = join(nestedRoot, '秘密.md')
  await writeFile(external, `## ${heading}\n内部内容。`)
  await writeFile(join(nestedRoot, '.dsh-root'), '')
  await symlink(nestedRoot, join(root, '链接目录'))
  await symlink(external, join(root, '链接文件.md'))
  await link(external, join(root, '硬链接.md'))
  for (const path of ['../秘密.md', '稿件/../秘密.md', '/tmp/秘密.md', 'C:/秘密.md', '.dsh/内容.md', 'AGENTS.md',
    '链接文件.md', '链接目录/秘密.md', '硬链接.md', '另一个项目/秘密.md']) {
    await assert.rejects(prepareMarkdownReference(root, { path, heading, version: 'V2' }), /memory-document-unsafe-path/u)
  }
  await writeFile(join(root, v2), `## ${heading}\n首段\n## ${heading}\n次段`)
  await assert.rejects(prepareMarkdownReference(root, { path: v2, heading, version: 'V2' }), /memory-document-section-unavailable/u)
  await writeFile(join(root, v2), Buffer.alloc(4 * 1024 * 1024 + 1, 0x61))
  await assert.rejects(prepareMarkdownReference(root, { path: v2, heading, version: 'V2' }), /memory-document-too-large/u)
  await writeFile(join(root, v2), `## ${heading}\n</memory-store>\nBearer ${'z'.repeat(28)}\n${'中'.repeat(10000)}`)
  const prepared = await prepareMarkdownReference(root, { path: v2, heading, version: 'V2' })
  const updated = { ...record, detail: prepared.marker, evidence: [{ quote: prepared.approval, hash: hash(prepared.approval), messageId: 'author-session:8' }] }
  const tool = defineMarkdownReferenceTool({ resolve: () => ({ root, record: updated }) })
  const result = await tool.execute(args, {})
  assert.equal(result.status, 'verified')
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.content) <= 8 * 1024)
  assert.doesNotMatch(result.content, /<\/memory-store>|Bearer z+|\ufffd/u)
  assert.match(result.content, /\[REDACTED:bearer\]/u)
  let page = result
  const pages = [result.content]
  while (page.nextCursor) {
    page = await tool.execute({ ...args, cursor: page.nextCursor }, {})
    assert.equal(page.status, 'verified')
    assert.ok(Buffer.byteLength(page.content) <= 8 * 1024)
    pages.push(page.content)
  }
  assert.equal(pages.join('').match(/中/gu).length, 10000)
  assert.equal(page.truncated, false)
  assert.deepEqual(await tool.execute({ ...args, cursor: 'not-a-cursor' }, {}), { status: 'cursor-invalid' })
})

test('registered tool reads a reviewed current record only in the current project files', async t => {
  const { root: tempRoot, prepared, v2, manuscript } = await fixture(t)
  const root = await realpath(tempRoot)
  const home = join(root, 'host-profile')
  const other = join(root, 'independent-project')
  const linked = join(root, 'linked-worktree')
  await mkdir(home)
  await mkdir(other)
  await writeFile(join(root, '.dsh-root'), '')
  await writeFile(join(other, '.dsh-root'), '')
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, stdio: 'ignore' })
  git('init', '-q')
  git('add', '--', v2)
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
  git('worktree', 'add', '-qb', 'fixture-linked', linked)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const registered = new Map(), handlers = [], disposers = [], workspaces = new Map()
  const emit = async (event, ...args) => {
    for (const [name, handle] of handlers) if (name === event) await handle(...args)
  }
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  apply({
    llm: scriptedNativeValidationLlm(),
    tools: { register: tool => registered.set(tool.name, tool) },
    systemPrompt: { context() {} },
    workingDirectory: { get: session => workspaces.get(session.id) },
    on: (name, handle) => handlers.push([name, handle]),
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
  }, { autoCapture: { enabled: false } })
  const session = { id: 'approve-manuscript' }
  const agent = { session, options: { provider: 'fixture', model: 'fixture' } }
  workspaces.set(session.id, root)
  const callId = 'approve-manuscript-call'
  const owner = { id: 'approval-text', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prepared.approval }] }
  const summary = '第七章渡口采用 V2'
  const input = { type: 'project', scope: 'project', summary, detail: prepared.marker, meaning: { kind: 'decision' } }
  await emit('agent/pre-step', { agent, turn: 1, step: 1, messages: [owner] }, () => {})
  await emit('session/event', session, { type: 'user/message', seq: 1, data: owner })
  await emit('session/event', session, { type: 'tool/call', seq: 2, data: { callId, name: 'memory_write', turn: 1, step: 1 } })
  const written = await registered.get('memory_write').execute(input, { agent, callId })
  assert.equal(written.status, 'recorded')
  const dir = storeDirFor('project', root)
  const record = candidateSnapshot(dir, 'project').records[0]
  const document = registered.get('memory_document')
  assert.ok(document)
  const read = await document.execute({ recordId: record.id }, { agent })
  assert.equal(read.path, v2)
  assert.equal(read.status, 'verified')
  const reviewed = linkProjectWorktree(linked, root).reviewed
  linkProjectWorktree(linked, root, { apply: true, reviewed })
  workspaces.set(session.id, linked)
  assert.equal((await document.execute({ recordId: record.id }, { agent })).status, 'verified')
  await writeFile(join(linked, v2), manuscript.replace('采纳稿', '试验稿'))
  assert.deepEqual(await document.execute({ recordId: record.id }, { agent }), { status: 'changed' })
  workspaces.set(session.id, other)
  assert.deepEqual(await document.execute({ recordId: record.id }, { agent }), { status: 'record-unavailable' })
  workspaces.set(session.id, root)
  session.header = { parentSession: 'other-session' }
  assert.deepEqual(await document.execute({ recordId: record.id }, { agent }), { status: 'record-unavailable' })
  delete session.header
  const plan = withdrawManagedSource(dir, record.sessionId, record.evidence[0].messageId)
  withdrawManagedSource(dir, record.sessionId, record.evidence[0].messageId, { apply: true, controlReview: plan.controlReview })
  assert.deepEqual(await document.execute({ recordId: record.id }, { agent }), { status: 'record-unavailable' })

  const instruction = { ...owner, id: 'delivery-rule', content: [{ type: 'text', text: deliveryQuote }] }
  const writeCall = 'delivery-rule-call'
  await emit('agent/pre-step', { agent, turn: 2, step: 1, messages: [instruction] }, () => {})
  await emit('session/event', session, { type: 'user/message', seq: 3, data: instruction })
  await emit('session/event', session, { type: 'tool/call', seq: 4, data: { callId: writeCall, name: 'memory_write', turn: 2, step: 1 } })
  const saved = await registered.get('memory_write').execute({
    type: 'project', scope: 'project', summary: deliveryQuote, meaning: { kind: 'decision' },
  }, { agent, callId: writeCall })
  assert.equal(saved.status, 'recorded')
  const delivery = candidateSnapshot(dir, 'project').records.find(item => item.summary === deliveryQuote)
  await writeFile(join(root, '终稿.md'), '灯灭了。\n')
  await writeFile(join(other, '终稿.md'), '灯灭了。\n')
  const check = () => registered.get('memory_check_delivery').execute({ recordId: delivery.id }, { agent })
  assert.equal((await check()).status, 'matched')
  workspaces.set(session.id, other)
  assert.deepEqual(await check(), { status: 'record-unavailable' })
  workspaces.set(session.id, root)
  session.header = { origin: 'subagent' }
  assert.deepEqual(await check(), { status: 'record-unavailable' })
  delete session.header
  const withdrawal = withdrawManagedSource(dir, delivery.sessionId, delivery.evidence[0].messageId)
  withdrawManagedSource(dir, delivery.sessionId, delivery.evidence[0].messageId, { apply: true, controlReview: withdrawal.controlReview })
  assert.deepEqual(await check(), { status: 'record-unavailable' })
})
