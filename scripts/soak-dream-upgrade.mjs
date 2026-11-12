#!/usr/bin/env node
/** Isolated archive replacement and backout on the real DSH SDK host. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probeEnvironment } from './probe-env.mjs'

const SCRIPT = fileURLToPath(import.meta.url)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const PROFILE = 'dream-upgrade'
const BASELINE = 'ed4df03b865a1c5742c251815cee780708b119bf55a25f08af5320b1bb666acf'
const OLD = 'Project Moss review reports default to plain text'
const CURRENT = 'Project Moss review reports default to Markdown'
const WITHDRAWN = 'Project Moss discarded summit checklists'
const OTHER = 'Project Birch keeps its own review templates'
const SOURCE_QUOTE = `I explicitly replace the previous format. ${CURRENT}.`
const PROMPT = 'Compatibility probe: reply with OK.'
const PROVIDER = 'solopup-upgrade-local'
const MODEL = 'upgrade-fixture'
const KEY = 'synthetic-upgrade-fixture'
const SESSION = 'solopup-upgrade-linked'
const digest = (value, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(value).digest(encoding)
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const profile = home => join(home, 'profiles', PROFILE)
const installed = (home, file) => join(profile(home), 'node_modules', 'solopup-memory', file)
const load = (home, file) => import(pathToFileURL(installed(home, file)).href)
const json = path => JSON.parse(readFileSync(path, 'utf8'))

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${basename(cmd)} ${args[0]}: ${result.stderr.slice(-1500)}`)
  return result.stdout.trim()
}

function initialLayout(base, env) {
  for (const name of [env.HOME, env.TMPDIR, join(base, 'owner'), join(base, 'other')]) mkdirSync(name, { mode: 0o700 })
  for (const name of ['owner', 'other']) {
    const cwd = join(base, name)
    run('git', ['init', '--quiet'], { cwd, env })
    run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '--quiet', '-m', 'Seed fixture'], { cwd, env })
  }
  run('git', ['worktree', 'add', '--detach', '--quiet', join(base, 'linked')], { cwd: join(base, 'owner'), env })
  const dir = profile(env.HOME)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'solopup-dream-upgrade', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
  }))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
}

function replaceArchive(home, env, tgz, remove = false) {
  if (remove) {
    run(CLI, ['plugin', '--profile', PROFILE, 'remove', 'solopup-memory'], {
      env: { ...env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true' },
    })
    assert.equal(existsSync(installed(home, 'package.json')), false)
  }
  run(CLI, ['plugin', '--profile', PROFILE, 'add', tgz, '--offline', '--ignore-scripts'], { env })
  const config = json(join(profile(home), 'package.json'))
  assert.ok(config.dsh.profile.bundles.includes('solopup-memory'))
  const packageJson = json(installed(home, 'package.json'))
  const archive = readFileSync(tgz)
  const lockText = readFileSync(join(profile(home), 'pnpm-lock.yaml'), 'utf8')
  const integrity = 'sha512-' + digest(archive, 'sha512', 'base64')
  assert.ok(lockText.includes(integrity), 'Installed pnpm lockfile does not bind the archive integrity')
  const entry = spawnSync('tar', ['-xOf', tgz, 'package/index.mjs'], { timeout: 10_000 })
  if (entry.error) throw entry.error
  assert.equal(entry.status, 0, entry.stderr?.toString())
  const entryHash = digest(readFileSync(installed(home, 'index.mjs')))
  assert.equal(entryHash, digest(entry.stdout))
  return { version: packageJson.version, archiveSha256: digest(archive), entrySha256: entryHash, integrity }
}

async function accessFixture(base, seed) {
  const home = join(base, 'home'), root = join(home, 'memory')
  assert.match(basename(base), /^solopup-dream-upgrade-/)
  assert.equal(process.env.DSH_HOME, home)
  assert.equal(realpathSync(tmpdir()), join(base, 'tmp'))
  const product = await load(home, 'index.mjs')
  const { scriptedNativeValidationLlm } = await load(home, 'fixture-host.mjs')
  const { candidateSnapshot } = await load(home, 'candidates.mjs')
  let cwd = join(base, 'owner')
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
    for (const [event, handler] of handlers) if (name === event) await handler(...args)
  }
  await product.apply(ctx, { autoCapture: { enabled: false } })
  const tool = name => tools.find(value => value.name === name)
  async function write(id, summary, source, supersedes) {
    const session = { id }, agent = { session, options: { provider: MODEL, model: MODEL } }
    const data = { id: id + '-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: source }] }
    const callId = id + '-write'
    const args = { type: 'project', scope: 'project', meaning: { kind: 'decision' }, summary, ...(supersedes && { supersedes }) }
    await emit('agent/pre-step', { agent, turn: 1, step: 1, messages: [data] }, () => {})
    await emit('session/event', session, { type: 'user/message', seq: 1, data })
    await emit('session/event', session, {
      type: 'tool/call', seq: 2, data: { callId, name: 'memory_write', arguments: JSON.stringify(args), turn: 1, step: 1 },
    })
    const result = await tool('memory_write').execute(args, { agent, callId })
    assert.equal(result.status, 'recorded', JSON.stringify(result))
  }
  async function search(path, query, view) {
    cwd = path
    const result = await tool('memory_search').execute({ query, mode: 'exact', ...(view && { view }) }, {
      agent: { session: { id: 'synthetic-fresh-search' }, options: { provider: MODEL, model: MODEL } },
    })
    return result.hits
  }
  try {
    const owner = join(base, 'owner'), linked = join(base, 'linked'), other = join(base, 'other')
    const projectStore = product.storeDirFor('project', owner)
    if (seed) {
      await write('seed-older', OLD, `Long-term rule. ${OLD}.`)
      const entry = candidateSnapshot(projectStore, 'project').records.find(row => row.summary === OLD)
      await write('seed-current', CURRENT, SOURCE_QUOTE, entry.indexLine)
      await write('seed-withdrawn', WITHDRAWN, `For this project, ${WITHDRAWN}.`)
      cwd = other
      await write('seed-other', OTHER, `Long-term rule. ${OTHER}.`)
      const withdrawal = product.withdrawManagedSource(projectStore, 'seed-withdrawn', 'seed-withdrawn:1')
      product.withdrawManagedSource(projectStore, 'seed-withdrawn', 'seed-withdrawn:1', {
        apply: true, controlReview: withdrawal.controlReview,
      })
      const link = product.linkProjectWorktree(linked, owner)
      assert.equal(product.linkProjectWorktree(linked, owner, { apply: true, reviewed: link.reviewed }).applied, true)
    }
    assert.equal(product.storeDirFor('project', linked), projectStore)
    const ownerHits = await search(owner, CURRENT)
    const linkedHits = await search(linked, CURRENT)
    assert.equal(ownerHits.length, 1)
    assert.deepEqual(linkedHits, ownerHits)
    assert.equal((await search(owner, OLD)).length, 0)
    assert.equal((await search(other, CURRENT)).length, 0)
    assert.equal((await search(linked, OTHER)).length, 0)
    assert.equal((await search(other, OTHER)).length, 1)
    const currentHistory = await search(linked, CURRENT, 'history')
    const oldHistory = await search(linked, OLD, 'history')
    assert.ok(currentHistory.some(hit => hit.history.sourceSessionId === 'seed-current' && hit.text.includes(SOURCE_QUOTE)))
    assert.ok(oldHistory.some(hit => hit.history.sourceSessionId === 'seed-older'))
    assert.equal((await search(linked, WITHDRAWN)).length, 0)
    assert.equal((await search(linked, WITHDRAWN, 'history')).length, 0)
    const control = product.managedMemoryStatus(root)
    assert.equal(control.registered, true)
    assert.equal(control.operations.length, 1)
    assert.equal(control.operations[0].pending, 0)
    assert.ok(control.operations[0].cleaned >= 1)
    return {
      linked: true, otherProjectIsolated: true, currentFound: true, historicalOldOnly: true,
      sourceQuoteVerified: true, withdrawalCurrentAndHistoryEmpty: true,
      projectId: basename(projectStore).slice(3),
      stateSha256: digest(JSON.stringify([control, ownerHits, currentHistory, oldHistory])),
    }
  } finally { for (const dispose of effects.reverse()) dispose() }
}

function memoryFingerprint(root) {
  const data = []
  function walk(dir, relative = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.loaded.json', '.diag.json', '.write.lock'].includes(entry.name)) continue
      const path = join(dir, entry.name)
      const name = relative + entry.name
      if (entry.isDirectory()) walk(path, name + '/')
      else if (entry.isFile()) data.push([name, digest(readFileSync(path))])
      else throw Error('Unexpected memory entry type')
    }
  }
  walk(root)
  return digest(JSON.stringify(data))
}

function modelStub() {
  let stage
  const requests = [], errors = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
    try {
      const data = []
      let bytes = 0
      for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 512_000); data.push(chunk) }
      const raw = Buffer.concat(data).toString()
      const input = JSON.parse(raw)
      assert.equal(input.model, MODEL)
      assert.equal(req.headers.authorization, `Bearer ${KEY}`)
      let kind, text
      if (raw.includes(PROMPT)) {
        kind = 'foreground'
        assert.ok(raw.includes(CURRENT))
        for (const absent of [OLD, WITHDRAWN, OTHER]) assert.ok(!raw.includes(absent), 'Wrong project or stale memory in live projection')
        text = 'OK'
      } else {
        kind = 'dream'
        assert.equal(stage, 'candidate-enabled')
        assert.equal(input.messages.length, 2)
        assert.ok(!input.tools?.length)
        const body = input.messages.find(row => row.role === 'user').content
        const packet = JSON.parse(typeof body === 'string' ? body : body.map(part => part.text).join(''))
        assert.equal(packet.items.length, 1)
        const [item] = packet.items
        assert.equal(item.summary, CURRENT)
        assert.equal(item.sources[0].quote, SOURCE_QUOTE)
        text = JSON.stringify({ items: [{ id: item.id, verdict: 'keep', sourceIds: [item.sources[0].id], reason: 'Current format is explicitly supported.' }] })
      }
      requests.push({ stage, kind, sha256: digest(raw), bytes })
      const common = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: MODEL }
      const event = (choices, usage) => `data: ${JSON.stringify({ ...common, choices, ...(usage && { usage }) })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(event([{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]))
      res.write(event([{ index: 0, delta: {}, finish_reason: 'stop' }]))
      res.write(event([], { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 }))
      res.end('data: [DONE]\n\n')
    } catch (error) {
      errors.push(error.message)
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":{"message":"Fixture mismatch"}}')
    }
  })
  return new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveServer({
      requests, errors, url: `http://127.0.0.1:${server.address().port}/v1`,
      select(value) { stage = value },
      close: () => new Promise(done => { server.close(done); server.closeAllConnections() }),
    }))
  })
}

async function hostPhase(base, env, stub, name, expectedDream, runCheck) {
  const home = env.HOME
  const before = stub.requests.length
  const enabled = expectedDream === true
  const patches = [
    { id: 'llm-pi-ai', config: { providers: { [PROVIDER]: {
      api: 'openai-completions', baseURL: stub.url, apiKeyEnv: 'SOLOPUP_UPGRADE_FIXTURE_KEY',
      models: [{ id: MODEL, contextWindow: 32768, maxTokens: 2048 }],
    } } } },
    { id: 'memory', config: {
      autoCapture: { enabled: false },
      ...(enabled && { dream: { enabled, projects: [join(base, 'owner')], provider: PROVIDER, model: MODEL, idleMs: 1200, timeoutMs: 8000 } }),
    } },
  ]
  writeFileSync(join(profile(home), 'cordis.patch.yml'), JSON.stringify(patches))
  stub.select(name)
  const child = spawn(CLI, ['--profile', PROFILE], { env, cwd: join(base, 'linked'), stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let rpcId = 0, errors = '', launchError
  child.once('error', error => { launchError = error })
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-1500) })
  lines.on('line', line => {
    try {
      const reply = JSON.parse(line)
      pending.get(reply.id)?.(reply)
    } catch { /* Ignore non-protocol logs. */ }
  })
  const call = (method, params) => new Promise((resolveCall, reject) => {
    const id = ++rpcId
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${name} ${method} timed out: ${errors}`)) }, 10_000)
    pending.set(id, reply => {
      pending.delete(id); clearTimeout(timer)
      if (reply.error) reject(Error(`${name} ${method}: ${JSON.stringify(reply.error)}`))
      else resolveCall(reply.result)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    const marker = join(home, 'memory', '.loaded.json')
    let stamp
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (launchError) throw launchError
      assert.equal(child.exitCode, null, errors)
      try { stamp = json(marker) } catch { /* Marker is not available yet. */ }
      if (stamp?.pid === child.pid && stamp.version && stamp.tools?.length === 6) break
      await delay(60)
    }
    assert.equal(stamp?.pid, child.pid, errors)
    assert.equal(stamp.sourceControl?.state, 'managed')
    assert.equal(stamp.memoryHistory?.available, true)
    assert.equal(stamp.dream?.enabled ?? null, expectedDream)
    await call('initialize', { cwd: join(base, 'linked'), provider: PROVIDER, model: MODEL, maxTokens: 256 })
    const sessionId = SESSION + '-' + name
    await call('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: PROMPT }] })
    await call('session/wait', { sessionId })
    if (runCheck) await runCheck()
    else await delay(1500)
    assert.deepEqual(stub.errors, [])
    const requests = stub.requests.slice(before)
    assert.equal(requests.filter(row => row.kind === 'foreground').length, 1)
    assert.equal(requests.filter(row => row.kind === 'dream').length, enabled ? 1 : 0)
    return { name, node: stamp.node, loadedVersion: stamp.version, dreamEnabled: stamp.dream?.enabled ?? null, requests }
  } finally {
    lines.close()
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(done => child.once('exit', done))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      try { await exited } finally { clearTimeout(timer) }
    }
  }
}

async function soak({ baseline, candidate }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-upgrade-')))
  const env = { ...probeEnvironment(base), SOLOPUP_UPGRADE_FIXTURE_KEY: KEY }
  const root = join(env.HOME, 'memory')
  const result = { kind: 'ordinary-dream-official-archive-upgrade-and-backout', passed: false, actualModelCalls: 0, stages: [] }
  let stub
  try {
    const baselineTgz = realpathSync(resolve(baseline))
    assert.equal(digest(readFileSync(baselineTgz)), BASELINE, 'The baseline must match the published npm archive SHA-256')
    initialLayout(base, env)
    result.hostVersion = run(CLI, ['--version'], { env })
    if (!candidate) {
      const [packed] = JSON.parse(run('npm', [
        'pack', '--ignore-scripts', '--json', '--cache', join(base, 'npm-cache'), '--pack-destination', base,
      ], { cwd: ROOT }))
      candidate = join(base, packed.filename)
    } else candidate = realpathSync(resolve(candidate))
    result.baseline = replaceArchive(env.HOME, env, baselineTgz)
    const seed = JSON.parse(run(process.execPath, [SCRIPT, '--fixture', 'seed', base], { env }))
    const memoryBefore = memoryFingerprint(root)
    const verify = () => {
      assert.equal(memoryFingerprint(root), memoryBefore)
      const verified = JSON.parse(run(process.execPath, [SCRIPT, '--fixture', 'verify', base], { env }))
      assert.deepEqual(verified, seed)
      assert.equal(memoryFingerprint(root), memoryBefore)
      return verified
    }
    stub = await modelStub()
    result.stages.push(await hostPhase(base, env, stub, 'baseline', null))
    verify()
    result.candidate = replaceArchive(env.HOME, env, candidate, true)
    assert.notEqual(result.candidate.archiveSha256, result.baseline.archiveSha256)
    assert.notEqual(result.candidate.entrySha256, result.baseline.entrySha256)
    result.stages.push(await hostPhase(base, env, stub, 'candidate-default', false))
    assert.equal(existsSync(root + '.dream'), false)
    verify()
    const { openDreamQueue } = await load(env.HOME, 'dream-queue.mjs')
    result.stages.push(await hostPhase(base, env, stub, 'candidate-enabled', true, async () => {
      const queue = openDreamQueue(root, { existingOnly: true })
      try {
        const deadline = Date.now() + 10_000
        while (!queue.listReports().length && Date.now() < deadline) await delay(75)
        const reports = queue.listReports()
        assert.equal(reports.length, 1, JSON.stringify(queue.status()))
        const [report] = reports
        assert.equal(report.projectId, seed.projectId)
        const payload = queue.report(report.runId)
        assert.equal(payload.items.length, 1)
        assert.equal(payload.items[0].verdict, 'keep')
        assert.ok(!JSON.stringify(payload).includes(SOURCE_QUOTE))
        result.report = { runId: report.runId, sha256: digest(JSON.stringify(payload)) }
      } finally { queue.close() }
    }))
    verify()
    const queue = openDreamQueue(root, { existingOnly: true })
    try {
      const queued = queue.enqueue({
        projectId: seed.projectId, inputHash: digest('synthetic-compatible-queued-batch'),
        policyVersion: 'synthetic-upgrade-check', metadata: { itemIds: [], itemKeys: [] },
      })
      result.queuedRunId = queued.runId
    } finally { queue.close() }
    const dreamBefore = digest(readFileSync(join(root + '.dream', 'state.sqlite')))
    result.backout = replaceArchive(env.HOME, env, baselineTgz, true)
    assert.deepEqual(result.backout, result.baseline)
    result.stages.push(await hostPhase(base, env, stub, 'backout', null))
    result.preservedMemory = verify()
    assert.equal(digest(readFileSync(join(root + '.dream', 'state.sqlite'))), dreamBefore)
    const reopened = openDreamQueue(root, { existingOnly: true })
    try {
      assert.equal(reopened.listQueued().length, 1)
      assert.equal(reopened.listQueued()[0].runId, result.queuedRunId)
      assert.equal(digest(JSON.stringify(reopened.report(result.report.runId))), result.report.sha256)
      result.reportAndQueuePreserved = true
    } finally { reopened.close() }
    result.memoryBytesSha256 = memoryBefore
    result.dreamStateBytesSha256 = dreamBefore
    result.passed = true
  } catch (error) {
    result.error = error.message
    if (stub?.errors.length) result.fixtureErrors = stub.errors
  } finally {
    await stub?.close()
    rmSync(base, { recursive: true, force: true })
  }
  return result
}

if (process.argv[2] === '--fixture' && process.argv.length === 5) {
  assert.ok(['seed', 'verify'].includes(process.argv[3]))
  console.log(JSON.stringify(await accessFixture(process.argv[4], process.argv[3] === 'seed')))
} else {
  const [flag, baseline, candidateFlag, candidate, ...extra] = process.argv.slice(2)
  assert.ok(flag === '--baseline' && baseline && !extra.length &&
    (candidateFlag === undefined || (candidateFlag === '--candidate' && candidate)),
  'usage: node scripts/soak-dream-upgrade.mjs --baseline /absolute/released.tgz [--candidate /absolute/candidate.tgz]')
  const report = await soak({ baseline, candidate })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.passed ? 0 : 1
}
