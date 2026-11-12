#!/usr/bin/env node
/** Ordinary DSH dream smoke with a packaged plugin and a loopback model stub. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probeEnvironment } from './probe-env.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PROFILE = 'soak-dream'
const BOOT_IDLE_MS = 1500
const FOREGROUND_IDLE_MS = 3000
const MODEL = 'smoke-fixture'
const PROJECT = 'project-a'
const MEMORY = 'Project Pine uses plain text for reports'
const QUOTE = `Remember: ${MEMORY}.`
const OTHER_MEMORY = 'Other project Cedar keeps separate layout notes'
const PROVIDER = 'solopup-soak-local'
const KEY = 'synthetic-loopback-fixture'
const FOREGROUND_PROMPT = 'Smoke test foreground request marker; reply with a single OK.'
const FOREGROUND_SESSION = 'solopup-dream-smoke-foreground'
const delay = (ms) => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const profileDir = (home) => join(home, 'profiles', PROFILE)
const installed = (home, file) => pathToFileURL(join(profileDir(home), 'node_modules', 'solopup-memory', file)).href

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120_000, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${basename(executable)} ${args[0]} failed (${result.status ?? result.signal}): ${result.stderr.slice(-1800)}`)
  }
  return result.stdout.trim()
}

async function seed(base) {
  const home = join(base, 'home')
  assert.match(basename(base), /^solopup-soak-dream-/)
  assert.equal(process.env.DSH_HOME, home)
  assert.equal(realpathSync(tmpdir()), join(base, 'tmp'))
  const { apply, readDreamProject } = await import(installed(home, 'index.mjs'))
  const { scriptedNativeValidationLlm } = await import(installed(home, 'fixture-host.mjs'))
  const tools = []
  const handlers = []
  const disposers = []
  const ctx = {
    llm: scriptedNativeValidationLlm(),
    systemPrompt: { context() {} },
    workingDirectory: { get: session => join(base, session.id) },
    tools: { register: tool => tools.push(tool) },
    on: (event, callback) => handlers.push([event, callback]),
    effect: callback => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const emit = async (event, ...args) => {
    for (const [name, callback] of handlers) if (event === name) await callback(...args)
  }
  await apply(ctx, { autoCapture: { enabled: false } })
  try {
    for (const [id, summary] of [[PROJECT, MEMORY], ['project-b', OTHER_MEMORY]]) {
      const session = { id }
      const agent = { session, options: { provider: MODEL, model: MODEL } }
      const data = {
        id: id + '-original', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: `Remember: ${summary}.` }],
      }
      const callId = id + '-write'
      const args = { type: 'project', scope: 'project', summary, meaning: { kind: 'decision' } }
      await emit('agent/pre-step', { agent, turn: 1, step: 1, messages: [data] }, () => {})
      await emit('session/event', session, { type: 'user/message', seq: 1, data })
      await emit('session/event', session, {
        type: 'tool/call', seq: 2,
        data: { callId, name: 'memory_write', arguments: JSON.stringify(args), turn: 1, step: 1 },
      })
      const result = await tools.find(tool => tool.name === 'memory_write').execute(args, { agent, callId })
      assert.equal(result.status, 'recorded', JSON.stringify(result))
    }
    const memRoot = join(home, 'memory')
    const result = readDreamProject(memRoot, join(base, PROJECT), current => ({
      projectId: current.projectId,
      recordId: current.records[0].id,
      sourceId: current.records[0].sources[0],
      storeRevision: current.storeRevision,
    }))
    assert.match(result.projectId, /^[a-f0-9]{64}$/)
    return result
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function fingerprint(root) {
  const data = []
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.loaded.json', '.diag.json', '.write.lock'].includes(entry.name)) continue
      const path = join(dir, entry.name)
      const name = prefix + entry.name
      if (entry.isDirectory()) walk(path, name + '/')
      else if (entry.isFile()) data.push([name, hash(readFileSync(path))])
      else throw Error('Unexpected memory path type')
    }
  }
  walk(root)
  return hash(JSON.stringify(data))
}

function startModelStub(idleMs) {
  const requests = []
  const errors = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    const record = { at: Date.now() }
    requests.push(record)
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of req) {
        bytes += chunk.length
        assert.ok(bytes <= 512_000)
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(body.model, MODEL)
      assert.equal(body.stream, true)
      assert.equal(req.headers.authorization, `Bearer ${KEY}`)
      const user = body.messages.filter(message => message.role === 'user')
      assert.ok(body.messages.some(message => ['developer', 'system'].includes(message.role)))
      assert.ok(!JSON.stringify(body).includes(OTHER_MEMORY), 'Unselected project reached the model request')
      const userTexts = user.map(message => typeof message.content === 'string'
        ? message.content : message.content.map(part => part.text).join(''))
      record.requestHash = hash(JSON.stringify(body))
      record.bytes = bytes
      let response
      if (userTexts.some(value => value.includes(FOREGROUND_PROMPT))) {
        record.kind = 'foreground'
        // Hold a real host turn open past the entire idle window.
        await delay(idleMs + 250)
        assert.equal(requests.filter(row => row.kind === 'dream').length, 0, 'Dream ran during a foreground turn')
        response = 'OK'
      } else {
        record.kind = 'dream'
        assert.ok(bytes <= 24_000)
        assert.ok(!body.tools?.length)
        assert.equal(body.messages.length, 2)
        assert.equal(userTexts.length, 1)
        const input = JSON.parse(userTexts[0])
        assert.equal(input.items.length, 1)
        const item = input.items[0]
        assert.equal(item.summary, MEMORY)
        assert.equal(item.sources.length, 1)
        assert.equal(item.sources[0].quote, QUOTE)
        response = JSON.stringify({
          items: [{ id: item.id, verdict: 'keep', sourceIds: [item.sources[0].id], reason: 'The original sentence confirms this report format.' }],
        })
      }
      const base = { id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: MODEL }
      const event = (choices, usage) => `data: ${JSON.stringify({ ...base, choices, ...(usage && { usage }) })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(event([{ index: 0, delta: { role: 'assistant', content: response }, finish_reason: null }]))
      res.write(event([{ index: 0, delta: {}, finish_reason: 'stop' }]))
      res.write(event([], { prompt_tokens: 104, completion_tokens: 32, total_tokens: 136 }))
      res.end('data: [DONE]\n\n')
    } catch (error) {
      errors.push(error.message)
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Invalid fixture request' } }))
    }
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer({
      requests, errors, url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise(resolveClose => {
        server.close(resolveClose)
        server.closeAllConnections()
      }),
    }))
  })
}

function startHost(home, base, env, foreground) {
  const args = foreground ? ['--profile', PROFILE] : ['--profile', PROFILE, '--port', '0', '--no-open']
  const child = spawn(CLI, args, {
    cwd: join(base, PROJECT), env, stdio: [foreground ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  const start = Date.now()
  const marker = join(home, 'memory', '.loaded.json')
  let logs = ''
  let error
  let rpcId = 0
  const events = []
  const pending = new Map()
  child.once('error', failure => { error = failure })
  const log = chunk => { logs = (logs + chunk).slice(-3500) }
  child.stderr.on('data', log)
  if (!foreground) child.stdout.on('data', log)
  if (foreground) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      let response
      try { response = JSON.parse(line) } catch { log(line); return }
      if (response.method === 'session.event' && response.params?.sessionId === FOREGROUND_SESSION &&
          ['turn/start', 'turn/end'].includes(response.params.event?.type)) {
        events.push({ at: Date.now(), type: response.params.event.type, reason: response.params.event.data?.reason })
      }
      const settle = pending.get(response.id)
      if (settle) settle(response)
    })
  }
  function assertRunning() {
    if (error) throw error
    assert.equal(child.exitCode, null, logs)
    assert.equal(child.signalCode, null, logs)
  }
  return {
    start, logs: () => logs, assertRunning, events,
    rpc(method, params) {
      assertRunning()
      return new Promise((resolveResult, reject) => {
        const id = ++rpcId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(Error(`SDK ${method} timed out: ${logs}`))
        }, 15_000)
        pending.set(id, response => {
          pending.delete(id)
          clearTimeout(timer)
          if (response.error) reject(Error(`SDK ${method} failed: ${JSON.stringify(response.error)}`))
          else resolveResult(response.result)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    async marker() {
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline) {
        assertRunning()
        if (existsSync(marker)) {
          let stamp
          try { stamp = JSON.parse(readFileSync(marker, 'utf8')) } catch {}
          if (stamp?.pid === child.pid && typeof stamp.version === 'string') return stamp
        }
        await delay(100)
      }
      throw Error(`DSH did not load the installed plugin: ${logs}`)
    },
    async close() {
      if (error || child.exitCode !== null || child.signalCode !== null) return
      const stopped = new Promise(resolveExit => child.once('exit', resolveExit))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      try { await stopped } finally { clearTimeout(timer) }
    },
  }
}

function candidateTgz(base, supplied) {
  if (supplied) return realpathSync(resolve(supplied))
  const [artifact] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', base], { cwd: ROOT }))
  return join(base, artifact.filename)
}

function install(home, env, tgz, foreground) {
  const dir = profileDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'solopup-soak-dream', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', foreground ? '@deepseek-ai/dsh-sdk-app' : '@deepseek-ai/dsh-web-app'] } },
  }))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  run(CLI, ['plugin', '--profile', PROFILE, 'add', tgz, '--offline', '--ignore-scripts'], { env })
  const metadata = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.ok(metadata.dsh.profile.bundles.includes('solopup-memory'))
  return dir
}

function configure(dir, url, projectPath, enabled, idleMs) {
  const patches = [
    { id: 'llm-pi-ai', config: { providers: { [PROVIDER]: {
      api: 'openai-completions', baseURL: url, apiKeyEnv: 'SOLOPUP_SOAK_DREAM_KEY',
      models: [{ id: MODEL, contextWindow: 32768, maxTokens: 2048 }],
    } } } },
    { id: 'memory', config: {
      autoCapture: { enabled: false },
      dream: { enabled, projects: [projectPath], provider: PROVIDER, model: MODEL, idleMs, timeoutMs: 10_000 },
    } },
  ]
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify(patches, null, 2) + '\n', { mode: 0o600 })
}

export async function soakDream({ tgz, foreground = false } = {}) {
  const idleMs = foreground ? FOREGROUND_IDLE_MS : BOOT_IDLE_MS
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-soak-dream-')))
  const env = { ...probeEnvironment(base), SOLOPUP_SOAK_DREAM_KEY: KEY }
  const home = env.DSH_HOME
  const memoryRoot = join(home, 'memory')
  let stub, host
  const result = {
    kind: 'real-dsh-ordinary-dream-with-synthetic-loopback-provider',
    trigger: foreground ? 'sdk-foreground-turn-end' : 'boot-idle',
    idleMs, passed: false,
  }
  try {
    for (const dir of [home, env.TMPDIR, join(base, PROJECT), join(base, 'project-b')]) mkdirSync(dir, { mode: 0o700 })
    for (const name of [PROJECT, 'project-b']) writeFileSync(join(base, name, '.dsh-root'), '')
    result.hostVersion = run(CLI, ['--version'], { env })
    const artifact = candidateTgz(base, tgz)
    result.archiveSha256 = hash(readFileSync(artifact))
    const profile = install(home, env, artifact, foreground)
    const { VERSION } = await import(installed(home, 'version.mjs'))
    result.pluginVersion = VERSION
    const expected = JSON.parse(run(process.execPath, [SCRIPT, '--seed', base], { env }))
    const before = fingerprint(memoryRoot)

    stub = await startModelStub(idleMs)
    configure(profile, stub.url, join(base, PROJECT), false, idleMs)
    host = startHost(home, base, env, foreground)
    const off = await host.marker()
    assert.equal(off.version, VERSION)
    assert.equal(off.dream?.enabled, false, JSON.stringify(off))
    await delay(idleMs + 250)
    host.assertRunning()
    assert.equal(stub.requests.length, 0)
    assert.equal(existsSync(memoryRoot + '.dream'), false)
    await host.close()
    host = undefined
    result.disabledRequests = 0

    configure(profile, stub.url, join(base, PROJECT), true, idleMs)
    host = startHost(home, base, env, foreground)
    const on = await host.marker()
    assert.equal(on.version, VERSION)
    result.hostNode = on.node
    assert.equal(on.sourceControl?.state, 'managed', JSON.stringify(on))
    assert.deepEqual(on.dream, { enabled: true, mode: 'ordinary' })
    if (foreground) {
      await host.rpc('initialize', { cwd: join(base, PROJECT), provider: PROVIDER, model: MODEL, maxTokens: 256 })
      await host.rpc('session/prompt', {
        sessionId: FOREGROUND_SESSION,
        contentBlocks: [{ type: 'text', text: FOREGROUND_PROMPT }],
      })
      await host.rpc('session/wait', { sessionId: FOREGROUND_SESSION })
      assert.deepEqual(host.events.map(event => event.type), ['turn/start', 'turn/end'])
      assert.notEqual(host.events[1].reason?.kind, 'error')
      assert.equal(stub.requests.filter(request => request.kind === 'foreground').length, 1)
      assert.equal(stub.requests.filter(request => request.kind === 'dream').length, 0)
      assert.ok(host.events[1].at - host.events[0].at >= idleMs, 'Foreground turn did not outlast idle threshold')
    }
    const { openDreamQueue } = await import(installed(home, 'dream-queue.mjs'))
    const queue = openDreamQueue(memoryRoot, { existingOnly: true })
    try {
      const deadline = Date.now() + 18_000
      let reports = []
      while (Date.now() < deadline) {
        host.assertRunning()
        assert.deepEqual(stub.errors, [])
        reports = queue.listReports()
        if (reports.length) break
        assert.ok(!queue.status().active || queue.status().active.status !== 'uncertain', JSON.stringify(queue.status()))
        await delay(100)
      }
      assert.equal(reports.length, 1, `No completed dream: ${JSON.stringify(queue.status())}; host logs: ${host.logs()}`)
      const [row] = reports
      assert.equal(row.projectId, expected.projectId)
      assert.equal(row.mode, 'ordinary')
      const report = queue.report(row.runId)
      assert.equal(report.storeRevision, expected.storeRevision)
      assert.equal(report.items.length, 1)
      assert.equal(report.items[0].id, expected.recordId)
      assert.equal(report.items[0].verdict, 'keep')
      assert.deepEqual(report.items[0].sourceIds, [expected.sourceId])
      assert.ok(!JSON.stringify(report).includes(QUOTE))
      await delay(idleMs + 250)
      const dreamRequests = stub.requests.filter(request => request.kind === 'dream')
      assert.equal(dreamRequests.length, 1)
      assert.equal(stub.requests.length, foreground ? 2 : 1)
      assert.deepEqual(stub.errors, [])
      assert.ok(dreamRequests[0].at >= host.start + idleMs)
      if (foreground) {
        assert.ok(dreamRequests[0].at >= host.events[1].at + idleMs - 100, 'Dream did not wait for post-turn idle')
        result.foreground = {
          observedEvents: host.events.map(event => event.type),
          turnMs: host.events[1].at - host.events[0].at,
          postTurnIdleMs: dreamRequests[0].at - host.events[1].at,
        }
      }
      assert.equal(queue.listReports().length, 1)
      result.request = {
        count: dreamRequests.length, sha256: dreamRequests[0].requestHash, bytes: dreamRequests[0].bytes,
        delaySinceHostStartMs: dreamRequests[0].at - host.start, noTools: true, isolatedProject: true,
      }
      result.report = { runId: row.runId, sha256: hash(JSON.stringify(report)), mode: row.mode, usage: report.usage }
      const operator = fileURLToPath(installed(home, 'scripts/dream-review.mjs'))
      const requested = JSON.parse(run(process.execPath, [operator, 'mode', 'superagent'], { env }))
      assert.equal(requested.status, 'pending')
      let state
      const controlDeadline = Date.now() + 5000
      while (Date.now() < controlDeadline) {
        state = queue.status()
        if (state.executorRequest?.id === requested.id && state.executorRequest.status !== 'pending') break
        await delay(50)
      }
      assert.equal(state.executorRequest?.status, 'rejected', JSON.stringify(state))
      assert.equal(state.mode, 'ordinary')
      assert.equal(state.pendingMode, null)
      assert.equal(state.epoch, 1)
      assert.equal(stub.requests.length, foreground ? 2 : 1)
      result.unavailableSuperAgentSwitch = { status: 'rejected', mode: state.mode, epoch: state.epoch }
    } finally { queue.close() }
    await host.close()
    host = undefined
    const reopened = openDreamQueue(memoryRoot, { existingOnly: true })
    try {
      assert.equal(reopened.listReports().length, 1)
      assert.equal(hash(JSON.stringify(reopened.report(result.report.runId))), result.report.sha256)
      result.report.persistedAfterHostExit = true
    } finally { reopened.close() }
    result.memoryUnchanged = fingerprint(memoryRoot) === before
    assert.equal(result.memoryUnchanged, true)
    result.passed = true
  } catch (error) {
    result.error = error.message
    if (stub?.errors.length) result.fixtureErrors = stub.errors
    if (host?.logs()) result.hostLogTail = host.logs()
  } finally {
    await host?.close()
    await stub?.close()
    rmSync(base, { recursive: true, force: true })
  }
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args.length === 2 && args[0] === '--seed') console.log(JSON.stringify(await seed(args[1])))
  else {
    const foreground = args.includes('--foreground')
    const rest = args.filter(arg => arg !== '--foreground')
    assert.ok(rest.length === 0 || (rest.length === 2 && rest[0] === '--tgz'), 'usage: node scripts/soak-dream.mjs [--foreground] [--tgz file]')
    const result = await soakDream({ tgz: rest[1], foreground })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.passed ? 0 : 1
  }
}
