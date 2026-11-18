#!/usr/bin/env node
/** Cold continuity acceptance using the installed DSH Desktop host and synthetic workspaces. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { probeEnvironment } from './probe-env.mjs'

const application = '/Applications/DeepSeek Harness.app'
const cli = join(application, 'Contents/Resources/runtime/cli/bin/dsh')
const executable = join(application, 'Contents/MacOS/DeepSeek Harness')
const source = dirname(dirname(fileURLToPath(import.meta.url)))
const prompt = '我还是要改《海盗船长》'
const provider = 'solopup-continuity-fixture'
const model = 'deepseek-flash'
const obsolete = '银帆号被大火烧毁'
const veto = '烧毁银帆号的建议取消。'
const fixtureData = [
  { workspace: '测试工作区甲', title: '安装苏格拉底故事技能', decision: '铜铃引航', draft: '明确采用铜铃引航的结尾，保留雾中归港。' },
  { workspace: '测试工作区乙', title: '周末工具盘点', decision: '白鹭送信', draft: '明确采用白鹭送信的结尾，保留灯塔守夜。' },
]
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = value => createHash('sha256').update(value).digest('hex')
const redact = text => String(text)
  .replace(/([?&](?:token|key|access_token)=)[^\s&"'<>]+/giu, '$1[redacted]')
  .replace(/(authorization:\s*bearer\s+)\S+/giu, '$1[redacted]')
const args = process.argv.slice(2)
const gui = args.includes('--gui')
const desktopWeb = args.includes('--desktop-web')
const interactive = gui || desktopWeb
assert.ok(!gui || !desktopWeb, 'Choose one interactive test surface')
const live = args.includes('--live-key-stdin')
const packageArg = args.findIndex(arg => arg === '--tgz')
const reportArg = args.findIndex(arg => arg === '--report')
assert.ok(reportArg >= 0 && args[reportArg + 1], 'Usage: probe-desktop-continuity.mjs --report FILE [--tgz FILE] [--gui | --desktop-web] [--live-key-stdin]')
const reportFile = resolve(args[reportArg + 1])
const upstreamKey = live ? readFileSync(0, 'utf8').trim() : undefined
if (live) assert.ok(upstreamKey?.length >= 12 && !/\s/.test(upstreamKey), 'DeepSeek credential unavailable on stdin')
const base = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-desktop-continuity-')))
const env = { ...probeEnvironment(base), SOLOPUP_CONTINUITY_FIXTURE_KEY: 'fixture-only' }
const home = env.DSH_HOME
const fixtureRows = fixtureData.map(fixture => ({
  ...fixture, cwd: join(base, fixture.workspace), id: 'session-' + randomUUID(),
}))
const report = {
  passed: false,
  frontend: gui ? 'native Electron desktop' : desktopWeb ? 'Desktop Electron host built-in web UI' : 'SDK via installed Desktop Electron',
  model: live ? 'DeepSeek Flash' : 'deterministic provider',
  synthetic: true, isolatedHome: true, prompt, seed: [], providerRequests: [], runs: [],
}
let host
let server

function command(file, argv, cwd = base) {
  const result = spawnSync(file, argv, { cwd, env, encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0) throw Error(file.split('/').at(-1) + ' ' + argv[0] + ' failed: ' + (result.error?.message ?? result.stderr).slice(-1300))
  return result.stdout.trim()
}

function profile(name, bundles, patch) {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name, private: true, dsh: { profile: { bundles } }, dependencies: {},
  }))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify(patch))
}

function launch(file, argv, environment = env) {
  const child = spawn(file, argv, { cwd: base, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let sequence = 0
  let logs = ''
  const events = []
  child.stderr.on('data', chunk => { logs = (logs + '\n' + chunk).slice(-2400) })
  child.once('error', error => { logs = (logs + '\n' + error.message).slice(-2400) })
  createInterface({ input: child.stdout }).on('line', line => {
    let row
    try { row = JSON.parse(line) } catch { logs = (logs + '\n' + line).slice(-2400); return }
    if (row.method === 'session.event') events.push(row.params)
    pending.get(row.id)?.(row)
  })
  child.stdin.on('error', () => {})
  return {
    child, events, logs: () => logs,
    rpc(method, params) {
      return new Promise((resolveRpc, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Error(method + ' timeout: ' + logs))
        }, 48_000)
        pending.set(id, row => {
          pending.delete(id)
          clearTimeout(timer)
          if (row.error) reject(Error(method + ': ' + JSON.stringify(row.error)))
          else resolveRpc(row.result)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
      const stopped = new Promise(done => child.once('exit', done))
      child.kill()
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      try { await stopped } finally { clearTimeout(timer) }
    },
  }
}

async function until(read, ms) {
  const expires = Date.now() + ms
  while (Date.now() < expires) {
    const value = read()
    if (value) return value
    if (host?.child.exitCode !== null) throw Error('host exited: ' + host?.logs())
    await sleep(200)
  }
  throw Error('Timed out waiting for DSH evidence: ' + (host?.logs() ?? 'startup'))
}

const baseBundle = '@deepseek-ai/dsh-base'
const webBundle = '@deepseek-ai/dsh-web-app'
const sdkBundle = '@deepseek-ai/dsh-sdk-app'
const pluginName = 'solopup-memory'
const marker = join(home, 'memory', '.loaded.json')

async function seed() {
  const driver = join(base, 'seed.mjs')
  const receipt = join(base, 'seed.json')
  writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
export const name = 'solopup-continuity-fixture-seed'
export const inject = ['sessions', 'sessionTitle', 'sessionQuery', 'sessionPersistence', 'workspaceRegistry']
export async function apply(ctx) {
  const rows = ${JSON.stringify(fixtureRows)}
  const receipt = []
  const append = (session, role, text) => {
    const message = {
      id: role + '-' + session.seq, role,
      source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: '${provider}', model: '${model}' },
      content: [{ type: 'text', text }],
    }
    session.append(role + '/message', role === 'user' ? message : { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' })
  }
  try {
    for (const row of rows) {
      await ctx.workspaceRegistry.create(row.cwd, row.workspace)
      const session = ctx.sessions.create(row.id, { meta: { cwd: row.cwd } })
      ctx.sessionTitle.rename(session, row.title)
      append(session, 'user', '今天先谈谈《海盗船长》的结尾。')
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      append(session, 'assistant', '有个备选：${obsolete}。')
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      append(session, 'user', '我确认《海盗船长》：' + row.draft + ' ${veto}')
      const view = await ctx.sessionQuery.observeSession(row.id, { projectionMode: 'none' })
      try {
        if (await ctx.sessionPersistence.stat(row.id)) await ctx.sessions.flush(session)
        else {
          const writer = await ctx.sessionPersistence.create(view.header)
          try { await writer.append(view.events); await writer.flush() } finally { await writer.close() }
        }
        const saved = await ctx.sessionPersistence.stat(row.id)
        receipt.push({ id: row.id, cwd: row.cwd, title: row.title, savedBytes: saved.sizeBytes,
          events: view.events.map(event => ({ type: event.type, seq: event.seq })) })
      } finally { view[Symbol.dispose]() }
    }
    writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ rows: receipt }))
  } catch (error) { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ error: error.stack })) }
}
`)
  profile('continuity-seed', [baseBundle, webBundle], [{ insert: [{ id: 'fixture-seed', name: driver }] }])
  host = launch(cli, ['--profile', 'continuity-seed', '--port', '0', '--no-open'])
  const seeded = await until(() => existsSync(receipt) && json(receipt), 30_000)
  assert.equal(seeded.error, undefined)
  report.seed = seeded.rows
  assert.equal(report.seed.length, 2)
  await host.close()
  host = undefined
  assert.ok(!existsSync(join(home, 'memory')), 'seed unexpectedly wrote memory')
}

function requestInfo(body) {
  const raw = JSON.stringify(body.messages)
  const latest = body.messages.findLast(message => message.role === 'user' &&
    (message.content === prompt || Array.isArray(message.content) && message.content.some(block => block.text === prompt)))
  return { raw, latest, names: (body.tools ?? []).map(tool => tool.function?.name) }
}

function sse(response, result) {
  const choice = result.choices[0]
  const baseChunk = { id: result.id ?? 'fixture-1', object: 'chat.completion.chunk', created: 1, model }
  const event = (choices, usage) => 'data: ' + JSON.stringify({ ...baseChunk, choices, ...(usage && { usage }) }) + '\n\n'
  const delta = { ...choice.message }
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }))
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(event([{ index: 0, delta, finish_reason: null }]) +
    event([{ index: 0, delta: {}, finish_reason: choice.finish_reason }]) +
    event([], result.usage) + 'data: [DONE]\n\n')
}

async function startProvider() {
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const { latest, raw, names } = requestInfo(body)
      if (!latest) {
        sse(response, { choices: [{ message: { role: 'assistant', content: '接续验收' }, finish_reason: 'stop' }] })
        return
      }
      assert.equal(body.model, model)
      const sources = fixtureRows.filter(row => raw.includes(row.id) && raw.includes(row.decision))
      const requestReceipt = {
        presentSources: sources.map(row => row.id), decisionsInContext: fixtureRows.filter(row => raw.includes(row.decision)).map(row => row.decision),
        priorAssistantSuggestion: raw.includes(obsolete), subsequentUserVeto: raw.includes(veto),
        suppliedToolNames: names.filter(name => /^(memory|session)_/.test(name)), requestBytes: Buffer.byteLength(raw), requestSha256: hash(raw),
      }
      report.providerRequests.push(requestReceipt)
      assert.ok(report.providerRequests.length <= 6, 'synthetic request cap exceeded')
      if (!live) {
        const content = sources.length === 1
          ? '已确认：' + sources[0].draft + ' 助手曾提出烧船方案，用户随后取消。来源：《' + sources[0].title + '》（' + sources[0].id + '）。'
          : '没有找到可以核实的同工作区改稿决定。'
        sse(response, { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] })
        return
      }
      assert.ok(requestReceipt.requestBytes <= 60_000, 'synthetic request size cap exceeded')
      const result = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(26_000),
        headers: { authorization: 'Bearer ' + upstreamKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, messages: body.messages, temperature: 0, max_tokens: 750,
          thinking: { type: 'disabled' }, ...(body.tools?.length && { tools: body.tools }),
        }),
      })
      requestReceipt.upstreamStatus = result.status
      if (!result.ok) { await result.body?.cancel(); throw Error('provider-http-' + result.status) }
      const payload = await result.json()
      requestReceipt.usage = payload.usage
      sse(response, payload)
    } catch (error) {
      report.providerError = redact(error.message)
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  return 'http://127.0.0.1:' + server.address().port + '/v1'
}

function makePatch(url) {
  return [
    { id: 'agent-default-model', config: { provider, model } },
    { id: 'llm-pi-ai', config: { providers: { [provider]: {
      api: 'openai-completions', baseURL: url, apiKeyEnv: 'SOLOPUP_CONTINUITY_FIXTURE_KEY',
      models: [{ id: model, name: 'DeepSeek Flash（接续验收）', contextWindow: 64_000, maxTokens: 750 }],
    } } } },
    { id: 'memory', config: { autoCapture: { enabled: false }, dream: { enabled: false } } },
  ]
}

function diagnosticPatch() {
  const driver = join(base, 'cold-check.mjs')
  const result = join(base, 'cold-check.json')
  writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
export const name = 'solopup-continuity-cold-check'
export const inject = ['sessionQuery', 'sessionPersistence']
export async function apply(ctx) {
  const results = []
  for (const id of ${JSON.stringify(fixtureRows.map(row => row.id))}) {
    try {
      const stat = await ctx.sessionPersistence.stat(id)
      const inspected = await ctx.sessionQuery.inspectSession(id, view => ({
        header: view.header, seq: view.seq, inherited: view.inheritedEventCount,
        types: Array.from({ length: view.seq }, (_, seq) => view.eventAt(seq).type),
      }))
      results.push({ stat, inspected })
    } catch (error) { results.push({ id, error: error.stack }) }
  }
  writeFileSync(${JSON.stringify(result)}, JSON.stringify(results))
}
`)
  return { insert: [{ id: 'cold-check', name: driver }] }
}

function storedSessions(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    const path = join(dir, item.name)
    if (item.isDirectory()) return storedSessions(path)
    if (!/^session\.v4\.jsonl(?:\.zstd)?$/.test(item.name)) return []
    const raw = path.endsWith('.zstd') ? spawnSync('zstd', ['-qdc', path], { encoding: 'utf8' }).stdout : readFileSync(path, 'utf8')
    return [{ id: dirname(path).split('/').at(-1), events: raw.trim().split('\n').flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    }) }]
  })
}

function contentOf(event) {
  return (event.data?.content ?? event.data?.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function acceptRun(id, events, expected, excluded) {
  const response = events.filter(event => event.type === 'assistant/message').map(contentOf).filter(Boolean).at(-1)
  const serialized = JSON.stringify(events)
  const toolCalls = events.filter(event => event.type === 'tool/call').map(event => ({ seq: event.seq, tool: event.data.name, arguments: event.data.arguments }))
  const contexts = events.filter(event => event.type === 'user/message' || event.type === 'system/message')
    .flatMap(event => (event.data.source?.sections ?? event.data.message?.source?.sections ?? [])
      .filter(row => row.name?.includes('continu')).map(row => ({ seq: event.seq, name: row.name, text: row.text })))
  const end = events.findLast(event => event.type === 'turn/end')
  const actual = { id, workspace: expected.workspace, expectedSource: expected.id, contexts, toolCalls, response, end: end?.data?.reason }
  report.runs.push(actual)
  assert.ok(response, 'DSH did not deliver the final assistant text')
  assert.equal(end?.data?.reason?.kind === 'error', false)
  assert.ok(response.includes(expected.decision), 'confirmed decision missing in final answer')
  assert.ok(response.includes(expected.title) || response.includes(expected.id), 'source missing in final answer')
  assert.ok(!serialized.includes(excluded.id) && !serialized.includes(excluded.decision), 'foreign workspace evidence leaked')
  assert.ok(!response.includes(obsolete) || /弃|取消|推翻|否决|未采|作废|不采|不用|不再|非现行|撤销/.test(response), 'superseded suggestion was repeated without marking its status')
  assert.ok(report.providerRequests.some(request => request.presentSources.includes(expected.id) &&
    request.priorAssistantSuggestion && request.subsequentUserVeto), 'old source, original suggestion or later veto did not reach provider')
  assert.ok(report.providerRequests.every(request => request.presentSources.length <= 1 && request.decisionsInContext.length <= 1), 'provider cross-workspace contamination')
}

try {
  mkdirSync(env.TMPDIR)
  for (const fixture of fixtureRows) {
    mkdirSync(fixture.cwd)
    writeFileSync(join(fixture.cwd, '.dsh-root'), '')
  }
  report.hostVersion = command('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', join(application, 'Contents/Info.plist')])
  await seed()
  const url = await startProvider()
  const active = gui ? 'desktop' : 'continuity-acceptance'
  profile(active, [baseBundle, interactive ? webBundle : sdkBundle],
    [...makePatch(url), ...(args.includes('--diagnose') ? [diagnosticPatch()] : [])])
  const archive = packageArg >= 0 ? realpathSync(args[packageArg + 1]) :
    join(base, JSON.parse(command('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', base], source))[0].filename)
  report.archiveSha256 = hash(readFileSync(archive))
  command(cli, ['plugin', '--profile', active, 'add', archive, '--offline', '--ignore-scripts'])
  const profilePath = join(home, 'profiles', active, 'package.json')
  assert.ok(json(profilePath).dsh.profile.bundles.includes(pluginName))

  if (gui) {
    const guiEnv = { ...env, CFFIXED_USER_HOME: env.HOME, DSH_DESKTOP_DIAGNOSTIC_FILE: join(base, 'desktop-fatal.log') }
    delete guiEnv.ELECTRON_RUN_AS_NODE
    host = launch(executable, ['--user-data-dir=' + join(base, 'electron')], guiEnv)
  } else if (desktopWeb) {
    host = launch(cli, ['--profile', active, '--port', '0', '--no-open'])
  } else {
    host = launch(cli, ['--profile', active])
  }
  report.plugin = await until(() => {
    if (!existsSync(marker)) return undefined
    const stamp = json(marker)
    return Array.isArray(stamp.tools) && stamp
  }, 45_000)
  assert.ok(report.plugin.tools.includes('memory_continue'), 'candidate continuity tool missing')
  if (interactive) {
    const url = desktopWeb ? await until(() => /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)$/mu.exec(host.logs())?.[1], 20_000) : undefined
    console.log(JSON.stringify({ phase: 'gui-ready', pid: host.child.pid, workspaces: fixtureRows.map(row => row.cwd), prompt, url }))
    const sessions = await until(() => {
      const completed = storedSessions(join(home, 'sessions')).filter(row =>
        row.events.some(event => event.type === 'user/message' && contentOf(event) === prompt) &&
        row.events.some(event => event.type === 'turn/end'))
      return completed.length >= 2 && completed
    }, 240_000)
    for (const expected of fixtureRows) {
      const session = sessions.find(row => JSON.stringify(row.events[0]).includes(expected.cwd))
      assert.ok(session, 'missing completed GUI session in ' + expected.workspace)
      acceptRun(session.id, session.events, expected, fixtureRows.find(row => row !== expected))
    }
  } else {
    for (const expected of fixtureRows) {
      await host.rpc('initialize', { cwd: expected.cwd, provider, model, maxTokens: 750 })
      const id = 'session-' + randomUUID()
      await host.rpc('session/prompt', { sessionId: id, contentBlocks: [{ type: 'text', text: prompt }] })
      await host.rpc('session/wait', { sessionId: id })
      acceptRun(id, host.events.filter(row => row.sessionId === id).map(row => row.event), expected, fixtureRows.find(row => row !== expected))
    }
  }
  const audit = readFileSync(join(home, 'memory', '.audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok(!audit.some(row => row.op === 'write' || row.op === 'capture-candidate'), 'test committed or staged memory')
  for (const run of report.runs) {
    assert.ok(audit.some(row => row.op === 'continuity' && row.via === 'pre-step' && row.sessionId === run.id &&
      row.projectStatus === 'no-match' && row.projectHits === 0 && row.sources?.some(item => item.sessionId === run.expectedSource)),
    'project-first zero-hit fallback missing from persisted audit')
  }
  report.passed = true
} catch (error) {
  report.error = redact(error.message)
  process.exitCode = 1
} finally {
  if (host) await host.close()
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  const auditPath = join(home, 'memory', '.audit.jsonl')
  const coldPath = join(base, 'cold-check.json')
  if (existsSync(coldPath)) report.coldDiagnostic = json(coldPath)
  if (existsSync(auditPath)) {
    report.audit = readFileSync(auditPath, 'utf8').trim().split('\n').map(row => JSON.parse(row))
      .filter(row => ['continuity', 'write', 'capture', 'capture-candidate'].includes(row.op))
  }
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
  rmSync(base, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: report.passed, error: report.error, report: reportFile }))
}
