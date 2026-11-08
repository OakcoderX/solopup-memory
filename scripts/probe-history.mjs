#!/usr/bin/env node
/** Real DSH CLI/Loader, Session and Projection API check. Synthetic input, no model calls. */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { probeEnvironment } from './probe-env.mjs'

const CLI = process.env.DSH_CLI ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
if (!existsSync(CLI)) { console.error('[FAIL] DSH_CLI must identify an installed official host'); process.exit(2) }
const source = dirname(dirname(fileURLToPath(import.meta.url)))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-history-probe-')))
const env = probeEnvironment(root), profile = join(env.HOME, 'profiles', 'probe')
mkdirSync(profile, { recursive: true }); mkdirSync(env.TMPDIR)
const reportFile = join(root, 'result.json'), driver = join(root, 'driver.mjs')
writeFileSync(driver, `
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import * as memory from ${JSON.stringify(pathToFileURL(join(source, 'index.mjs')).href)}
import { memoryContextProjection, reconcileMemoryContext } from ${JSON.stringify(pathToFileURL(join(source, 'context-history.mjs')).href)}
export const name = 'solopup-history-probe'
export const inject = ['sessions', 'sessionProjections', 'systemPrompt', 'workingDirectory', 'tools']
export async function apply(ctx) {
  try {
    const owner = await ctx.plugin(memory, { autoCapture: { enabled: false } })
    if (typeof owner?.await === 'function') await owner.await()
    const stamp = JSON.parse(readFileSync(${JSON.stringify(join(env.HOME, 'memory', '.loaded.json'))}, 'utf8'))
    assert.equal(stamp.memoryHistory.available, true)
    assert.equal(stamp.tools.length, 6)
    const key = 'solopup:synthetic-projection-probe'
    const definition = { ...memoryContextProjection(), key }
    const register = async () => {
      const value = await ctx.sessionProjections.register(definition)
      return typeof value?.stateOf === 'function' ? { ...value, retained: true } : { stateOf: session => ctx.sessionProjections.stateOf(session, key), dispose: value, retained: false }
    }
    const handle = await register()
    const session = ctx.sessions.create('solopup-synthetic-history')
    const ordinary = { id: 'ordinary', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary synthetic quotation remains' }] }
    session.append('user/message', ordinary, { surfaceOp: 'append' })
    const sections = [{ name: 'memory:index', text: 'obsolete synthetic memory' }, { name: 'other:context', text: 'keep other provider' }]
    const old = { id: 'old-context', role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\\n\\n' + sections.map(s => s.text).join('\\n\\n') }] }
    const event = session.append('user/message', old, { surfaceOp: 'append' })
    assert.deepEqual(handle.stateOf(session).nodes, [{ id: 'old-context', seq: event.seq }])
    assert.equal(reconcileMemoryContext(session, handle.stateOf(session), 'current synthetic memory').replaced, 1)
    assert.deepEqual(session.deriveMessages()[0], ordinary)
    assert.doesNotMatch(JSON.stringify(session.deriveMessages()), /obsolete synthetic memory/)
    assert.match(JSON.stringify(session.deriveMessages()), /keep other provider/)
    assert.deepEqual(handle.stateOf(session).nodes, [])
    await handle.dispose()
    // A registration acquired after events exist must reconstruct from the real Session.
    const replay = await register()
    assert.deepEqual(replay.stateOf(session).nodes, [])
    const replayed = ctx.sessions.create('solopup-synthetic-replay', { seed: [{ ...event, seq: 0 }] })
    assert.equal(replay.stateOf(replayed).nodes.length, 1)
    await replay.dispose()
    if (replay.retained) assert.equal(replay.stateOf(replayed).nodes.length, 1, 'retained readers remain usable after owner disposal')
    await assert.rejects(async () => await ctx.sessionProjections.register({ ...definition, stateVersion: -1 }), /non-negative/)
    await owner.dispose()
    writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ passed: true, realDshHost: true, realModel: false, cleanHome: true, syntheticInput: true, tools: stamp.tools.length, projectionApi: handle.retained ? 'retained-handle' : 'legacy-registry', historyAvailable: stamp.memoryHistory.available, liveState: true, rewritePreservesOrdinaryAndOtherProvider: true, coldReplay: true, registrationRejected: true, ownerDisposed: true }) + '\\n')
  } catch (error) {
    writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify({ passed: false, error: error.stack }) + '\\n')
  }
}
`)
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'solopup-history-probe', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
writeFileSync(join(profile, 'cordis.yml'), '[]\n')
writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: history-probe\n      name: ${JSON.stringify(pathToFileURL(driver).href)}\n`)
let output = '', child
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  child = spawn(CLI, ['--profile', 'probe', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  let childError
  child.once('error', error => { childError = error.code })
  const deadline = Date.now() + 40000
  while (!existsSync(reportFile) && !childError && child.exitCode === null && Date.now() < deadline) await sleep(100)
  if (!existsSync(reportFile)) throw Error(`history-probe-host-failed:${childError ?? child.exitCode ?? 'timeout'}\n${output.slice(-6000)}`)
  const report = JSON.parse(readFileSync(reportFile, 'utf8'))
  if (!report.passed) throw Error(report.error + '\n' + output.slice(-6000))
  console.log('[PASS] Real DSH history registration, live state, rewrite, cold replay, rejection and disposal')
  console.log(JSON.stringify(report))
} catch (error) {
  console.error('[FAIL] ' + error.message); process.exitCode = 1
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once('exit', resolve))
    child.kill('SIGTERM'); await Promise.race([stopped, sleep(1500)])
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([stopped, sleep(1500)]) }
  }
  rmSync(root, { recursive: true, force: true })
}
