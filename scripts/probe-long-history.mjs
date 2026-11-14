#!/usr/bin/env node
/** Compare the published baseline and candidate with the real DSH history and compaction services. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probeEnvironment } from './probe-env.mjs'

const DEFAULT_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const BASELINE = '0.24.0-beta.2'
const BASELINE_HASH = '869c0d879a738056c5cd8557ed7e54e69950b781124d1ba2301a12942211499f'
const SIZE_CAP = 256 * 1024
const PROJECT = '雾港来信'
const OUTLINE = '第七章沿用 V1'
const ORIGINAL = '更正「第七章沿用 V1」：只在第七章采用 V2，结尾照旧。'
const SUMMARY = '当前改用 V3。'
const FILLER = '船厂的排风扇抖了一下。林沅沿着没有灯的路朝雾里走。'
const digest = value => createHash('sha256').update(value).digest('hex')
const text = value => [{ type: 'text', text: value }]
const sleep = ms => new Promise(r => setTimeout(r, ms))
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const projectPath = root => join(root, PROJECT)
const projectId = root => digest(projectPath(root))
const targetId = digest(OUTLINE)
const fixturePath = root => join(root, 'fixtures.json')
const indexPath = root => join(root, 'evidence-index')
const load = (packageDir, name) => import(pathToFileURL(join(packageDir, name)).href)
const ownerInput = (id, body) => ({ id, role: 'user', source: { kind: 'user' }, content: text(body) })

function append(session, name, body) {
  return session.append('user/message', ownerInput(name, body), { surfaceOp: 'append' })
}

async function preflight(ctx, id, { signal } = {}) {
  const live = ctx.sessions.get(id)
  if (live) return { source: 'live', header: live.header, cursor: live.seq - 1 }
  const saved = await ctx.sessionPersistence.stat(id, { signal })
  return saved && { source: 'prepared', header: saved.header, revision: saved.revision, sizeBytes: saved.sizeBytes }
}

function observer(ctx) {
  const opened = []
  const query = {
    observeSession(id, options) {
      opened.push(id)
      return ctx.sessionQuery.observeSession(id, options)
    },
  }
  return { opened, query }
}

function collector({ readDreamTranscripts, ctx, root, observer, index }) {
  return async (pointer, options) => {
    const value = await readDreamTranscripts({
      query: observer.query,
      projectId: projectId(root),
      resolveProjectId: cwd => cwd === projectPath(root) ? projectId(root) : undefined,
      preflightSession: (id, opts) => preflight(ctx, id, opts),
      ...(index && { readIndexedSession: (id, observed) => index.read(id, observed) }),
      pointersByTarget: { [targetId]: [pointer] },
      ...options,
    })
    assert.equal(value.additionalEvidenceByTarget[targetId].length, 1)
    assert.equal(value.skips.length <= 1, true)
    return { quote: value.additionalEvidenceByTarget[targetId][0]?.quote, reason: value.skips[0]?.reason }
  }
}

function expectQuote(result) {
  assert.deepEqual(result, { quote: ORIGINAL, reason: undefined })
  return 'verified'
}

function expectSkip(result, reason) {
  assert.deepEqual(result, { quote: undefined, reason })
  return reason
}

async function runCompaction(ctx, session, rounds) {
  const engine = ctx.compaction
  const summarize = engine.summarize
  const signal = new AbortController().signal
  let result
  try {
    engine.summarize = async () => ({
      summary: text(SUMMARY), provider: 'fixture', model: 'deterministic-compaction',
    })
    for (let i = 0; i < rounds; i++) {
      append(session, `additional-material-${i}`, FILLER.repeat(100))
      append(session, `keep-recent-${i}`, '继续写下一节。')
      await new Promise(r => setImmediate(r))
      const oldCheckpoint = result && result.summarySeq + 1
      result = await engine.compactNow({ session, runMaintenance: run => run(signal) }, signal)
      assert.ok(result, 'Real DSH must compact the selected fixture')
      if (oldCheckpoint !== undefined) assert.ok(result.shadowedSeqs.includes(oldCheckpoint))
    }
  } finally { engine.summarize = summarize }
  return result
}

function oversizedText() {
  return Array.from({ length: 9000 }, (_, i) => digest(`long-history-fixture-${i}`)).join('\n')
}

async function saveFixture(ctx, session) {
  // Feed the real persistence service a complete event log. This profile has no model sessions.
  const view = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
  try {
    const saved = await ctx.sessionPersistence.stat(session.id)
    if (saved) {
      await ctx.sessions.flush(session)
    } else {
      const writer = await ctx.sessionPersistence.create(view.header)
      try { await writer.append(view.events); await writer.flush() } finally { await writer.close() }
    }
    const stat = await ctx.sessionPersistence.stat(session.id)
    assert.ok(stat)
    return stat
  } finally { view[Symbol.dispose]() }
}

async function seed(ctx, modules, root, baseline) {
  const { observeDreamCorrection, readDreamTranscripts, captureMessage, index } = modules
  const observerState = observer(ctx)
  const collect = collector({ readDreamTranscripts, ctx, root, observer: observerState, index })
  const cwd = projectPath(root)
  mkdirSync(cwd)
  const choices = [
    { name: 'uncompressed' },
    { name: 'once', rounds: 1 },
    { name: 'twice', rounds: 2 },
    { name: 'actually-replaced', replacement: true, rounds: 1 },
    { name: 'long-inline', long: true },
    { name: 'oversized-indexed', oversized: true, long: true, indexed: true },
    { name: 'oversized-unindexed', oversized: true },
    { name: 'other-workspace', other: true, rounds: 1 },
  ]
  const fixtures = []
  for (const choice of choices) {
    const session = ctx.sessions.create(`solopup-case-${choice.name}`, { meta: { cwd } })
    if (choice.other) {
      const other = join(root, '另一个项目')
      if (!existsSync(other)) mkdirSync(other)
      session.append('working-directory/change', { cwd: other })
    }
    const original = append(session, 'owner-correction', choice.long ? `${FILLER.repeat(140)}\n\n${ORIGINAL}` : ORIGINAL)
    const observed = observeDreamCorrection(session, original)
    if (choice.long && baseline) assert.equal(observed, undefined)
    else assert.equal(observed?.targetSummary, OUTLINE)
    const pointer = observed?.pointer ?? {
      sessionId: session.id, createdAt: session.header.createdAt, seq: original.seq, hash: digest(ORIGINAL),
    }
    if (choice.oversized) append(session, 'historical-material', oversizedText())
    if (choice.replacement) session.append('user/message', ownerInput('edit', '明确取消先前的更正。'), {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    })
    await new Promise(r => setImmediate(r))
    if (!choice.replacement && !choice.other && !choice.oversized && !(choice.long && baseline)) {
      expectQuote(await collect(pointer))
    }
    if (choice.rounds) {
      const result = await runCompaction(ctx, session, choice.rounds)
      const view = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' })
      try {
        assert.equal(view.events[original.seq].data.content[0].text, ORIGINAL)
        const checkpoint = view.events[result.summarySeq + 1]
        assert.equal(captureMessage(checkpoint, 'checkpoint'), undefined)
        assert.ok(!session.surface.nodes.includes(original.seq))
      } finally { view[Symbol.dispose]() }
    }
    const stat = await saveFixture(ctx, session)
    assert.equal(stat.sizeBytes > SIZE_CAP, Boolean(choice.oversized))
    if (choice.indexed && !baseline) assert.equal(index.save(session, [pointer], stat.revision), true)
    fixtures.push({ ...choice, pointer, bytes: stat.sizeBytes, revision: stat.revision, nextSeq: session.seq })
  }
  writeFileSync(fixturePath(root), JSON.stringify(fixtures))
  return { phase: 'seed', cases: fixtures.length }
}

async function verify(ctx, modules, root, baseline) {
  const observerState = observer(ctx)
  const collect = collector({ ...modules, ctx, root, observer: observerState })
  const fixtures = json(fixturePath(root))
  const results = []
  for (const choice of fixtures) {
    const { name, pointer, bytes } = choice
    const live = ctx.sessions.get(pointer.sessionId)
    assert.equal(live, undefined, 'Reopened host must see the fixture only in persistence')
    const before = observerState.opened.length
    const result = await collect(pointer)
    let outcome
    if (choice.other) outcome = expectSkip(result, 'workspace-mismatch')
    else if (choice.replacement || baseline && choice.rounds) outcome = expectSkip(result, 'source-replaced')
    else if (choice.oversized && (baseline || !choice.indexed)) outcome = expectSkip(result, 'stored-size-cap')
    else if (choice.long && baseline) outcome = expectSkip(result, 'source-unusable')
    else outcome = expectQuote(result)
    const openedThroughQuery = observerState.opened.length - before
    assert.equal(openedThroughQuery, choice.oversized ? 0 : 1)
    assert.equal(ctx.sessions.get(pointer.sessionId), undefined)
    results.push({ name, savedBytes: bytes, readCalls: openedThroughQuery, outcome })
  }

  const current = fixtures.find(choice => choice.name === (baseline ? 'uncompressed' : 'twice'))
  const withdrawn = await collect(current.pointer, {
    withdrawnSourceIds: [digest(JSON.stringify([current.pointer.sessionId, `${current.pointer.sessionId}:${current.pointer.seq}`]))],
  })
  expectSkip(withdrawn, 'source-withdrawn')
  let indexedNegativeControls
  if (!baseline) {
    const { pointer, revision, nextSeq } = fixtures.find(choice => choice.indexed)
    const lookupCallsBefore = observerState.opened.length
    const withdrawnFromIndex = await collect(pointer, {
      withdrawnSourceIds: [digest(JSON.stringify([pointer.sessionId, `${pointer.sessionId}:${pointer.seq}`]))],
    })
    expectSkip(withdrawnFromIndex, 'source-withdrawn')
    const writer = await ctx.sessionPersistence.open(pointer.sessionId, 'write')
    try {
      const newEvent = {
        seq: nextSeq,
        time: Date.now(),
        type: 'user/message',
        data: ownerInput('later-event', '这份记录已另行修改。'),
        surfaceOp: 'append',
      }
      await writer.append([newEvent])
      await writer.flush()
    } finally { await writer.close() }
    const changed = await ctx.sessionPersistence.stat(pointer.sessionId)
    assert.notEqual(changed.revision, revision, 'The host must detect the saved revision change')
    const staleIndex = await collect(pointer)
    expectSkip(staleIndex, 'stored-size-cap')
    assert.equal(observerState.opened.length, lookupCallsBefore)
    indexedNegativeControls = { withdrawn: withdrawnFromIndex.reason, changedRevision: staleIndex.reason, readCalls: 0 }
  }
  return { phase: 'cold-restart', cases: results, withdrawn: 'source-withdrawn', indexedNegativeControls }
}

export async function runInHost(ctx, root, packageDir, phase) {
  const transcripts = await load(packageDir, 'dream-transcripts.mjs')
  const { captureMessage } = await load(packageDir, 'capture-evidence.mjs')
  const { VERSION } = await load(packageDir, 'version.mjs')
  const baseline = VERSION === BASELINE
  const index = baseline ? undefined : (await load(packageDir, 'dream-replay-index.mjs')).createDreamReplayIndex(indexPath(root))
  const scenarios = phase === 'seed' ? seed : verify
  return {
    pluginVersion: VERSION, hostNode: process.versions.node, modelCalls: 0,
    ...await scenarios(ctx, { ...transcripts, captureMessage, index }, root, baseline),
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function boot({ cli, env, root, phase, driver, mount }) {
  const resultPath = join(root, `${phase}.json`)
  writeFileSync(driver, `
import { writeFileSync } from 'node:fs'
import { runInHost } from ${JSON.stringify(import.meta.url)}
export const name = 'solopup-history-acceptance'
export const inject = ['sessions', 'sessionQuery', 'sessionPersistence', 'compaction']
export async function apply(ctx) {
  let receipt
  try { receipt = { passed: true, ...await runInHost(ctx, ${JSON.stringify(root)}, ${JSON.stringify(mount)}, ${JSON.stringify(phase)}) } }
  catch (error) { receipt = { passed: false, error: error.stack } }
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(receipt))
}
`)
  const child = spawn(cli, ['--profile', 'long-history'], { env, cwd: root, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = '', launchError
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4500) })
  child.once('error', error => { launchError = error })
  try {
    const deadline = Date.now() + 30_000
    while (!existsSync(resultPath) && !launchError && child.exitCode === null && Date.now() < deadline) await sleep(50)
    if (launchError) throw launchError
    assert.ok(existsSync(resultPath), stderr || `DSH stopped before completing ${phase}`)
    const result = json(resultPath)
    assert.ok(result.passed, result.error)
    return result
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(r => child.once('exit', r))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 1500)
      try { await exited } finally { clearTimeout(timer) }
    }
  }
}

async function main() {
  const [flag, path, ...rest] = process.argv.slice(2)
  assert.ok(flag === '--tgz' && path && !rest.length, 'Usage: node scripts/probe-long-history.mjs --tgz archive.tgz')
  const archive = realpathSync(resolve(path))
  const cli = process.env.DSH_CLI ?? DEFAULT_CLI
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-long-history-')))
  const env = probeEnvironment(root)
  try {
    const mount = join(root, 'package')
    const driver = join(root, 'driver.mjs')
    const profile = join(env.HOME, 'profiles', 'long-history')
    mkdirSync(env.TMPDIR)
    mkdirSync(profile, { recursive: true })
    run('tar', ['-xzf', archive, '-C', root], { env })
    const version = json(join(mount, 'package.json')).version
    assert.ok(version === BASELINE || /^0\.25\.0-beta\.\d+$/.test(version), `Unexpected version ${version}`)
    const archiveSha256 = digest(readFileSync(archive))
    if (version === BASELINE) assert.equal(archiveSha256, BASELINE_HASH)
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'solopup-history-acceptance', private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] } },
    }))
    writeFileSync(join(profile, 'cordis.yml'), '[]\n')
    writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'acceptance', name: pathToFileURL(driver).href }] }]))
    const hostVersion = run(cli, ['--version'], { env })
    const seed = await boot({ cli, env, root, phase: 'seed', driver, mount })
    const cold = await boot({ cli, env, root, phase: 'verify', driver, mount })
    assert.equal(seed.pluginVersion, version)
    assert.equal(cold.pluginVersion, version)
    console.log(JSON.stringify({ passed: true, hostVersion, archiveSha256, ...cold }, null, 2))
  } finally { rmSync(root, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
