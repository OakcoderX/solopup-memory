#!/usr/bin/env node
/** L3 next-session comparison on a disposable DSH SDK host per arm. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { DREAM_REVIEW_FIXTURE_SHA256, dreamEvalBatches, dreamEvalRubric } from './dream-review-cases.mjs'
import { dreamTrialProviderPayload } from './dream-review-dsh-transport.mjs'
import { probeEnvironment } from '../scripts/probe-env.mjs'
import { findSecrets, normalizeText, writeSafely } from '../security.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PROFILE = 'dream-return'
const PREFIX = 'solopup-dream-return-'
const KEY = 'synthetic-return-loopback'
const LIMITS = Object.freeze({ calls: 40, inputTokens: 150_000, outputTokens: 25_000 })
const SEED = 241113
const MAX_OUTPUT = 600
const OUTPUT_RESERVATION = 680
const ARMS = Object.freeze(['raw-only', 'old-memory', 'corrected-memory', 'report-only'])
const STALE = '样片正式交付说明默认用中文'
const CORRECTED = '样片正式交付说明默认用英文'
const textHash = value => createHash('sha256').update(value).digest('hex')
const digest = value => textHash(JSON.stringify(value))
const natural = value => Number.isSafeInteger(value) && value >= 0
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeSafely(file, JSON.stringify(value, null, 2) + '\n')
const profile = home => join(home, 'profiles', PROFILE)
const installed = (home, file) => join(profile(home), 'node_modules', 'solopup-memory', file)
const load = (home, file) => import(pathToFileURL(installed(home, file)).href)
const failure = code => Object.assign(Error(`dream-return-${code}`), { code: `dream-return-${code}` })
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

const prompts = [
  ['样片正式交付说明现在默认用什么语言？', '英文。引用后一次明确更正，不用旧中文默认值。'],
  ['周五这一次会议纪要用什么语言？之后默认是什么？', '周五这次用英文。之后仍默认中文。引用限制范围的原话。'],
  ['项目公开简介默认用什么语言？Worker 更新是否覆盖它？', '中文。Worker 摘要没有获得用户批准。引用批准状态与原规则。'],
  ['现在应采用 A 还是 B 外发脚本模板？', '适用批次或覆盖关系未知。引用两份来源并请求确认，不能猜测。'],
  ['新一轮测试记录是否继续用 R 模板？', '旧规则已经到期，新一轮模板未确认。引用时间和用户说明，不默认沿用。'],
]
const rubric = dreamEvalRubric().slice(0, 5)
const questions = dreamEvalBatches().find(batch => batch.id === 'A').input.items.map((item, index) => ({
  id: rubric[index].caseId,
  summary: item.summary,
  prompt: prompts[index][0],
  expected: prompts[index][1],
  sources: item.sources.map((source, sourceIndex) => ({
    label: `原话${sourceIndex + 1}`, quote: source.quote, sourceId: source.id, hash: source.hash,
  })),
  criticalReason: rubric[index].criticalReason,
}))

function shuffledJobs() {
  const jobs = ARMS.flatMap(arm => questions.map(question => ({ arm, questionId: question.id })))
  let state = SEED
  for (let i = jobs.length - 1; i > 0; i--) {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0
    const j = state % (i + 1)
    ;[jobs[i], jobs[j]] = [jobs[j], jobs[i]]
  }
  return jobs
}

export function dreamReturnPlan() {
  return {
    seed: SEED, fixtureSha256: digest({ inherited: DREAM_REVIEW_FIXTURE_SHA256, questions }),
    sourceFixtureSha256: DREAM_REVIEW_FIXTURE_SHA256, limits: LIMITS,
    generationMaxTokens: MAX_OUTPUT, outputTokenReservation: OUTPUT_RESERVATION,
    questionIds: questions.map(row => row.id), jobs: shuffledJobs(),
  }
}

export function dreamReturnRubric() {
  return structuredClone(questions.map(({ id, prompt, expected, criticalReason, sources }) => ({ id, prompt, expected, criticalReason, sources })))
}

/** Human grades must be supplied using blind labels before opening the mapping. */
export function scoreDreamReturn({ receipt, grades }) {
  const plan = dreamReturnPlan()
  if (receipt?.fixtureSha256 !== plan.fixtureSha256 || !Array.isArray(receipt.rows) || receipt.rows.length !== 20 ||
      new Set(receipt.rows.map(row => row.label)).size !== 20 ||
      receipt.rows.some((row, index) => row.arm !== plan.jobs[index].arm || row.questionId !== plan.jobs[index].questionId || row.status !== 'completed')) {
    throw failure('incomplete-receipt')
  }
  const graded = receipt.rows.map(row => {
    const grade = grades?.[row.label]
    if (!grade || ['correctDecision', 'correctScope', 'correctCitation', 'criticalError'].some(key => typeof grade[key] !== 'boolean')) {
      throw failure('incomplete-blind-grades')
    }
    return { ...row, passed: grade.correctDecision && grade.correctScope && grade.correctCitation && !grade.criticalError,
      decisionCorrect: grade.correctDecision, critical: grade.criticalError }
  })
  const summary = Object.fromEntries(ARMS.map(arm => {
    const rows = graded.filter(row => row.arm === arm)
    return [arm, { passed: rows.filter(row => row.passed).length, criticalErrors: rows.filter(row => row.critical).length }]
  }))
  const old = graded.find(row => row.arm === 'old-memory' && row.questionId === 'C01')
  const corrected = graded.find(row => row.arm === 'corrected-memory' && row.questionId === 'C01')
  const improvedOldValue = !old.decisionCorrect && corrected.passed
  const noNewCriticalError = questions.every(question => {
    const oldRow = graded.find(row => row.arm === 'old-memory' && row.questionId === question.id)
    const correctedRow = graded.find(row => row.arm === 'corrected-memory' && row.questionId === question.id)
    return !correctedRow.critical || oldRow.critical
  })
  const negativeControlProjectionMatched = receipt.controls?.reportOnlyProjectionMatched === true
  const semanticTruthEvaluated = receipt.transport === 'real-model'
  return { semanticTruthEvaluated, summary, improvedOldValue, noNewCriticalError, negativeControlProjectionMatched,
    passed: semanticTruthEvaluated && improvedOldValue && noNewCriticalError && negativeControlProjectionMatched }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options })
  if (result.error || result.status !== 0) throw failure('child-failed')
  return result.stdout.trim()
}

async function fixture(base, arm) {
  const home = join(base, 'home'), root = join(home, 'memory'), cwd = join(base, 'project')
  if (!basename(base).startsWith(PREFIX) || process.env.DSH_HOME !== home || realpathSync(tmpdir()) !== join(base, 'tmp') || !ARMS.includes(arm)) {
    throw failure('fixture-home')
  }
  const product = await load(home, 'index.mjs')
  const { scriptedNativeValidationLlm } = await load(home, 'fixture-host.mjs')
  const { candidateSnapshot } = await load(home, 'candidates.mjs')
  const tools = [], handlers = [], effects = []
  const ctx = {
    llm: scriptedNativeValidationLlm(),
    systemPrompt: { context() {} },
    workingDirectory: { get: () => cwd },
    tools: { register: tool => tools.push(tool) },
    on: (name, handler) => handlers.push([name, handler]),
    effect: apply => { const dispose = apply(); if (typeof dispose === 'function') effects.push(dispose) },
  }
  const emit = async (name, ...args) => {
    for (const [event, handler] of handlers) if (event === name) await handler(...args)
  }
  await product.apply(ctx, { autoCapture: { enabled: false } })
  const write = async (id, summary, text, supersedes) => {
    const session = { id }, agent = { session, options: { provider: 'fixture', model: 'fixture' } }
    const data = { id: id + '-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
    const callId = id + '-write'
    const args = { type: 'project', scope: 'project', meaning: { kind: 'decision' }, summary, ...(supersedes && { supersedes }) }
    await emit('agent/pre-step', { agent, turn: 1, step: 1, messages: [data] }, () => {})
    await emit('session/event', session, { type: 'user/message', seq: 1, data })
    await emit('session/event', session, {
      type: 'tool/call', seq: 2, data: { callId, name: 'memory_write', arguments: JSON.stringify(args), turn: 1, step: 1 },
    })
    const result = await tools.find(tool => tool.name === 'memory_write').execute(args, { agent, callId })
    assert.equal(result.status, 'recorded', JSON.stringify(result))
    return result
  }

  try {
    if (arm === 'raw-only') return { empty: true }
    const project = product.storeDirFor('project', cwd)
    for (const question of questions) await write('return-old-' + question.id, question.summary, question.sources[0].quote)
    const indexFile = join(project, 'MEMORY.md')
    const before = textHash(readFileSync(indexFile))
    const old = candidateSnapshot(project, 'project').records.find(record => record.summary === STALE)
    if (!old) throw failure('old-fixture')
    let record
    if (arm === 'corrected-memory') {
      await write('return-owner-confirmation', CORRECTED, questions[0].sources[1].quote, old.indexLine)
      const records = candidateSnapshot(project, 'project').records
      assert.equal(records.find(row => row.id === old.id).status, 'superseded')
      const current = records.find(row => row.summary === CORRECTED)
      assert.equal(current.status, 'recorded')
      assert.equal(current.evidence[0].quote, questions[0].sources[1].quote)
      record = { admitted: true, sourceHash: current.evidence[0].hash }
    } else if (arm === 'report-only') {
      const { buildDreamEvidence, validateDreamReview } = await load(home, 'dream-review.mjs')
      const { openDreamQueue } = await load(home, 'dream-queue.mjs')
      const quote = questions[0].sources[1].quote
      const input = product.readDreamProject(root, cwd, project => buildDreamEvidence({
        ...project, targetIds: [old.id],
        additionalEvidenceByTarget: { [old.id]: [{
          projectId: project.projectId, role: 'user', sourceComplete: true,
          sessionId: 'report-fixture-source', messageId: 'report-fixture-message', text: quote, quote,
          hash: textHash(quote), occurredAt: '2026-11-12T10:00:00.000Z',
        }] },
      }))
      const output = validateDreamReview(input, {
        items: [{ id: 'm1', verdict: 'propose-correction', reason: '原话明确替换交付说明的默认语言。',
          proposedSummary: CORRECTED, sourceIds: ['s1', 's2'] }],
      })
      const queue = openDreamQueue(root)
      try {
        const { runId } = queue.enqueue({
          projectId: input.projectId, inputHash: digest(input), policyVersion: 'return-fixture-v1',
          metadata: { itemIds: [old.id], itemKeys: [old.id] },
        })
        const claim = queue.claim({ owner: 'fixture-report', manual: true, runId })
        assert.ok(queue.beginDispatch(claim, { reservedTokens: 100 }))
        const report = { schema: 1, runId, projectId: input.projectId, mode: 'ordinary',
          inputHash: digest(input), storeRevision: input.storeRevision, items: output.items }
        assert.equal(queue.finish(claim, { status: 'completed', report, reviewedItemKeys: [old.id], usedTokens: 0 }).status, 'completed')
        record = { reportPresent: true, reportSha256: digest(queue.report(runId)) }
      } finally { queue.close() }
      assert.equal(textHash(readFileSync(indexFile)), before)
    }
    return { indexSha256: textHash(readFileSync(indexFile)), ...(record ?? {}) }
  } finally { for (const dispose of effects.reverse()) dispose() }
}

function privatePrior(path, route, { earlier = false } = {}) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 128 * 1024) throw failure('prior-receipt-unsafe')
  const value = json(path)
  if (value?.transportKind !== 'real-model' || value.plan?.fixtureSha256 !== DREAM_REVIEW_FIXTURE_SHA256 ||
      value.route?.provider !== route.provider || value.route.model !== route.model ||
      !Array.isArray(value.jobs) || value.jobs.length !== 4 ||
      new Set(value.jobs.map(row => `${row.mode}:${row.batchId}`)).size !== 4 ||
      typeof value.trialId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.trialId) ||
      value.jobs.some(row => !['ordinary', 'superagent'].includes(row.mode) || !['A', 'B'].includes(row.batchId) ||
        !(earlier ? ['completed', 'failed', 'queued'].includes(row.status) : row.status === 'completed') ||
        (row.status === 'queued' ? row.usage !== undefined || row.reserved !== undefined :
          !Object.keys(LIMITS).every(key => natural(row.usage?.[key])) || row.usage.calls < 1))) throw failure('prior-receipt-incomplete')
  const usage = Object.fromEntries(Object.keys(LIMITS).map(key => [key, value.jobs.reduce((sum, row) => sum + (row.usage?.[key] ?? 0), 0)]))
  if (Object.keys(usage).some(key => usage[key] !== value.totals?.[key] || usage[key] > LIMITS[key]) ||
      value.totals.unknownBatches !== 0 || (earlier && usage.calls === 0)) throw failure('aggregate-budget')
  const candidateSha256 = value.metadata?.candidateSha256
  if (!earlier && !hash(candidateSha256)) throw failure('prior-candidate-unverified')
  return { usage, sha256: textHash(readFileSync(path)), trialId: value.trialId, candidateSha256 }
}

/** Reconcile one measured stopped return attempt against its exact trial inputs. */
export function previousReturnUsage(value, { candidateSha256, route, prior, earlier, totals }) {
  const plan = dreamReturnPlan()
  const expectedEarlier = earlier.map(({ sha256, trialId, usage }) => ({ sha256, trialId, usage }))
  const ordered = rows => [...rows].sort((left, right) => left.sha256.localeCompare(right.sha256))
  if (value?.schema !== 1 || value.status !== 'stopped' || value.transport !== 'real-model' ||
      value.providerThinking !== 'explicit-off' || value.seed !== plan.seed || value.fixtureSha256 !== plan.fixtureSha256 ||
      value.candidateSha256 !== candidateSha256 || value.route?.provider !== route.provider || value.route.model !== route.model ||
      value.priorReceiptSha256 !== prior.sha256 || value.priorTrialId !== prior.trialId ||
      !Array.isArray(value.earlierReceipts ?? []) || (value.earlierReceipts ?? []).some(row => !hash(row?.sha256)) ||
      digest(ordered(value.earlierReceipts ?? [])) !== digest(ordered(expectedEarlier)) ||
      !Array.isArray(value.rows) || value.rows.length !== plan.jobs.length ||
      new Set(value.rows.map(row => row?.label)).size !== plan.jobs.length) throw failure('previous-return-mismatch')
  const usage = Object.fromEntries(Object.keys(LIMITS).map(key => [key, 0]))
  let failed = false
  for (const [index, row] of value.rows.entries()) {
    const expected = plan.jobs[index]
    if (row?.arm !== expected.arm || row.questionId !== expected.questionId || typeof row.label !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(row.label)) throw failure('previous-return-mismatch')
    if (failed) {
      if (row.status !== 'queued' || row.reservation !== undefined || row.usage !== undefined ||
          row.answerSha256 !== undefined) throw failure('previous-return-incomplete')
      continue
    }
    if (!['completed', 'failed'].includes(row.status) || row.usage?.calls !== 1 ||
        !Object.keys(LIMITS).every(key => natural(row.usage[key])) ||
        !hash(row.requestSha256) || (row.status === 'completed' && !hash(row.answerSha256))) throw failure('previous-return-incomplete')
    for (const key of Object.keys(LIMITS)) usage[key] += row.usage[key]
    failed = row.status === 'failed'
  }
  if (!failed || Object.keys(LIMITS).some(key => usage[key] + totals[key] !== value.totals?.[key])) {
    throw failure('previous-return-incomplete')
  }
  return usage
}

function previousReturn(path, binding) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 128 * 1024) {
    throw failure('previous-return-unsafe')
  }
  const raw = readFileSync(path)
  return { sha256: textHash(raw), usage: previousReturnUsage(JSON.parse(raw), binding) }
}

function questionText(question) {
  const raw = question.sources.map(source => `[${source.label}] ${source.quote}`).join('\n')
  return `这是虚构项目的回查测试。按下方原话回答，用方括号标明引用。证据不够就说明还需要确认什么。\n\n${raw}\n\n问题：${question.prompt}`
}

function contextProjection(body) {
  const texts = body.messages.flatMap(row => typeof row.content === 'string' ? [row.content]
    : Array.isArray(row.content) ? row.content.map(block => block.text).filter(Boolean) : [])
  const joined = texts.join('\n')
  const start = joined.indexOf('<memory-store>')
  const end = joined.indexOf('</memory-store>', start)
  if (start < 0) return ''
  if (end < 0) throw failure('malformed-projection')
  return joined.slice(start, end).replace(/^## (global|project).*$/gm, '## $1')
}

async function getRequest(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 512 * 1024) throw failure('wire-too-large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}

function loopbackResponse(model, question) {
  const base = { id: 'chatcmpl-return-fixture', object: 'chat.completion.chunk', created: 1, model }
  const event = (choices, usage) => `data: ${JSON.stringify({ ...base, choices, ...(usage && { usage }) })}\n\n`
  return event([{ index: 0, delta: { role: 'assistant', content: question.expected }, finish_reason: null }]) +
    event([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
    event([], { prompt_tokens: 100, completion_tokens: 30 }) + 'data: [DONE]\n\n'
}

async function gateway({ route, endpoint, apiKey, receipt, save }) {
  let active
  const server = createServer(async (req, res) => {
    const attempt = active
    if (!attempt || req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${KEY}` ||
      attempt.accepted) { res.writeHead(409).end(); return }
    attempt.accepted = true
    const { question, row, arm } = attempt
    try {
      const body = await getRequest(req)
      if (body.model !== route.model || body.stream !== true || !Array.isArray(body.messages)) throw failure('wire-route')
      const marker = questionText(question)
      const userTexts = body.messages.filter(value => value.role === 'user').flatMap(value =>
        typeof value.content === 'string' ? [value.content] : Array.isArray(value.content) ? value.content.map(block => block.text) : [])
      if (userTexts.filter(text => text === marker).length !== 1 ||
          questions.some(other => other.id !== question.id && userTexts.some(text => text === questionText(other)))) throw failure('session-contaminated')
      const projection = contextProjection(body)
      if (arm === 'raw-only' ? projection.length > 0 : !projection.includes(arm === 'corrected-memory' ? CORRECTED : STALE) ||
          projection.includes(arm === 'corrected-memory' ? STALE : CORRECTED)) throw failure('projection-mismatch')
      row.projectionSha256 = digest(projection)
      const { tools: _tools, tool_choice: _choice, ...noTools } = body
      const { payload: wire, providerThinking } = endpoint ? dreamTrialProviderPayload(endpoint, noTools) :
        { payload: { ...noTools, stream_options: { ...body.stream_options, include_usage: true } } }
      if (natural(wire.max_completion_tokens)) wire.max_completion_tokens = Math.min(MAX_OUTPUT, wire.max_completion_tokens)
      else wire.max_tokens = Math.min(MAX_OUTPUT, natural(wire.max_tokens) ? wire.max_tokens : MAX_OUTPUT)
      const raw = JSON.stringify(wire)
      const reservation = { calls: 1, inputTokens: Buffer.byteLength(raw) + 512, outputTokens: OUTPUT_RESERVATION }
      if (Object.keys(LIMITS).some(key => receipt.totals[key] + reservation[key] > LIMITS[key])) throw failure('aggregate-budget')
      row.status = 'dispatch-intent'
      row.reservation = reservation
      row.requestSha256 = textHash(raw)
      if (providerThinking) row.providerThinking = providerThinking
      for (const key of Object.keys(LIMITS)) receipt.totals[key] += reservation[key]
      save()
      const response = endpoint ? await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(55_000),
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: raw,
      }) : new Response(loopbackResponse(route.model, question), { headers: { 'content-type': 'text/event-stream' } })
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        await response.body?.cancel()
        throw failure(response.status === 429 ? 'provider-rate-limit' : 'provider-response')
      }
      const models = new Set()
      let decoded = '', wireBytes = 0, usage, answer = '', stop = false, done = false
      const decoder = new TextDecoder()
      for await (const chunk of response.body) {
        wireBytes += chunk.length
        if (wireBytes > 512 * 1024) throw failure('provider-output-cap')
        decoded += decoder.decode(chunk, { stream: true })
      }
      decoded += decoder.decode()
      for (const line of decoded.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') { done = true; continue }
        const item = JSON.parse(payload)
        if (typeof item.model === 'string') models.add(item.model)
        if (item.usage && natural(item.usage.prompt_tokens) && natural(item.usage.completion_tokens)) {
          usage = { calls: 1, inputTokens: item.usage.prompt_tokens, outputTokens: item.usage.completion_tokens }
        }
        for (const choice of item.choices ?? []) {
          if (choice.delta?.tool_calls?.length || choice.delta?.function_call) throw failure('tool-output')
          if (choice.finish_reason === 'stop') stop = true
          if (typeof choice.delta?.content === 'string') answer += choice.delta.content
        }
      }
      if (usage) {
        row.usage = usage
        for (const key of Object.keys(LIMITS)) receipt.totals[key] += usage[key] - reservation[key]
        save()
      }
      if (!usage || Object.keys(LIMITS).some(key => usage[key] > reservation[key] || receipt.totals[key] > LIMITS[key])) throw failure('usage-unverified')
      if (models.size !== 1 || !models.has(route.model) || !done || !stop || !answer.trim() ||
          Buffer.byteLength(answer) > 12 * 1024 || findSecrets(normalizeText(answer)).length) throw failure('answer-unverified')
      attempt.answer = answer
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(decoded)
    } catch (error) {
      attempt.error = error?.code?.startsWith('dream-return-') ? error.code : 'dream-return-provider-transport'
      if (!res.headersSent) res.writeHead(502)
      res.end()
    }
  })
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    set(job) { active = job },
    close: () => new Promise(done => { server.close(done); server.closeAllConnections() }),
  }
}

function startSdk(base, env, cli) {
  const child = spawn(cli, ['--profile', PROFILE], { env, cwd: join(base, 'project'), stdio: ['pipe', 'pipe', 'ignore'] })
  let id = 0, launchError
  const pending = new Map(), completions = new Map(), answers = new Map()
  const lines = createInterface({ input: child.stdout })
  child.once('error', error => { launchError = error })
  child.stdin.on('error', error => { launchError = error })
  lines.on('line', line => {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.method === 'session.event' && msg.params?.event?.type === 'turn/end') {
      completions.set(msg.params.sessionId, msg.params.event.data?.reason?.kind)
    }
    if (msg.method === 'session.event' && msg.params?.event?.type === 'assistant/message') {
      const data = msg.params.event.data
      if (!data?.interrupted && Array.isArray(data?.message?.content)) {
        answers.set(msg.params.sessionId, data.message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      }
    }
    pending.get(msg.id)?.(msg)
  })
  return {
    pid: child.pid,
    completions,
    answers,
    call(method, params) {
      if (launchError || child.exitCode !== null || child.signalCode !== null) throw failure('host-stopped')
      return new Promise((done, reject) => {
        const callId = ++id
        const timer = setTimeout(() => { pending.delete(callId); reject(failure('host-timeout')) }, 65_000)
        pending.set(callId, reply => {
          clearTimeout(timer)
          pending.delete(callId)
          if (reply.error) reject(failure('host-rpc'))
          else done(reply.result)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) + '\n')
      })
    },
    async close() {
      lines.close()
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      const ended = new Promise(done => child.once('exit', done))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      try { await ended } finally { clearTimeout(timer) }
    },
  }
}

async function runTrial(values) {
  const real = values.real === true
  const route = real ? { provider: values.provider, model: values.model } : { provider: 'dream-return-fixture', model: 'dream-return-fixture' }
  const validRoute = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,95}$/
  if (!Object.values(route).every(value => typeof value === 'string' && validRoute.test(value))) throw failure('route-required')
  let endpoint, apiKey, prior, trialRoot
  const earlier = []
  if (real) {
    apiKey = process.env.SOLOPUP_DREAM_TRIAL_API_KEY
    if (!apiKey || apiKey.length < 8 || apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(apiKey) ||
        !values['prior-receipt'] || !values['base-url']) throw failure('explicit-credential-required')
    endpoint = new URL(values['base-url'].replace(/\/$/, '') + '/chat/completions')
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw failure('endpoint-unsafe')
    const priorPath = realpathSync(values['prior-receipt'])
    trialRoot = dirname(priorPath)
    prior = privatePrior(priorPath, route)
    if (values['earlier-receipt']?.length) {
      if (values['earlier-receipt'].length > 4) throw failure('earlier-receipt-cap')
      if (endpoint.origin !== 'https://api.deepseek.com') throw failure('earlier-receipt-route')
      for (const path of values['earlier-receipt']) {
        const previous = privatePrior(realpathSync(path), route, { earlier: true })
        if ([prior, ...earlier].some(value => value.trialId === previous.trialId || value.sha256 === previous.sha256)) {
          throw failure('duplicate-prior-receipt')
        }
        earlier.push(previous)
      }
    }
  } else if (values['base-url'] || values['prior-receipt'] || values['earlier-receipt'] ||
      values['previous-return-receipt'] || values.provider || values.model) {
    throw failure('unexpected-provider-options')
  }
  const cli = realpathSync(values.cli ?? CLI)
  const archive = realpathSync(values.candidate)
  const candidateSha256 = textHash(readFileSync(archive))
  if (prior && prior.candidateSha256 !== candidateSha256) throw failure('prior-candidate-mismatch')
  const totals = Object.fromEntries(Object.keys(LIMITS).map(key => [key,
    (prior?.usage[key] ?? 0) + earlier.reduce((sum, value) => sum + value.usage[key], 0)]))
  let retry
  if (values['previous-return-receipt']) {
    const path = realpathSync(values['previous-return-receipt'])
    if (endpoint.origin !== 'https://api.deepseek.com' || path !== join(trialRoot, 'return-path', 'receipt.json')) {
      throw failure('previous-return-location')
    }
    retry = previousReturn(path, { candidateSha256, route, prior, earlier, totals })
    for (const key of Object.keys(LIMITS)) totals[key] += retry.usage[key]
  }
  if (totals.calls + 20 > LIMITS.calls || totals.outputTokens + 20 * OUTPUT_RESERVATION > LIMITS.outputTokens ||
      totals.inputTokens >= LIMITS.inputTokens) throw failure('aggregate-budget')
  const root = resolve(values['receipt-dir'])
  if (real && (realpathSync(dirname(root)) !== trialRoot || basename(root) !== (retry ? 'return-path-retest' : 'return-path'))) {
    throw failure('receipt-must-share-trial-directory')
  }
  mkdirSync(root, { mode: 0o700 })
  const blind = join(root, 'blind')
  mkdirSync(blind, { mode: 0o700 })
  writeJson(join(blind, 'rubric.json'), dreamReturnRubric())
  const base = realpathSync(mkdtempSync(join(tmpdir(), PREFIX)))
  const plan = dreamReturnPlan()
  const receipt = {
    schema: 1, seed: plan.seed, fixtureSha256: plan.fixtureSha256, route, transport: real ? 'real-model' : 'scripted',
    candidateSha256, ...(prior && { priorReceiptSha256: prior.sha256, priorTrialId: prior.trialId }),
    ...(earlier.length && { earlierReceipts: earlier.map(({ sha256, trialId, usage }) => ({ sha256, trialId, usage })) }),
    ...(retry && { previousReturnReceipt: retry }),
    ...(endpoint?.origin === 'https://api.deepseek.com' && { providerThinking: 'explicit-off' }),
    totals, generationMaxTokens: MAX_OUTPUT, outputTokenReservation: OUTPUT_RESERVATION,
    rows: plan.jobs.map(job => ({ ...job, label: randomUUID(), status: 'queued' })),
    semanticTruthEvaluated: false, controls: {},
  }
  const save = () => writeJson(join(root, 'receipt.json'), receipt)
  save()
  const hosts = new Map(), fixtures = new Map()
  let proxy
  try {
    proxy = await gateway({ route, endpoint, apiKey, receipt, save })
    for (const arm of ARMS) {
      const folder = join(base, PREFIX + randomUUID())
      const env = { ...probeEnvironment(folder), SOLOPUP_RETURN_LOCAL_KEY: KEY }
      mkdirSync(folder)
      mkdirSync(env.TMPDIR)
      const cwd = join(folder, 'project')
      mkdirSync(cwd)
      writeFileSync(join(cwd, '.dsh-root'), '')
      const dir = profile(env.HOME)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'solopup-return-path', private: true, dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
      }))
      writeFileSync(join(dir, 'cordis.yml'), '[]\n')
      run(cli, ['plugin', '--profile', PROFILE, 'add', archive, '--offline', '--ignore-scripts'], { env })
      const seeded = JSON.parse(run(process.execPath, [SCRIPT, '--fixture', folder, arm], { env }))
      fixtures.set(arm, seeded)
      const patches = [
        { id: 'llm-pi-ai', config: { providers: { [route.provider]: {
          api: 'openai-completions', baseURL: proxy.url, apiKeyEnv: 'SOLOPUP_RETURN_LOCAL_KEY',
          models: [{ id: route.model, contextWindow: 32768, maxTokens: MAX_OUTPUT }],
        } } } },
        { id: 'memory', config: { autoCapture: { enabled: false } } },
      ]
      writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify(patches), { mode: 0o600 })
      const host = startSdk(folder, env, cli)
      hosts.set(arm, host)
      await host.call('initialize', { cwd, ...route, maxTokens: MAX_OUTPUT })
      const stamp = json(join(env.HOME, 'memory', '.loaded.json'))
      if (stamp.pid !== host.pid || stamp.sourceControl?.state !== 'managed' || !stamp.memoryHistory?.available) throw failure('host-not-loaded')
    }
    if (fixtures.get('old-memory').indexSha256 !== fixtures.get('report-only').indexSha256 ||
        !fixtures.get('report-only').reportPresent || !fixtures.get('corrected-memory').admitted) throw failure('fixture-control')
    receipt.controls.reportOnlyIndexMatched = true
    receipt.controls.formalCorrectionAdmitted = true
    for (const row of receipt.rows) {
      const question = questions.find(item => item.id === row.questionId)
      const attempt = { row, arm: row.arm, question }
      proxy.set(attempt)
      const host = hosts.get(row.arm)
      const sessionId = 'fresh-return-' + randomUUID()
      try {
        await host.call('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: questionText(question) }] })
        await host.call('session/wait', { sessionId })
        if (attempt.error) throw Error(attempt.error)
        if (!attempt.answer || !row.usage || host.answers.get(sessionId) !== attempt.answer ||
            !host.completions.has(sessionId) || host.completions.get(sessionId) === 'error') throw failure('host-result')
        writeJson(join(blind, `${row.label}.json`), { label: row.label, questionId: row.questionId, answer: attempt.answer })
        row.answerSha256 = digest(attempt.answer)
        row.status = 'completed'
        save()
      } catch (error) {
        row.status = row.reservation && !row.usage ? 'uncertain' : 'failed'
        row.reason = /^(?:dream-return-)[a-z-]+$/.test(error.message) ? error.message : 'dream-return-failed'
        save()
        throw error
      } finally { proxy.set(undefined) }
    }
    receipt.controls.reportOnlyProjectionMatched = questions.every(question => {
      const old = receipt.rows.find(row => row.arm === 'old-memory' && row.questionId === question.id)
      const report = receipt.rows.find(row => row.arm === 'report-only' && row.questionId === question.id)
      return old.projectionSha256 === report.projectionSha256
    })
    if (!receipt.controls.reportOnlyProjectionMatched) throw failure('negative-control-projection')
    receipt.status = 'awaiting-blind-grades'
    save()
    return { status: receipt.status, transport: receipt.transport, cases: receipt.rows.length, totals: receipt.totals,
      controls: receipt.controls, semanticTruthEvaluated: false }
  } catch (error) {
    receipt.status = 'stopped'
    receipt.reason = /^(?:dream-return-)[a-z-]+$/.test(error.message) ? error.message : 'dream-return-failed'
    save()
    throw error
  } finally {
    await Promise.allSettled([...hosts.values()].map(host => host.close()))
    await proxy?.close()
    rmSync(base, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  try {
    if (args[0] === '--fixture' && args.length === 3) console.log(JSON.stringify(await fixture(args[1], args[2])))
    else {
      const { values } = parseArgs({ args, options: {
        loopback: { type: 'boolean' }, real: { type: 'boolean' }, candidate: { type: 'string' }, cli: { type: 'string' },
        'receipt-dir': { type: 'string' }, 'prior-receipt': { type: 'string' },
        'earlier-receipt': { type: 'string', multiple: true }, 'base-url': { type: 'string' },
        'previous-return-receipt': { type: 'string' },
        provider: { type: 'string' }, model: { type: 'string' }, grades: { type: 'string' }, receipt: { type: 'string' },
      } })
      if (!args.length) console.log(JSON.stringify(dreamReturnPlan(), null, 2))
      else if (values.grades && values.receipt && Object.keys(values).length === 2) {
        console.log(JSON.stringify(scoreDreamReturn({ receipt: json(values.receipt), grades: json(values.grades) }), null, 2))
      } else {
        if (Boolean(values.loopback) === Boolean(values.real) || !values.candidate || !values['receipt-dir']) throw failure('usage')
        console.log(JSON.stringify(await runTrial(values), null, 2))
      }
    }
  } catch (error) {
    console.error(args[0] === '--fixture' ? error.message : /^(?:dream-return-)[a-z-]+$/.test(error.message) ? error.message : 'dream-return-failed')
    process.exitCode = 1
  }
}
