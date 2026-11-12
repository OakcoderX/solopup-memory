import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chunkText, selectCaptureControls } from './capture-llm.mjs'
import { SUPER_AGENT_DREAM_PROTOCOL, SUPER_AGENT_DREAM_PROTOTYPE } from './dream-superagent.mjs'
import { encodeFrame, readFrames } from './scripts/dream-companion-wire.mjs'

const SANDBOX = '/usr/bin/sandbox-exec'
const PROFILE = 'dream-companion'
const ISOLATION_ID = 'macos-seatbelt-deny-default-v1'
const DSH_VERSION = '0.2.2-rc.1'
const PROOF_LIFETIME_MS = 15_000
const HASH = /^[a-f0-9]{64}$/
const TICKET = /^[a-f0-9]{32}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const sha = value => createHash('sha256').update(value).digest('hex')
const bindingKeys = ['runId', 'attempt', 'projectId', 'inputDigest', 'runtimeId', 'isolationId']
const pickBinding = value => Object.fromEntries(bindingKeys.map(key => [key, value[key]]))
const sameBinding = (left, right) => Boolean(left && right && bindingKeys.every(key => left[key] === right[key]))
const natural = value => Number.isSafeInteger(value) && value >= 0
const executeFile = promisify(execFile)
const unsent = code => Object.assign(Error(code), { notDispatched: true })

function absoluteFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw Error('dream-companion-invalid-path')
  return realpathSync(path)
}

function privateStateDir(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw Error('dream-companion-invalid-state-dir')
  mkdirSync(path, { mode: 0o700 })
  return realpathSync(path)
}

function openState(path) {
  const info = lstatSync(path)
  if (!info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw Error('dream-companion-insecure-state-dir')
  const file = join(path, 'runs.sqlite')
  if (existsSync(file)) {
    const stats = lstatSync(file)
    if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o077) || (process.getuid && stats.uid !== process.getuid())) {
      throw Error('dream-companion-insecure-state-file')
    }
  }
  const db = new DatabaseSync(file)
  chmodSync(file, 0o600)
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, binding TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT, model_started INTEGER NOT NULL DEFAULT 0
    );`)
  return db
}

function configured(config) {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX)) throw Error('dream-companion-platform-unavailable')
  const cli = absoluteFile(config.dshCli)
  const index = cli.indexOf('.app/Contents/')
  if (index < 0 || !cli.endsWith('/Contents/Resources/runtime/cli/bin/dsh')) throw Error('dream-companion-unsupported-cli')
  const bundle = absoluteFile(config.prototypeBundle)
  const expected = config.prototypeBundleSha256
  if (!HASH.test(expected ?? '') || sha(readFileSync(bundle)) !== expected) throw Error('dream-companion-prototype-digest-mismatch')
  const prototypeRoot = dirname(dirname(bundle))
  const dependencies = realpathSync(join(prototypeRoot, 'node_modules'))
  if (JSON.parse(readFileSync(join(prototypeRoot, 'package.json'), 'utf8')).name !== 'dsh-superagent') throw Error('dream-companion-prototype-package')
  let state
  if (existsSync(config.stateDir ?? '')) {
    if (lstatSync(config.stateDir).isSymbolicLink()) throw Error('dream-companion-insecure-state-dir')
    state = absoluteFile(config.stateDir)
  } else state = privateStateDir(config.stateDir)
  return { cli, app: cli.slice(0, index + 4), bundle, expected, prototypeRoot, dependencies, state,
    runtimeId: sha(JSON.stringify([cli, bundle, expected, state, DSH_VERSION, ISOLATION_ID])).slice(0, 40) }
}

function makeBoundary(base) {
  const allowed = join(base, 'boundary'), blocked = join(base, 'outside')
  mkdirSync(allowed, { mode: 0o700 }); mkdirSync(blocked, { mode: 0o700 })
  writeFileSync(join(allowed, 'allowed.txt'), 'solopup-companion-read-canary', { mode: 0o600 })
  writeFileSync(join(blocked, 'blocked.txt'), 'solopup-companion-denied-canary', { mode: 0o600 })
  symlinkSync(join(blocked, 'blocked.txt'), join(allowed, 'outside-link'))
  return allowed
}

function seatbeltProfile(readPaths, writable) {
  const readable = ['/System/Library', '/usr/lib', '/usr/bin', '/bin', writable, ...readPaths]
  const paths = readable.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')
  const ancestors = new Set(['/'])
  for (const path of readable) for (let parent = dirname(path); parent !== '/'; parent = dirname(parent)) ancestors.add(parent)
  const traversal = [...ancestors].map(path => `(literal ${JSON.stringify(path)})`).join(' ')
  return `(version 1)
    (deny default)
    (allow process-exec process-fork sysctl-read file-read-metadata)
    (allow signal (target self))
    (allow file-read-data ${traversal})
    (allow file-read* file-map-executable ${paths} (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
    (allow file-write* (subpath ${JSON.stringify(writable)}) (literal "/dev/null"))`
}

function stage(base, environment, nonce) {
  const allowed = makeBoundary(base), root = join(base, 'host'), code = join(base, 'code')
  const prototype = join(code, 'prototype'), bundle = join(prototype, 'bundle.mjs')
  const home = join(root, 'home'), profile = join(home, 'profiles', PROFILE), tmp = join(root, 'tmp')
  for (const path of [prototype, profile, tmp]) mkdirSync(path, { recursive: true, mode: 0o700 })
  for (const file of ['dream-companion-worker.mjs', 'dream-companion-wire.mjs']) {
    copyFileSync(fileURLToPath(new URL(`./scripts/${file}`, import.meta.url)), join(code, file))
  }
  const bundled = readFileSync(environment.bundle)
  if (sha(bundled) !== environment.expected) throw Error('dream-companion-prototype-digest-mismatch')
  writeFileSync(bundle, bundled)
  for (const file of ['package.json', 'skills', 'prompts']) cpSync(join(environment.prototypeRoot, file), join(prototype, file), { recursive: true })
  symlinkSync(environment.dependencies, join(prototype, 'node_modules'), 'dir')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'solopup-companion-child', private: true,
    dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: solopup-companion-child\n      name: ${JSON.stringify(pathToFileURL(join(code, 'dream-companion-worker.mjs')).href)}\n`)
  const sandbox = seatbeltProfile([environment.app, environment.dependencies, code, allowed], root)
  const env = { PATH: '/usr/bin:/bin', HOME: home, CFFIXED_USER_HOME: home, USERPROFILE: home, DSH_HOME: home, TMPDIR: tmp,
    SOLOPUP_COMPANION_ROOT: root, SOLOPUP_COMPANION_BUNDLE: bundle, SOLOPUP_COMPANION_NONCE: nonce }
  return { root, sandbox, env }
}

async function probeSeatbelt(environment, signal) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-probe-')))
  try {
    const allowed = makeBoundary(base), root = join(base, 'host')
    mkdirSync(root, { mode: 0o700 })
    const profile = seatbeltProfile([environment.app, allowed], root)
    const opts = { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, CFFIXED_USER_HOME: root, DSH_HOME: root, TMPDIR: root, LC_ALL: 'C' },
      timeout: 1300, signal, maxBuffer: 16 * 1024 }
    const read = path => executeFile(SANDBOX, ['-p', profile, '/bin/cat', path], opts)
    const readable = await read(join(allowed, 'allowed.txt'))
    if (readable.stdout !== 'solopup-companion-read-canary') return false
    for (const blocked of [join(base, 'outside', 'blocked.txt'), join(allowed, 'outside-link')]) {
      try { await read(blocked); return false }
      catch (error) { if (error.code !== 1 || !/Operation not permitted|Permission denied/.test(error.stderr ?? '')) return false }
    }
    const version = await executeFile(SANDBOX, ['-p', profile, environment.cli, '--version'], opts)
    return version.stdout.trim() === DSH_VERSION
  } catch {
    return false
  } finally { rmSync(base, { recursive: true, force: true }) }
}

function runId(binding) { return sha(JSON.stringify([binding.runId, binding.attempt])) }

function validRequest(envelope, runtimeId) {
  const { binding, proof, messages, route, trigger } = envelope ?? {}
  return envelope?.protocol === SUPER_AGENT_DREAM_PROTOCOL && ID.test(binding?.runId ?? '') && natural(binding?.attempt) && binding.attempt > 0 &&
    HASH.test(binding.projectId ?? '') && HASH.test(binding.inputDigest ?? '') && binding.runtimeId === runtimeId && binding.isolationId === ISOLATION_ID &&
    proof?.runtimeId === runtimeId && proof.isolationId === ISOLATION_ID && trigger?.source === 'solopup-dream' &&
    trigger.meta?.runId === binding.runId && trigger.meta.attempt === binding.attempt && trigger.meta.projectId === binding.projectId &&
    trigger.meta.inputDigest === binding.inputDigest && Array.isArray(messages) && messages.length === 2 &&
    messages.every((message, index) => message.role === (index === 0 ? 'system' : 'user') && message.content?.length === 1 &&
      message.content[0].type === 'text' && typeof message.content[0].text === 'string') &&
    typeof route?.provider === 'string' && typeof route.model === 'string' && natural(envelope.maxTokens) && envelope.maxTokens > 0 &&
    natural(envelope.maxTotalTokens) && envelope.maxTotalTokens <= 12_000 &&
    Buffer.byteLength(JSON.stringify(messages)) + envelope.maxTokens + 512 <= envelope.maxTotalTokens
}

async function brokerModel(getLlm, envelope, signal, recheck, beginEgress) {
  const service = getLlm()
  if (!service || service.signal?.aborted || typeof service.value?.prepareCall !== 'function') throw Error('dream-companion-llm-unavailable')
  const linked = service.signal ? AbortSignal.any([signal, service.signal]) : signal
  linked.throwIfAborted()
  await recheck()
  linked.throwIfAborted()
  const [system, ...messages] = envelope.messages
  const call = await service.value.prepareCall({ provider: envelope.route.provider, model: envelope.route.model,
    maxTokens: envelope.maxTokens, reasoningEffort: 'off' }, linked, selectCaptureControls)
  linked.throwIfAborted()
  if (call.config?.provider !== envelope.route.provider || call.config?.model !== envelope.route.model ||
      !natural(call.config?.maxTokens) || call.config.maxTokens < 1 || call.config.maxTokens > envelope.maxTokens) {
    throw Error('dream-companion-model-route-changed')
  }
  await recheck()
  linked.throwIfAborted()
  beginEgress()
  let output = '', usage, finished = false
  for await (const chunk of call.stream({ ...call.config, system: system.content[0].text, messages, tools: [],
    purpose: 'memory-dream-superagent-review', sessionId: 'memory-dream-' + envelope.binding.runId, signal: linked })) {
    linked.throwIfAborted()
    if (chunk?.type === 'finish') {
      const reason = chunk.reason?.kind ?? chunk.reason
      if (reason !== 'stop') throw Error('dream-companion-model-incomplete')
      finished = true
    }
    if (['finish', 'usage'].includes(chunk?.type)) {
      const { inputTokens, outputTokens } = chunk.usage ?? {}
      if (natural(inputTokens) && natural(outputTokens) && natural(inputTokens + outputTokens)) {
        usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
      }
    }
    output += chunkText(chunk)
    if (Buffer.byteLength(output) > 8192 || usage?.totalTokens > envelope.maxTotalTokens) throw Error('dream-companion-model-budget')
  }
  if (!finished || !output.trim()) throw Error('dream-companion-model-incomplete')
  return { output, usage }
}

function startChild(environment, envelope, signal, onTicket, onModel) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-dream-child-')))
  const nonce = randomBytes(32).toString('hex')
  let child, childEnded, input, ticketId, model, sent = false
  const scope = new AbortController()
  const linked = AbortSignal.any([signal, scope.signal])
  const result = (async () => {
    try {
      linked.throwIfAborted()
      const setup = stage(base, environment, nonce)
      child = spawn(SANDBOX, ['-p', setup.sandbox, environment.cli, '--profile', PROFILE], { cwd: setup.root, env: setup.env, detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
      childEnded = new Promise(resolve => child.once('close', resolve))
      input = child.stdio[3]
      return await new Promise((resolve, reject) => {
        let settled = false
        const done = (error, value) => {
          if (settled) return
          settled = true
          linked.removeEventListener('abort', abort)
          if (error) reject(error)
          else resolve(value)
        }
        const fail = () => done(Error('dream-companion-child-protocol'))
        const abort = () => done(Error('dream-companion-child-cancelled'))
        linked.addEventListener('abort', abort, { once: true })
        child.once('error', fail)
        child.once('close', fail)
        input.on('error', fail)
        const send = frame => input.write(encodeFrame({ ...frame, nonce }))
        readFrames(child.stdio[4], frame => {
          if (settled) return
          if (frame?.nonce !== nonce || linked.aborted) return fail()
          if (frame.type === 'ready' && !sent) {
            sent = true
            send({ type: 'run', envelope: { binding: envelope.binding, trigger: envelope.trigger, messages: envelope.messages } })
          } else if (frame.type === 'ticket' && sent && !ticketId && TICKET.test(frame.ticketId ?? '')) {
            ticketId = frame.ticketId
            onTicket({ ...envelope.binding, ticketId })
          } else if (frame.type === 'model' && ticketId && !model && frame.ticketId === ticketId && frame.workerSessionId === `worker-${ticketId}`) {
            const receipt = { ...envelope.binding, ticketId, workerSessionId: frame.workerSessionId }
            model = Promise.resolve(onModel(linked, receipt)).then(value => {
              if (!settled && !linked.aborted) send({ type: 'answer', output: value.output })
              return value
            })
            void model.catch(fail)
          } else if (frame.type === 'result' && model && frame.ticketId === ticketId && frame.workerSessionId === `worker-${ticketId}`) {
            void model.then(value => {
              if (frame.outputHash !== sha(value.output)) return fail()
              done(null, { ...value, receipt: { ...envelope.binding, ticketId, workerSessionId: frame.workerSessionId } })
            }, fail)
          } else fail()
        }, fail, fail)
        if (linked.aborted) abort()
      })
    } finally {
      scope.abort()
      input?.destroy()
      if (child?.exitCode === null && child.signalCode === null) {
        stopChildGroup(child, 'SIGTERM')
        await Promise.race([childEnded, delay(1000)])
        if (child.exitCode === null && child.signalCode === null) stopChildGroup(child, 'SIGKILL')
      }
      child?.stdio[4]?.destroy()
      if (childEnded) await childEnded
      rmSync(base, { recursive: true, force: true })
    }
  })()
  return { result, cancel: () => scope.abort(Error('dream-companion-explicit-cancel')),
    cancelled: () => signal.aborted || cancelledLocally() }

  function cancelledLocally() { return scope.signal.reason?.message === 'dream-companion-explicit-cancel' }
}

function stopChildGroup(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return
  try { process.kill(-child.pid, signal) }
  catch (error) { if (error.code !== 'ESRCH') child.kill(signal) }
}

/** Creates an explicit local companion and a verifier which tests the OS boundary. */
export function createDreamCompanion({ getLlm, ...config }) {
  const environment = configured(config), db = openState(environment.state)
  const live = new Map(), proven = new Map()
  let closed = false
  const row = id => db.prepare('SELECT binding,status,receipt,model_started AS modelStarted FROM runs WHERE id=?').get(id)
  const progress = (id, status, receipt) => db.prepare('UPDATE runs SET status=?, receipt=coalesce(?, receipt) WHERE id=?')
    .run(status, receipt === undefined ? null : JSON.stringify(receipt), id)
  const status = binding => {
    if (closed || !binding) return { state: 'uncertain' }
    const id = runId(binding), saved = row(id)
    if (!saved || !sameBinding(binding, JSON.parse(saved.binding)) || !saved.receipt) return { state: 'uncertain' }
    return { state: saved.status === 'running' && !live.has(id) ? 'uncertain' : saved.status, receipt: JSON.parse(saved.receipt) }
  }
  const bridge = {
    probe({ protocol, challenge, signal }) {
      signal?.throwIfAborted()
      if (closed || protocol !== SUPER_AGENT_DREAM_PROTOCOL || !ID.test(challenge ?? '')) throw Error('dream-companion-probe-unavailable')
      return { protocol, challenge, source: 'solopup-dream', prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE,
        runtimeId: environment.runtimeId, isolationId: ISOLATION_ID }
    },
    async dispatch(envelope, { signal, onReceipt, beforeModel }) {
      signal.throwIfAborted()
      if (closed || !validRequest(envelope, environment.runtimeId) || typeof beforeModel !== 'function') throw Error('dream-companion-invalid-dispatch')
      const proof = proven.get(envelope.proof.challenge)
      proven.delete(envelope.proof.challenge)
      if (!proof || proof.expires <= Date.now() || !sameBinding(proof.binding, envelope.binding) ||
          proof.binding.route.provider !== envelope.route.provider || proof.binding.route.model !== envelope.route.model ||
          proof.binding.maxTokens !== envelope.maxTokens || proof.binding.maxTotalTokens !== envelope.maxTotalTokens ||
          proof.binding.modelInputDigest !== sha(JSON.stringify(envelope.messages))) throw Error('dream-companion-no-dispatch-proof')
      const id = runId(envelope.binding)
      const insert = db.prepare("INSERT OR IGNORE INTO runs(id,binding,status) VALUES (?,?,'running')")
        .run(id, JSON.stringify(pickBinding(envelope.binding)))
      if (insert.changes !== 1) throw Error('dream-companion-duplicate-attempt')
      const instance = startChild(environment, envelope, signal,
        receipt => { progress(id, 'running', receipt); onReceipt(receipt) },
        async (linked, receipt) => {
          progress(id, 'running', receipt)
          onReceipt(receipt)
          return brokerModel(getLlm, envelope, linked, beforeModel, () => db.prepare('UPDATE runs SET model_started=1 WHERE id=?').run(id))
        })
      live.set(id, instance)
      try {
        const result = await instance.result
        progress(id, 'completed', result.receipt)
        return result
      } catch (error) {
        const started = Boolean(row(id)?.modelStarted)
        const terminal = progress(id, instance.cancelled() ? 'cancelled' : started ? 'uncertain' : 'failed')
        if (!started && terminal.changes === 1) throw unsent('dream-companion-model-unsent')
        throw error
      } finally { live.delete(id) }
    },
    status,
    async cancel(binding) {
      const current = status(binding)
      if (current.state !== 'running') return current
      const instance = live.get(runId(binding))
      if (!instance) return { state: 'uncertain' }
      instance.cancel()
      await instance.result.catch(() => {})
      return status(binding)
    },
  }
  const isolation = {
    async verify({ proof, signal, request }) {
      if (closed || signal?.aborted || proof?.runtimeId !== environment.runtimeId || proof.isolationId !== ISOLATION_ID ||
          proof.prototypeCommit !== SUPER_AGENT_DREAM_PROTOTYPE) return false
      if (!request?.runtimeId && typeof getLlm?.()?.value?.prepareCall !== 'function') return false
      if (!await probeSeatbelt(environment, signal) || closed || signal?.aborted) return false
      if (request?.route) {
        for (const [key, value] of proven) if (value.expires <= Date.now()) proven.delete(key)
        if (proven.size >= 16 || !HASH.test(request.modelInputDigest ?? '')) return false
        proven.set(proof.challenge, { expires: Date.now() + PROOF_LIFETIME_MS,
          binding: { ...request, runtimeId: environment.runtimeId, isolationId: ISOLATION_ID } })
      }
      return !signal?.aborted
    },
  }
  return { bridge, isolation, async close() {
    if (closed) return
    closed = true
    const running = [...live.values()]
    for (const instance of running) instance.cancel()
    await Promise.allSettled(running.map(instance => instance.result))
    db.close()
  } }
}
