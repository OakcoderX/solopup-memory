#!/usr/bin/env node
/**
 * Offline, synthetic mechanics demonstration. Production tool handlers run in a
 * scripted host, with a scripted validation response, NOT DSH or a real model.
 * Each phase uses a separate Node process; no old conversation is replayed.
 * Run without arguments for six output lines, or --json for the full receipt.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.mjs'
import { scriptedNativeValidationLlm } from '../fixture-host.mjs'
import { VERSION } from '../version.mjs'
import { probeEnvironment } from './probe-env.mjs'

const script = fileURLToPath(import.meta.url)
const quote = '记住：本项目的交付说明统一用中文。'
const summary = '本项目的交付说明统一用中文'
const query = '交付说明'
const sourceSession = 'synthetic-demo-write'

async function phase(name, root) {
  // The internal phase runner refuses a non-demo home, including a user's home.
  assert.equal(realpathSync(tmpdir()), join(realpathSync(root), 'tmp'))
  assert.match(basename(root), /^solopup-readme-demo-/)
  assert.equal(process.env.DSH_HOME, join(root, 'home'))
  assert.ok(['write', 'recall', 'other-project'].includes(name))
  const handlers = [], tools = [], disposers = []
  const session = { id: name === 'write' ? sourceSession : `synthetic-demo-${name}` }
  const agent = { session, options: { provider: 'scripted-demo', model: 'scripted-demo' } }
  let validationCalls = 0
  const scripted = scriptedNativeValidationLlm()
  const ctx = {
    llm: { async prepareCall(config) { validationCalls++; return scripted.prepareCall(config) } },
    systemPrompt: { context() {} },
    workingDirectory: { get: () => join(root, name === 'other-project' ? 'project-b' : 'project-a') },
    tools: { register: tool => tools.push(tool) },
    on: (event, handler) => handlers.push([event, handler]),
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  }
  const emit = (event, ...args) => {
    for (const [registered, handler] of handlers) if (registered === event) handler(...args)
  }
  apply(ctx, { autoCapture: { enabled: false, timeoutMs: 2000 } })
  try {
    if (name === 'write') {
      const message = { id: 'synthetic-owner-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: quote }] }
      emit('agent/pre-step', { agent, turn: 1, step: 1, messages: [message] }, () => {})
      emit('session/event', session, { type: 'user/message', seq: 1, data: message })
      const args = { type: 'project', scope: 'project', summary, meaning: { kind: 'decision' } }
      const callId = 'synthetic-demo-write-call'
      emit('session/event', session, { type: 'tool/call', seq: 2, data: { callId, name: 'memory_write', arguments: JSON.stringify(args), turn: 1, step: 1 } })
      const result = await tools.find(t => t.name === 'memory_write').execute(args, { agent, callId })
      assert.equal(result.status, 'recorded')
      assert.equal(validationCalls, 1)
      return { sessionId: session.id, ownerMessage: quote, args, result, scriptedValidationCalls: validationCalls }
    }
    // No user-message events or old history are provided to these new processes.
    const search = tools.find(t => t.name === 'memory_search')
    const args = { query, mode: 'exact' }
    const current = await search.execute(args, { agent })
    const history = await search.execute({ ...args, view: 'history' }, { agent })
    assert.equal(validationCalls, 0)
    if (name === 'recall') {
      assert.equal(current.hits.length, 1)
      assert.equal(current.hits[0].scope, 'project')
      assert.ok(current.hits[0].text.includes(summary))
      assert.equal(history.hits.length, 1)
      assert.equal(history.hits[0].history.sourceSessionId, sourceSession)
      assert.deepEqual(history.hits[0].history.sourceMessageIds, [`${sourceSession}:1`])
      assert.ok(history.hits[0].text.includes(quote))
    } else {
      assert.equal(current.hits.length, 0)
      assert.equal(history.hits.length, 0)
    }
    return { sessionId: session.id, inheritedMessages: 0, args, current, history, scriptedValidationCalls: validationCalls }
  } finally {
    for (const dispose of disposers) dispose()
  }
}

if (process.argv[2] === '--phase' && process.argv.length === 5) {
  console.log(JSON.stringify(await phase(process.argv[3], process.argv[4])))
} else {
  assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--json', 'usage: node scripts/demo-source-recall.mjs [--json]')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-readme-demo-')))
  const env = probeEnvironment(root)
  for (const dir of [env.HOME, env.TMPDIR, join(root, 'project-a'), join(root, 'project-b')]) mkdirSync(dir)
  for (const project of ['project-a', 'project-b']) writeFileSync(join(root, project, '.dsh-root'), '')
  try {
    const phases = {}
    for (const name of ['write', 'recall', 'other-project']) {
      const child = spawnSync(process.execPath, [script, '--phase', name, root], { env, encoding: 'utf8', timeout: 30000 })
      assert.equal(child.status, 0, `demo ${name} failed: ${child.stderr}`)
      phases[name] = JSON.parse(child.stdout)
    }
    const lines = [
      `synthetic user: ${quote}`,
      `memory_write: ${phases.write.result.status} (scope=project, meaning=decision)`,
      `fresh process / memory_search("${query}"): ${phases.recall.current.hits.length} hit (scope=${phases.recall.current.hits[0].scope})`,
      `current text: ${phases.recall.current.hits[0].text}`,
      `history source: ${phases.recall.history.hits[0].history.sourceMessageIds.join(', ')}; quote: ${quote}`,
      `other project / current + history: ${phases['other-project'].current.hits.length} + ${phases['other-project'].history.hits.length} hits`,
    ]
    const report = {
      kind: 'synthetic-scripted-host-mechanics',
      at: new Date().toISOString(), version: VERSION,
      scriptSha256: createHash('sha256').update(readFileSync(script)).digest('hex'),
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      realDshHost: false, realModel: false, networkRequests: 0,
      isolatedTemporaryHome: true, separateProcesses: 3,
      limitations: 'Scripted validator approves this synthetic candidate. This verifies persistence, source return and project filtering only, not model judgment, real DSH schema registration, or natural fresh-chat recall.',
      lines, phases,
    }
    console.log(process.argv[2] === '--json' ? JSON.stringify(report, null, 2) : lines.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
