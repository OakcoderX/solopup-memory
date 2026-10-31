import {applyWithValidationFixture as apply} from './fixture-host.mjs'
import {prepareMountedFixture,writeFixtureMemory} from './fixture-host.mjs'
import {realpathSync} from 'node:fs'
/**
 * 自动捕获的测试。跑法：node --test ~/.dsh/plugins/memory/test-capture.mjs
 *
 * 这里用假 LLM 验证「提示词 → 解析 → 过闸 → 落库 → 审计」整条链路，
 * 不产生真实模型调用。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { chunkText, parseCandidates, buildUserPrompt, extractWithLlm, selectCaptureControls } from './capture-llm.mjs'
import { captureMessage, assessCandidate } from './capture-evidence.mjs'
import { listCaptureJobs, recoverCaptureJobs, abandonCaptureJob } from './capture-jobs.mjs'
import { listCandidates, stageCandidate, candidateSnapshot } from './candidates.mjs'
import {writeMemory, indexLine, storeDirFor, storeRevision, forgetMemory, adoptCandidate, withdrawManagedSource, searchStore} from './index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-capture-')))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    home,
    cwd,
    store: join(home, 'memory'),
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function fakeLlm(payload) {
  return {
    calls: 0,
    listProviders: () => [{ provider: 'fake', model: 'fake-model' }],
    async prepareCall() {
      this.calls += 1
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
      return {
        config: {},
        stream: async function* (request) {
          const result = typeof payload === 'function' ? await payload(request) : body
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: typeof result === 'string' ? result : JSON.stringify(result) } }
        },
      }
    },
  }
}

function mount({ home, cwd }, options = {}) {
  const handlers = []
  const captured = { tools: [] }
  const ctx = {
    systemPrompt: { context: (entry) => (captured.context = entry) },
    workingDirectory: { get: () => cwd },
    tools: { register: (definition) => captured.tools.push(definition) },
    on: (name, handler) => handlers.push([name, handler]),
  }
  if (options.llm !== undefined) ctx.llm = options.llm
  return { ctx, handlers, captured }
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

// ── 纯函数 ────────────────────────────────────────────────────────────────

test('chunkText 兼容 delta 与整体文本两种分片', () => {
  assert.equal(chunkText({ delta: { type: 'text_delta', text: '甲' } }), '甲')
  assert.equal(chunkText({ text: '乙' }), '乙')
  assert.equal(chunkText({ type: 'content_block_start', text: 'x' }), '')
  assert.equal(chunkText(undefined), '')
})

test('真实宿主协议：不把 reasoning-delta 当最终文本，不重复追加 block-end', async () => {
  const chunks = [
    { type: 'reasoning-delta', text: '先分析 [内部计划]，这里不是 JSON 答案。' },
    { type: 'text-delta', text: '[]' },
    { type: 'block-end', block: { type: 'text', text: '[]' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const llm = { async prepareCall(config) {
    assert.equal(config.reasoningEffort, 'off')
    return { config: { ...config }, async *stream(request) {
      assert.equal(request.reasoningEffort, 'off')
      yield* chunks
    } }
  } }
  assert.deepEqual(await extractWithLlm({ llm, messages: [], indexLines: [] }), [])
})

test('真实宿主协议：max-tokens 不得冒充成功，即使已有合法 JSON', async () => {
  const llm = { async prepareCall() { return { config: {}, async *stream() {
    yield { type: 'text-delta', text: '[]' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  } } } }
  await assert.rejects(extractWithLlm({ llm, messages: [], indexLines: [] }), /capture-max-tokens/)
})

test('绑定模型能力选择：支持off则关闭、普通模型省略，不猜测其他努力ID或更改预算', () => {
  const controls = Object.freeze({ maxTokens: 777, reasoningEffort: 'off' })
  assert.deepEqual(selectCaptureControls(controls, { reasoning: { efforts: [{ id: 'off' }] } }), controls)
  assert.deepEqual(selectCaptureControls(controls, {}), { maxTokens: 777 })
  assert.deepEqual(selectCaptureControls(controls, { reasoning: { efforts: [{ id: 'none' }, { id: 'low' }], defaultEffort: 'none' } }), { maxTokens: 777 })
  assert.deepEqual(selectCaptureControls(controls, { reasoning: { efforts: [{ id: 'medium' }] } }), { maxTokens: 777 })
  for (const info of [undefined, [], { reasoning: {} }, { reasoning: { efforts: [] } }]) assert.throws(() => selectCaptureControls(controls, info), /capture-model-capability/)
})

for (const [label, info, expected] of [
  ['关闭推理', { reasoning: { efforts: [{ id: 'off' }], defaultEffort: 'off' } }, 'off'],
  ['无推理参数', {}, undefined],
  ['必须推理且有默认', { reasoning: { efforts: [{ id: 'medium' }], defaultEffort: 'medium' } }, 'medium'],
  ['默认ID不能别名化', { reasoning: { efforts: [{ id: 'none' }], defaultEffort: 'none' } }, 'none'],
]) test(`抽取使用准备句柄的完整控制值：${label}，一次准备一次流`, async () => {
  let prepares = 0, streams = 0, guards = 0
  const llm = { async prepareCall(config, signal, configure) {
    prepares++
    assert.equal(typeof configure, 'function')
    const { provider, model, ...controls } = config
    const selected = configure(Object.freeze(controls), Object.freeze(info))
    const resolved = Object.freeze({ ...selected, provider, model, ...(selected.reasoningEffort === undefined && info.reasoning?.defaultEffort ? { reasoningEffort: info.reasoning.defaultEffort } : {}) })
    return { config: resolved, async *stream(request) {
      streams++
      assert.equal(request.provider, 'fixture'); assert.equal(request.model, 'fixture-model')
      assert.equal(request.maxTokens, 777); assert.equal(request.reasoningEffort, expected)
      assert.equal(Object.hasOwn(request, 'reasoningEffort'), Object.hasOwn(resolved, 'reasoningEffort'))
      yield { type: 'reasoning-delta', text: '[{"type":"user","summary":"隐藏推理不应变成记忆"}]' }
      yield { type: 'text-delta', text: '[]' }
    } }
  } }
  assert.deepEqual(await extractWithLlm({ llm, route: { provider: 'fixture', model: 'fixture-model' }, maxTokens: 777, messages: [], indexLines: [], beforeStream() { guards++ } }), [])
  assert.equal(prepares, 1); assert.equal(streams, 1); assert.equal(guards, 1)
})

test('准备期能力错误归一化、不含异常正文且不重试；同名流期错误不能冒充准备失败', async () => {
  for (const code of ['INVALID_MODEL_REASONING', 'UNSUPPORTED_REASONING_EFFORT']) {
    let attempts = 0
    const llm = { prepareCall() { attempts++; throw Object.assign(new Error('synthetic private provider diagnostic'), { code }) } }
    await assert.rejects(extractWithLlm({ llm, messages: [], indexLines: [] }), error => error.message === 'capture-model-capability')
    assert.equal(attempts, 1)
  }
  let attempts = 0
  const thrown = Object.assign(new Error('synthetic stream failure'), { code: 'INVALID_MODEL_REASONING' })
  const llm = { async prepareCall() { attempts++; return { config: {}, async *stream() { throw thrown } } } }
  await assert.rejects(extractWithLlm({ llm, messages: [], indexLines: [] }), error => error === thrown)
  assert.equal(attempts, 1)
})

test('能力解析超过硬超时：迟到的准备结果不启动流、不执行发送守卫', async () => {
  let release, guards = 0, streams = 0
  const llm = { prepareCall: () => new Promise(resolve => { release = resolve }) }
  await assert.rejects(extractWithLlm({ llm, messages: [], indexLines: [], timeoutMs: 10, beforeStream() { guards++ } }), /capture-timeout/)
  release({ config: { reasoningEffort: 'medium' }, async *stream() { streams++; yield '[]' } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(guards, 0); assert.equal(streams, 0)
})

test('真实宿主协议：仅推理无正文属于空响应，provider 错误不成功', async () => {
  const llm = { async prepareCall() { return { config: {}, async *stream() {
    yield { type: 'reasoning-delta', text: '在思考，没有最终正文' }
  } } } }
  await assert.rejects(extractWithLlm({ llm, messages: [], indexLines: [] }), /capture-empty-response/)
  const failure = { async prepareCall() { return { config: {}, async *stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'private' } } }
  } } } }
  await assert.rejects(extractWithLlm({ llm: failure, messages: [], indexLines: [] }), /capture-provider-error/)
})

test('硬超时：provider 不响应取消时，准备与流读取仍能按时退出', async () => {
  const never = () => new Promise(() => {})
  for (const llm of [
    { prepareCall: never },
    { async prepareCall() { return { config: {}, async *stream() { await never() } } } },
  ]) {
    const started = Date.now()
    await assert.rejects(extractWithLlm({ llm, messages: [], indexLines: [], timeoutMs: 10 }), /capture-timeout/)
    assert.ok(Date.now() - started < 1000)
  }
})

test('硬超时：迟到的准备结果不再启动模型流，迟到正文也不能成为候选', async () => {
  let release; let streamed = false
  const prepared = new Promise((resolve) => { release = resolve })
  const llm = { prepareCall: () => prepared }
  await assert.rejects(extractWithLlm({ llm, messages: [], indexLines: [], timeoutMs: 10 }), /capture-timeout/)
  release({ config: {}, async *stream() { streamed = true; yield '[]' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(streamed, false)
  let releaseChunk
  const late = new Promise((resolve) => { releaseChunk = resolve })
  const streamedLlm = { async prepareCall() { return { config: {}, async *stream() { await late; yield '[]' } } } }
  await assert.rejects(extractWithLlm({ llm: streamedLlm, messages: [], indexLines: [], timeoutMs: 10 }), /capture-timeout/)
  releaseChunk(); await new Promise((resolve) => setTimeout(resolve, 10))
})

test('硬超时：非法预算在请求前拒绝', async () => {
  const llm = fakeLlm([])
  for (const timeoutMs of [0, -1, Infinity, 1.5, 120001]) await assert.rejects(extractWithLlm({ llm, messages: [], indexLines: [], timeoutMs }), /invalid-timeout/)
  assert.equal(llm.calls, 0)
})

test('parseCandidates 容忍代码块围栏与前后废话', () => {
  const text = '思考中…\n```json\n[{"type":"feedback","summary":"改稿要附说明"}]\n```\n完'
  assert.deepEqual(parseCandidates(text), [{ type: 'feedback', summary: '改稿要附说明', detail: undefined }])
})

test('parseCandidates 丢掉非法类型、过短、含凭据的条目', () => {
  const text = JSON.stringify([
    { type: 'nope', summary: '非法类型' },
    { type: 'user', summary: '短' },
    { type: 'project', summary: `密钥 sk-${'a'.repeat(32)}` },
    { type: 'user', summary: '正常的一条记忆' },
  ])
  assert.deepEqual(parseCandidates(text), [{ type: 'user', summary: '正常的一条记忆', detail: undefined }])
})

test('buildUserPrompt 带现有索引与条数上限', () => {
  const prompt = buildUserPrompt(['用户甲'], ['- [user] 已有条目 — user.md'], 3)
  assert.match(prompt, /最多输出 3 条/)
  assert.match(prompt, /已有条目/)
  assert.match(prompt, /用户甲/)
})

test('抽取输入按 UTF-8 字节预算保留完整消息并明示省略', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: 'user', text: '中文内容'.repeat(400) }))
  const indexes = Array.from({ length: 120 }, () => '既有记忆'.repeat(100))
  const prompt = buildUserPrompt(messages, indexes, 3, 24 * 1024)
  assert.ok(Buffer.byteLength(prompt) <= 24 * 1024)
  assert.match(prompt, /预算省略/)
  const records = prompt.split('\n').filter((line) => line.startsWith('{')).map(JSON.parse)
  assert.ok(records.some((record) => record.id === 'm29'))
  assert.ok(records.every((record) => record.text === messages[0].text))
})

// ── 接线 ──────────────────────────────────────────────────────────────────

test('每 N 轮触发一次：候选经写入闸落库并留下审计', async () => {
  const box = sandbox()
  try {
    const llm = fakeLlm([
      { type: 'feedback', summary: '改稿必须附「改了什么、为什么」', detail: '来自用户纠正', scope: 'global', meaning:{kind:'claim'},basis: 'explicit', evidence: [{ messageId: 's1:event-2', quote: '改稿必须附「改了什么、为什么」' }] },
      { type: 'user', summary: '验收要量化到字数与标点', scope: 'global', meaning:{kind:'claim'},basis: 'explicit', evidence: [{ messageId: 's1:event-2', quote: '验收要量化到字数与标点' }] },
    ])
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    const { ctx, handlers } = mount(box, { llm })
    prepareMountedFixture()
  apply(ctx, { autoCapture: { everyTurns: 3 } })

    assert.equal(handlers.filter(([name]) => name === 'session/event').length, 2)
    const emit = ((session,event)=>{for(const [name,handler] of handlers)if(name==='session/event')handler(session,event)})
    const session = { id: 's1' }

    emit(session, {
      type: 'request/header',
      data: { header: { config: { provider: 'fake', model: 'fake-model' } } },
    })

    for (let i = 0; i < 3; i += 1) {
      emit(session, {
        type: 'user/message',
        data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '改稿必须附「改了什么、为什么」，验收要量化到字数与标点' }] } },
      })
      emit(session, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: `第 ${i} 条回答` }] } },
      })
    }
    emit(session, { type: 'step/end', data: {} })

    const index = join(box.store, 'MEMORY.md')
    assert.ok(await waitFor(() => existsSync(index) && readFileSync(index, 'utf8').includes('改稿必须附')))
    const text = readFileSync(index, 'utf8')
    assert.match(text, /改稿必须附/)
    assert.match(text, /验收要量化/)
    assert.ok(text.split('\n').find(line => line.includes('验收要量化')).endsWith(' — 索引摘要'))
    assert.equal(existsSync(join(box.store, 'user.md')), false, '仅摘要捕获不能生成指向不存在主题文件的引用')
    assert.ok(existsSync(join(box.store, 'feedback.md')), '有细节的捕获仍生成主题正文')

    const audit = readFileSync(join(box.store, '.audit.jsonl'), 'utf8')
    assert.match(audit, /"op":"capture"/)
    assert.match(audit, /"inserted":2/)
    assert.equal(llm.calls, 2)
  } finally {
    box.cleanup()
  }
})

test('没有 llm 时不触发自动捕获，仍保留显式工具来源监听', async () => {
  const box = sandbox()
  try {
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    const { ctx, handlers } = mount(box, {})
    prepareMountedFixture()
  apply(ctx, {})
    assert.equal(handlers.filter(([name]) => name === 'session/event').length, 1)
  } finally {
    box.cleanup()
  }
})

test('配置 enabled:false 时关闭自动捕获', async () => {
  const box = sandbox()
  try {
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    const { ctx, handlers } = mount(box, { llm: fakeLlm([]) })
    prepareMountedFixture()
  apply(ctx, { autoCapture: { enabled: false } })
    assert.equal(handlers.filter(([name]) => name === 'session/event').length, 1)
  } finally {
    box.cleanup()
  }
})

test('模型输出坏 JSON 时只记审计，不写入、不抛错', async () => {
  const box = sandbox()
  try {
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    const { ctx, handlers } = mount(box, { llm: fakeLlm('这不是 JSON') })
    prepareMountedFixture()
  apply(ctx, { autoCapture: { everyTurns: 1 } })
    const emit = ((session,event)=>{for(const [name,handler] of handlers)if(name==='session/event')handler(session,event)})
    emit({ id: 's2' }, { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '一句话' }] } } })
    emit({ id: 's2' }, { type: 'step/end', data: {} })

    const audit = join(box.store, '.audit.jsonl')
    assert.ok(await waitFor(() => existsSync(audit)))
    assert.match(readFileSync(audit, 'utf8'), /"op":"capture"/)
    assert.equal(existsSync(join(box.store, 'MEMORY.md')), false, '不应写入任何条目')
  } finally {
    box.cleanup()
  }
})

test('重复候选不会写第二次（走既有幂等闸）', async () => {
  const box = sandbox()
  try {
    const llm = fakeLlm((request) => {
      const message = promptMessages(request).find((m) => m.role === 'user')
      return [{ type: 'user', summary: '回答要结论先行', scope: 'global', meaning:{kind:'claim'},basis: 'explicit', evidence: [{ messageId: message.id, quote: '回答一直都要结论先行' }] }]
    })
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    const { ctx, handlers } = mount(box, { llm })
    prepareMountedFixture()
  apply(ctx, { autoCapture: { everyTurns: 1 } })
    const emit = ((session,event)=>{for(const [name,handler] of handlers)if(name==='session/event')handler(session,event)})
    const session = { id: 's3' }
    const say = () =>
      emit(session, { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '回答一直都要结论先行' }] } } })

    say()
    emit(session, { type: 'step/end', data: {} })
    const index = join(box.store, 'MEMORY.md')
    assert.ok(await waitFor(() => existsSync(index) && readFileSync(index, 'utf8').includes('结论先行')))

    say()
    emit(session, { type: 'step/end', data: {} })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const text = readFileSync(index, 'utf8')
    assert.equal((text.match(/回答要结论先行/g) ?? []).length, 1, '幂等闸应挡住第二次')
  } finally {
    box.cleanup()
  }
})

function promptMessages(request) {
  return request.messages[0].content[0].text.split('\n').flatMap((line) => {
    try { const value = JSON.parse(line); return value.id ? [value] : [] } catch { return [] }
  })
}

function userEvent(text, extra = {}) {
  return { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }], ...extra } } }
}

const evidenceMessage = captureMessage(userEvent('这个项目采用暖色，其他项目另定。'), 'm1')
const evidenceCandidate = { type: 'user', summary: '这个项目采用暖色', scope: 'project', meaning:{kind:'claim'},basis: 'explicit', evidence: [{ messageId: 'm1', quote: '这个项目采用暖色' }] }

test('证据：保留角色、来源定位及内容哈希，合成用户消息不计证据', () => {
  assert.equal(evidenceMessage.role, 'user')
  assert.match(evidenceMessage.hash, /^[a-f0-9]{64}$/)
  assert.equal(captureMessage(userEvent('这不是用户的直接发言', { source: { kind: 'tool' } }), 'x'), undefined)
})

test('来源分级：真实 v4 data.source 保留，未知来源与运行时召回不准入', () => {
  const content = [{ type: 'text', text: '以后始终按已确认的项目决定执行' }]
  assert.equal(captureMessage({ type: 'user/message', data: { source: { kind: 'user' }, content } }, 'real').role, 'user')
  for (const kind of [undefined, 'runtime-context', 'tool', 'system']) {
    assert.equal(captureMessage({ type: 'user/message', data: { source: kind ? { kind } : undefined, content } }, 'no'), undefined)
  }
})

test('证据：调用抽取模型之前打码凭据', () => {
  const secret = `sk-${'a'.repeat(32)}`
  const message = captureMessage(userEvent(`用户临时给出 ${secret}`), 'secret')
  const prompt = buildUserPrompt([message], [`索引 ${secret}`], 3)
  assert.ok(!prompt.includes(secret))
})

test('证据：用户原话匹配后才有落库资格', () => {
  assert.equal(assessCandidate(evidenceCandidate, [evidenceMessage], true).status, 'eligible')
})

for (const [label, patch, messages, hasProject, reason] of [
  ['无来源', { evidence: [] }, [evidenceMessage], true, 'missing-evidence'],
  ['伪造来源', { evidence: [{ messageId: '不存在', quote: '这个项目采用暖色' }] }, [evidenceMessage], true, 'invalid-user-evidence'],
  ['伪造原话', { evidence: [{ messageId: 'm1', quote: '任何项目一律采用暖色' }] }, [evidenceMessage], true, 'invalid-user-evidence'],
  ['助手自述', {}, [{ ...evidenceMessage, role: 'assistant' }], true, 'invalid-user-evidence'],
  ['项目丢失', {}, [evidenceMessage], false, 'missing-project'],
  ['无范围', { scope: undefined }, [evidenceMessage], true, 'missing-scope'],
  ['无认识类型', { basis: undefined }, [evidenceMessage], true, 'missing-basis'],
  ['项目决定写全局', { type: 'project', scope: 'global' }, [evidenceMessage], true, 'project-global'],
]) test(`证据拒绝：${label}`, () => {
  assert.equal(assessCandidate({ ...evidenceCandidate, ...patch }, messages, hasProject).reason, reason)
})

test('信念：推断只成为候选，同一消息重复引用不增加独立来源', () => {
  const result = assessCandidate({ ...evidenceCandidate, meaning:{kind:'claim'},basis: 'inferred', evidence: [evidenceCandidate.evidence[0], evidenceCandidate.evidence[0]] }, [evidenceMessage], true)
  assert.equal(result.status, 'candidate')
  assert.equal(result.evidence.length, 1)
})

async function runCapture(box, payload, cwd = box.cwd, sessionId = 'evidence-session') {
  const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
  const { ctx, handlers } = mount(box, { llm: fakeLlm(payload) })
  ctx.workingDirectory.get = () => cwd
  prepareMountedFixture()
  apply(ctx, { autoCapture: { everyTurns: 1 } })
  const emit = ((session,event)=>{for(const [name,handler] of handlers)if(name==='session/event')handler(session,event)})
  const session = { id: sessionId }
  emit(session, userEvent('这个项目采用暖色，其他项目另定。'))
  emit(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '用户长期喜欢所有画面都是暖色。' }] } } })
  emit(session, { type: 'step/end' })
  const path = join(box.store, '.capture-state.json')
  assert.ok(await waitFor(() => existsSync(path) && JSON.parse(readFileSync(path)).running === false))
  return JSON.parse(readFileSync(path))
}

function groundedPayload(request, patch = {}) {
  const user = promptMessages(request).find((m) => m.role === 'user')
  return [{ ...evidenceCandidate, evidence: [{ messageId: user.id, quote: '这个项目采用暖色' }], ...patch }]
}

test('自动捕获细节绑定已领取作业与用户引文，保持未人工复核状态', async () => {
  const box = sandbox()
  try {
    const state = await runCapture(box, request => groundedPayload(request, { detail: '合成来源细节：这个项目的暖色需要保持。', origin: 'adopted', callHash: 'f'.repeat(64) }))
    assert.equal(state.lastOutcome, 'ok')
    const dir = storeDirFor('project', box.cwd), record = candidateSnapshot(dir, 'project').records[0]
    assert.equal(record.origin, 'quoted-extraction'); assert.equal(record.status, 'recorded')
    assert.equal(record.callHash, state.jobId); assert.notEqual(record.callHash, 'f'.repeat(64))
    assert.equal(record.evidence[0].quote, '这个项目采用暖色')
    assert.match(readFileSync(join(dir, record.type + '.md'), 'utf8'), new RegExp('\\[candidate:' + record.id + '\\]'))
    assert.throws(() => adoptCandidate(dir, record.id, { scope: 'project' }), /context-only/)
  } finally { box.cleanup() }
})

test('撤回自动捕获来源会同时清理索引和细节，并抑制旧投影恢复', async () => {
  const box = sandbox()
  try {
    await runCapture(box, request => groundedPayload(request, { detail: '合成暖色细节 amber2468 不应在撤回后存留。' }))
    const dir = storeDirFor('project', box.cwd), record = candidateSnapshot(dir, 'project').records[0]
    const oldIndex = readFileSync(join(dir, 'MEMORY.md')), oldTopic = readFileSync(join(dir, record.type + '.md'))
    const preview = withdrawManagedSource(dir, record.sessionId, record.evidence[0].messageId, { scope: 'project' })
    const result = withdrawManagedSource(dir, record.sessionId, record.evidence[0].messageId, { scope: 'project', apply: true, reviewedIndex: preview.reviewedIndex, candidateRevision: preview.candidateRevision, controlReview:preview.controlReview })
    assert.equal(result.cleanupComplete, true)
    assert.doesNotMatch(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /采用暖色/)
    assert.doesNotMatch(readFileSync(join(dir, record.type + '.md'), 'utf8'), /amber2468/)
    writeFileSync(join(dir, 'MEMORY.md'), oldIndex); writeFileSync(join(dir, record.type + '.md'), oldTopic)
    assert.equal(searchStore(dir, '暖色').hits.length, 0)
    assert.equal(searchStore(dir, 'amber2468').hits.length, 0)
  } finally { box.cleanup() }
})

test('同一后台批次的多个发布保留同一作业来源但具有不同记忆身份', async () => {
  const box = sandbox()
  try {
    const state = await runCapture(box, request => [
      ...groundedPayload(request, { summary: '这个项目采用暖色的合成画面', detail: '合成画面细节。' }),
      ...groundedPayload(request, { summary: '这个项目采用暖色的合成文字', detail: '合成文字细节。' }),
    ])
    assert.equal(state.lastOutcome, 'ok')
    const records = candidateSnapshot(storeDirFor('project', box.cwd), 'project').records
    assert.equal(records.length, 2); assert.notEqual(records[0].id, records[1].id)
    assert.equal(records[0].callHash, state.jobId); assert.equal(records[1].callHash, state.jobId)
    assert.deepEqual(records[0].sources, records[1].sources)
  } finally { box.cleanup() }
})

test('撤回原引文后，新的捕获作业不能借换摘要重新采纳同一来源', async () => {
  const box = sandbox()
  try {
    await runCapture(box, request => groundedPayload(request))
    const dir = storeDirFor('project', box.cwd), record = candidateSnapshot(dir, 'project').records[0]
    const preview = withdrawManagedSource(dir, record.sessionId, record.evidence[0].messageId, { scope: 'project' })
    withdrawManagedSource(dir, record.sessionId, record.evidence[0].messageId, { scope: 'project', apply: true, reviewedIndex: preview.reviewedIndex, candidateRevision: preview.candidateRevision, controlReview:preview.controlReview })
    const state = await runCapture(box, request => groundedPayload(request, { summary: '合成替代摘要仍采用暖色', detail: '同一旧来源的合成重新发布。' }))
    assert.notEqual(state.lastOutcome, 'job-succeeded')
    assert.equal(candidateSnapshot(dir, 'project').records.filter(record => record.status === 'recorded').length, 0)
    assert.doesNotMatch(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /替代摘要/)
  } finally { box.cleanup() }
})

test('接线：同时读取全局与项目去重索引，并把项目条件偏好写进项目库', async () => {
  const box = sandbox()
  try {
    writeFixtureMemory({ type: 'user', dir: box.store, line: indexLine('user', '全局偏好是回答结论先行'), scope: 'global' })
    const project = storeDirFor('project', box.cwd)
    writeFixtureMemory({ type: 'project', dir: project, line: indexLine('project', '项目决定是输出横屏图像') })
    let prompt
    const state = await runCapture(box, (request) => { prompt = request.messages[0].content[0].text; return groundedPayload(request) })
    assert.match(prompt, /全局偏好/)
    assert.match(prompt, /项目决定/)
    assert.match(readFileSync(join(project, 'MEMORY.md'), 'utf8'), /采用暖色/)
    assert.doesNotMatch(readFileSync(join(box.store, 'MEMORY.md'), 'utf8'), /采用暖色/)
    const write = readFileSync(join(project, '.audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((r) => r.via === 'auto-capture')
    assert.equal(write.scope, 'project')
    assert.equal(write.evidence[0].quote, '这个项目采用暖色')
    assert.equal(state.lastOutcome, 'ok')
  } finally { box.cleanup() }
})

test('接线：模型推断持久化但不进入长期索引或注入上下文', async () => {
  const box = sandbox()
  try {
    await runCapture(box, (request) => groundedPayload(request, { meaning:{kind:'claim'},basis: 'inferred' }))
    const project = storeDirFor('project', box.cwd)
    assert.equal(existsSync(join(project, 'MEMORY.md')), false)
    assert.match(readFileSync(join(project, '.audit.jsonl'), 'utf8'), /inference-needs-review/)
    assert.equal(listCandidates(project).total, 1)
    assert.match(listCandidates(project).records[0].summary, /暖色/)
    assert.doesNotMatch(readFileSync(join(project, '.audit.jsonl'), 'utf8'), /暖色/)
    writeFixtureMemory({ type: 'user', dir: box.store, line: indexLine('user', '已确认的有效偏好使用中文回答'), scope: 'global' })
    const { ctx, captured } = mount(box)
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    prepareMountedFixture()
  apply(ctx, { autoCapture: { enabled: false } })
    const injected = captured.context.text({ agent: { session: {} } })
    assert.match(injected, /使用中文回答/)
    assert.doesNotMatch(injected, /暖色/)
    assert.match(readFileSync(join(box.store, '.audit.jsonl'), 'utf8'), /"staged":1/)
  } finally { box.cleanup() }
})

test('接线：候选箱损坏时记失败并保留现场，不破坏有效记忆', async () => {
  const box = sandbox()
  try {
    writeFixtureMemory({type:'user',scope:'global',dir:box.store,line:indexLine('user','Independent preserved preference cobalt7654')})
    const state = await runCapture(box, (request) => {
      const project = storeDirFor('project', box.cwd)
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, '.candidates.json'), 'broken-inbox')
      return groundedPayload(request, { meaning:{kind:'claim'},basis: 'inferred' })
    })
    assert.equal(state.lastOutcome, 'error');assert.equal(state.lastError,'capture-failed')
    assert.match(readFileSync(join(box.store, '.audit.jsonl'), 'utf8'), /capture-failed/)
    assert.equal(readFileSync(join(storeDirFor('project', box.cwd), '.candidates.json'), 'utf8'), 'broken-inbox')
    assert.match(readFileSync(join(box.store,'MEMORY.md'),'utf8'),/cobalt7654/);assert.ok(searchStore(box.store,'cobalt7654').hits.length>0)
  } finally { box.cleanup() }
})

test('接线：新来源重新表达已撤回内容时进入复审，不自动恢复有效记忆', async () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('project', box.cwd)
    const proposal = { type: 'user', scope: 'project', summary: '这个项目采用暖色', sessionId: 'old-source', indexRevision: storeRevision(dir),
      evidence: [{ messageId: 'old-message', hash: 'b'.repeat(64), quote: '这个项目采用暖色' }] }
    const record = stageCandidate(dir, proposal)
    const approval = adoptCandidate(dir, record.id)
    adoptCandidate(dir, record.id, { apply: true, reviewedIndex: approval.reviewedIndex, candidateRevision: approval.candidateRevision })
    const removal = withdrawManagedSource(dir, 'old-source', 'old-message')
    withdrawManagedSource(dir, 'old-source', 'old-message', { apply: true, reviewedIndex: removal.reviewedIndex, candidateRevision: removal.candidateRevision })
    const state = await runCapture(box, groundedPayload)
    assert.equal(state.lastOutcome, 'ok')
    assert.equal(searchStore(dir, '暖色').hits.length, 0)
    assert.equal(listCandidates(dir).total, 1)
    assert.match(readFileSync(join(dir, '.audit.jsonl'), 'utf8'), /fresh-source-reaffirmation-needs-review/)
  } finally { box.cleanup() }
})

test('接线：缺少项目目录时拒绝项目候选，不退回全局', async () => {
  const box = sandbox()
  try {
    await runCapture(box, groundedPayload, '')
    assert.equal(existsSync(join(box.store, 'MEMORY.md')), false)
    assert.match(readFileSync(join(box.store, '.audit.jsonl'), 'utf8'), /missing-project/)
  } finally { box.cleanup() }
})

test('接线：坏 JSON 与空数组区分，最终状态及时落盘', async () => {
  const box = sandbox()
  try {
    const bad = await runCapture(box, '非法 JSON')
    assert.equal(bad.lastOutcome, 'error')
    assert.equal(bad.lastError, 'capture-invalid-json')
    const good = await runCapture(box, [], box.cwd, 'evidence-session-next')
    assert.equal(good.lastOutcome, 'ok')
    assert.equal(good.lastError, undefined)
  } finally { box.cleanup() }
})

test('接线：异常文本不泄漏到持久日志', async () => {
  const box = sandbox()
  try {
    const secret = `sk-${'z'.repeat(32)}`
    const state = await runCapture(box, () => { throw new Error(secret) })
    assert.equal(state.lastError, 'capture-failed')
    assert.ok(!readFileSync(join(box.store, '.audit.jsonl'), 'utf8').includes(secret))
  } finally { box.cleanup() }
})

test('作业接线：模型调用前已有持久领取，完成记录只含元数据', async () => {
  const box = sandbox()
  try {
    const state = await runCapture(box, () => {
      const jobs = listCaptureJobs(box.store).jobs
      assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'running')
      return []
    })
    const job = listCaptureJobs(box.store).jobs[0]
    assert.equal(job.id, state.jobId); assert.equal(job.status, 'succeeded')
    assert.deepEqual(job.counts, { proposed: 0, inserted: 0, staged: 0, rejected: 0 })
    assert.doesNotMatch(readFileSync(join(box.store, '.capture-jobs.json'), 'utf8'), /暖色|evidence-session|fake-model|proj/)
  } finally { box.cleanup() }
})

test('作业接线：插件重开后同一快照不重复调用模型', async () => {
  const box = sandbox()
  try {
    await runCapture(box, [])
    let invoked = false
    const state = await runCapture(box, () => { invoked = true; return [] })
    assert.equal(state.lastOutcome, 'job-succeeded'); assert.equal(invoked, false)
    assert.equal(listCaptureJobs(box.store).jobs.length, 1)
  } finally { box.cleanup() }
})

test('能力失败仅保存固定错误码，同一快照重开不把失败当作可重发许可', async () => {
  const box = sandbox()
  try {
    let prepares = 0
    const llm = fakeLlm([])
    llm.prepareCall = async () => { prepares++; throw Object.assign(new Error('synthetic private capability diagnostic'), { code: 'INVALID_MODEL_REASONING' }) }
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    const run = async () => {
      const { ctx, handlers } = mount(box, { llm })
      prepareMountedFixture()
  apply(ctx, { autoCapture: { everyTurns: 1 } })
      const emit = ((session,event)=>{for(const [name,handler] of handlers)if(name==='session/event')handler(session,event)}), session = { id: 'capability-failure-session' }
      emit(session, userEvent('以后所有回复都先给明确结论，再解释判断依据。'))
      emit(session, { type: 'step/end' })
      const path = join(box.store, '.capture-state.json')
      assert.ok(await waitFor(() => existsSync(path) && JSON.parse(readFileSync(path)).running === false))
      return JSON.parse(readFileSync(path))
    }
    const first = await run()
    assert.equal(first.lastError, 'capture-model-capability')
    assert.equal(listCaptureJobs(box.store).jobs[0].reason, 'capture-model-capability')
    for (const file of ['.capture-jobs.json', '.capture-state.json', '.audit.jsonl']) assert.doesNotMatch(readFileSync(join(box.store, file), 'utf8'), /synthetic private capability diagnostic/)
    const second = await run()
    assert.equal(second.lastOutcome, 'job-failed'); assert.equal(prepares, 1)
  } finally { box.cleanup() }
})

test('显式捕获路由优先于主会话模型，预算不被主请求头覆盖', async () => {
  const box = sandbox()
  try {
    const llm = fakeLlm([])
    const prepare = llm.prepareCall.bind(llm)
    llm.prepareCall = async (config, ...rest) => {
      assert.equal(config.provider, 'configured-capture'); assert.equal(config.model, 'configured-model'); assert.equal(config.maxTokens, 777)
      return prepare(config, ...rest)
    }
    const { ctx, handlers } = mount(box, { llm })
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    prepareMountedFixture()
  apply(ctx, { autoCapture: { everyTurns: 1, provider: 'configured-capture', model: 'configured-model', maxTokens: 777 } })
    const emit = ((session,event)=>{for(const [name,handler] of handlers)if(name==='session/event')handler(session,event)}), session = { id: 'explicit-route-session' }
    emit(session, { type: 'request/header', data: { header: { config: { provider: 'main-provider', model: 'main-model', maxTokens: 9999 } } } })
    emit(session, userEvent('以后所有回复都先给明确结论，再解释判断依据。')); emit(session, { type: 'step/end' })
    const path = join(box.store, '.capture-state.json')
    assert.ok(await waitFor(() => existsSync(path) && JSON.parse(readFileSync(path)).running === false))
    assert.equal(JSON.parse(readFileSync(path)).lastOutcome, 'ok'); assert.equal(llm.calls, 1)
  } finally { box.cleanup() }
})

test('不完整或空白显式路由在注册能力前明确拒绝配置', async () => {
  const box = sandbox()
  try {
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs')
    for (const route of [{ provider: 'one' }, { model: 'one' }, { provider: ' ', model: 'one' }, { provider: 'one', model: 3 }]) {
      const llm = fakeLlm([]), { ctx, captured, handlers } = mount(box, { llm })
      assert.throws(() => apply(ctx, { autoCapture: { ...route } }), /memory-invalid-config/)
      assert.equal(captured.tools.length, 0); assert.equal(captured.context, undefined); assert.equal(handlers.length, 0); assert.equal(llm.calls, 0)
    }
  } finally { box.cleanup() }
})

test('作业接线：旧租约已成为未决时，延迟模型输出不能落库', async () => {
  const box = sandbox()
  try {
    const state = await runCapture(box, (request) => {
      const job = listCaptureJobs(box.store).jobs[0]
      recoverCaptureJobs(box.store, { now: job.expiresAt })
      return groundedPayload(request)
    })
    assert.equal(state.lastOutcome, 'error')
    assert.equal(listCaptureJobs(box.store).jobs[0].status, 'uncertain')
    assert.equal(existsSync(join(storeDirFor('project', box.cwd), 'MEMORY.md')), false)
  } finally { box.cleanup() }
})

test('作业接线：明确放弃未决调用后旧结果不落库，插件重开仍不重发同一快照', async () => {
  const box = sandbox()
  try {
    const first = await runCapture(box, (request) => {
      const job = listCaptureJobs(box.store).jobs[0]
      recoverCaptureJobs(box.store, { now: job.expiresAt })
      const review = abandonCaptureJob(box.store, job.id, { now: job.expiresAt + 1 })
      abandonCaptureJob(box.store, job.id, { apply: true, expectedRevision: review.revision, now: job.expiresAt + 1 })
      return groundedPayload(request)
    })
    assert.equal(first.lastOutcome, 'error')
    assert.equal(listCaptureJobs(box.store).jobs[0].status, 'abandoned')
    assert.equal(existsSync(join(storeDirFor('project', box.cwd), 'MEMORY.md')), false)
    let invoked = false
    const reopened = await runCapture(box, () => { invoked = true; return [] })
    assert.equal(invoked, false); assert.equal(reopened.lastOutcome, 'job-abandoned')
  } finally { box.cleanup() }
})

test('作业接线：损坏账本暂停自动捕获，六工具与主注入保持可用', async () => {
  const box = sandbox()
  try {
    mkdirSync(box.store, { recursive: true }); writeFileSync(join(box.store, '.capture-jobs.json'), '{bad')
    const llm = fakeLlm([])
    const { ctx, handlers, captured } = mount(box, { llm })
    const { applyWithValidationFixture: apply } = await import('./fixture-host.mjs'); prepareMountedFixture(); apply(ctx)
    assert.equal(handlers.filter(([name]) => name === 'session/event').length, 1); assert.equal(llm.calls, 0)
    assert.equal(captured.tools.length, 6); assert.equal(typeof captured.context.text, 'function')
    const marker = JSON.parse(readFileSync(join(box.store, '.loaded.json')))
    assert.equal(marker.autoCapture.enabled, false)
    assert.equal(marker.autoCapture.reason, 'capture-jobs-unavailable')
    assert.equal(readFileSync(join(box.store, '.capture-jobs.json'), 'utf8'), '{bad')
  } finally { box.cleanup() }
})

test('版本检查：延迟抽取不能在用户修改后发布旧候选', async () => {
  const box = sandbox()
  try {
    const state = await runCapture(box, (request) => {
      const project = storeDirFor('project', box.cwd)
      writeFixtureMemory({ type: 'project', dir: project, line: indexLine('project', '最新确认采用冷色方案') })
      return groundedPayload(request)
    })
    const text = readFileSync(join(storeDirFor('project', box.cwd), 'MEMORY.md'), 'utf8')
    assert.match(text, /冷色/)
    assert.doesNotMatch(text, /暖色/)
    assert.equal(state.lastOutcome, 'error')
    assert.equal(state.lastError,'capture-input-source-changed')
  } finally { box.cleanup() }
})

test('版本检查：同一后台批次的两个合法条目不会互相误拒绝', async () => {
  const box = sandbox()
  try {
    const state = await runCapture(box, (request) => [
      ...groundedPayload(request),
      ...groundedPayload(request, { type: 'project', summary: '其余项目的用色另行决定' }),
    ])
    const text = readFileSync(join(storeDirFor('project', box.cwd), 'MEMORY.md'), 'utf8')
    assert.match(text, /暖色/)
    assert.match(text, /另行决定/)
    assert.equal(state.lastOutcome, 'ok')
  } finally { box.cleanup() }
})

test('版本检查：删除记忆后，旧版本令牌不能把它重新加入', () => {
  const box = sandbox()
  try {
    const dir = box.store
    writeFixtureMemory({ type: 'user', dir, line: indexLine('user', '旧的长期偏好采用暖色') })
    const revisionGuard = { value: storeRevision(dir) }
    forgetMemory(dir, '旧的长期偏好采用暖色')
    const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
    assert.throws(() => writeFixtureMemory({ type: 'user', dir, line: indexLine('user', '旧的长期偏好采用暖色'), revisionGuard }), { code: 'capture-stale-revision' })
    assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), before)
  } finally { box.cleanup() }
})
