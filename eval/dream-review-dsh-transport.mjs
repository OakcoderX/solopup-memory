#!/usr/bin/env node
/** L3 transport through the installed DSH model service in disposable profiles. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createOrdinaryDreamExecutor } from '../dream-ordinary.mjs'
import { SUPER_AGENT_DREAM_PROTOTYPE } from '../dream-superagent.mjs'
import { dreamReviewMessages } from '../dream-review.mjs'
import { findSecrets, readSafely, writeSafely } from '../security.mjs'
import { probeEnvironment } from '../scripts/probe-env.mjs'
import { runDreamReviewTrial } from './run-dream-review-trial.mjs'

export const name = 'solopup-dream-trial-ordinary'
export const inject = ['llm']
const PROFILE = 'dream-trial'
const DEFAULT_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const LOOPBACK_ROUTE = Object.freeze({ provider: 'solopup-dream-loopback', model: 'dream-fixture' })
const ROOT_PREFIX = 'solopup-dream-trial-host-'
const KEY_ENV = 'SOLOPUP_DREAM_TRIAL_LOOPBACK_KEY'
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/
const UUID = /^[a-f0-9-]{36}$/
const TICKET = /^[a-f0-9]{32}$/
const HASH = /^[a-f0-9]{64}$/
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const boundedInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max
const identifier = value => typeof value === 'string' && IDENTIFIER.test(value) && !value.includes('://') && !findSecrets(value).length
const safeErrorCode = error => {
  const code = error?.code ?? error?.message
  return typeof code === 'string' && /^dream-(?:trial-dsh|superagent|companion|review)-[a-z-]+$/.test(code)
    ? code : 'dream-trial-dsh-model-call-failed'
}

function fail(code) {
  const error = Error(`dream-trial-dsh-${code}`)
  error.code = error.message
  throw error
}

function configuredEndpoint(baseURL, apiKey) {
  if (baseURL === undefined && apiKey === undefined) return undefined
  if (typeof baseURL !== 'string' || typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(apiKey)) fail('credential-unavailable')
  let url
  try { url = new URL(baseURL) } catch { fail('invalid-provider-url') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('invalid-provider-url')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`
  return url
}

function verifyRequest(request) {
  if (!['ordinary', 'superagent'].includes(request?.mode) || !UUID.test(request.runId) || !identifier(request.route?.provider) ||
      !identifier(request.route?.model) || request.generation?.reasoningEffort !== 'off' ||
      !boundedInt(request.generation.maxTokens, 1, 1800) || !boundedInt(request.budget?.calls, 1, 40) ||
      !boundedInt(request.budget?.inputTokens, 1, 150_000) || !boundedInt(request.budget?.outputTokens, request.generation.maxTokens, 25_000)) fail('invalid-request')
  const messages = dreamReviewMessages(request.input)
  if (digest(messages) !== digest(request.messages) || Buffer.byteLength(JSON.stringify(messages)) > request.budget.inputTokens) fail('input-mismatch')
  return messages
}

function installedModule(root, file) {
  return pathToFileURL(join(root, 'home', 'profiles', PROFILE, 'node_modules', 'solopup-memory', file)).href
}

function workerBinding(receipt) {
  return TICKET.test(receipt?.ticketId) && receipt.workerSessionId === `worker-${receipt.ticketId}`
    ? { ticketId: receipt.ticketId, workerSessionId: receipt.workerSessionId } : undefined
}

async function installedSuperAgent(root, ctx, controller, request, beforeDispatch) {
  const { createSuperAgentDreamExecutor, SUPER_AGENT_DREAM_SERVICE, SUPER_AGENT_DREAM_ISOLATION_SERVICE,
    SUPER_AGENT_DREAM_PROTOTYPE: installedPin } = await import(installedModule(root, 'dream-superagent.mjs'))
  const { watchOptionalService } = await import(installedModule(root, 'service-readiness.mjs'))
  if (installedPin !== SUPER_AGENT_DREAM_PROTOTYPE) fail('installed-prototype-pin-changed')
  const bridge = watchOptionalService(ctx, SUPER_AGENT_DREAM_SERVICE)
  const isolation = watchOptionalService(ctx, SUPER_AGENT_DREAM_ISOLATION_SERVICE)
  const readiness = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
  while (!bridge.refresh().value || !isolation.refresh().value) {
    if (readiness.aborted) fail('companion-service-unavailable')
    try { await delay(30, undefined, { signal: readiness }) } catch { fail('companion-service-unavailable') }
  }
  const executor = createSuperAgentDreamExecutor({ getBridge: () => bridge.refresh(), getIsolation: () => isolation.refresh() })
  const checkFrozenInput = () => {
    controller.signal.throwIfAborted()
    const current = JSON.parse(readSafely(join(root, 'request.json'), { maxBytes: 40 * 1024 }))
    verifyRequest(current)
    if (digest(current) !== digest(request)) fail('input-changed-before-model')
  }
  let worker, modelChecks = 0
  const result = await executor.execute(request.input, { signal: controller.signal, runId: request.runId, attempt: 1,
    route: request.route, maxTokens: request.generation.maxTokens,
    maxTotalTokens: Math.min(12_000, request.budget.inputTokens + request.budget.outputTokens),
    verifyBeforeDispatch: checkFrozenInput, beforeDispatch,
    onReceipt(receipt) { worker = workerBinding(receipt) ?? worker },
    beforeModel() {
      checkFrozenInput()
      if (!worker) fail('worker-not-bound-before-model')
      modelChecks += 1
    },
  })
  const final = workerBinding(result.receipt)
  if (!final || !worker || final.ticketId !== worker.ticketId || modelChecks < 1) fail('worker-result-unbound')
  return { ...result, worker: { ...final, modelChecks, prototypeCommit: installedPin } }
}

/** The host runs the same no-tool executors as the product. It receives no real provider credential. */
export function apply(ctx) {
  const root = process.env.SOLOPUP_DREAM_TRIAL_ROOT
  if (!root || !basename(root).startsWith(ROOT_PREFIX) || process.env.DSH_HOME !== join(root, 'home') || process.env.HOME !== join(root, 'home')) {
    fail('isolated-profile-required')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => {
    void (async () => {
      const request = JSON.parse(readSafely(join(root, 'request.json'), { maxBytes: 40 * 1024 }))
      const messages = verifyRequest(request)
      let prepared = false
      const beforeDispatch = () => { prepared = true }
      const installed = process.env.SOLOPUP_DREAM_TRIAL_INSTALLED === '1'
      let response
      if (request.mode === 'superagent') {
        if (!installed) fail('companion-required')
        response = await installedSuperAgent(root, ctx, controller, request, beforeDispatch)
      } else {
        const create = installed ? (await import(installedModule(root, 'dream-ordinary.mjs'))).createOrdinaryDreamExecutor : createOrdinaryDreamExecutor
        const executor = create({ getLlm: () => ({ value: ctx.llm, signal: controller.signal }) })
        response = await executor.execute(request.input, { signal: controller.signal, runId: request.runId, route: request.route,
          maxTokens: request.generation.maxTokens, beforeDispatch })
      }
      writeSafely(join(root, 'response.json'), JSON.stringify({ ok: true, prepared, requestSha256: digest(messages), mode: request.mode,
        hostNode: process.versions.node, runId: request.runId, output: response.output, usage: response.usage, worker: response.worker }))
    })().catch(error => {
      writeSafely(join(root, 'response.json'), JSON.stringify({ ok: false, code: safeErrorCode(error) }))
    })
  }, 0)
  ctx.effect(() => () => { clearTimeout(timer); controller.abort() })
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || !content.every(part => part?.type === 'text' && typeof part.text === 'string')) fail('wire-messages')
  return content.map(part => part.text).join('')
}

function verifyWire(body, messages, request) {
  if (body?.model !== request.route.model || body.stream !== true || body.tools?.length || body.tool_choice !== undefined ||
      !Array.isArray(body.messages) || body.messages.length !== messages.length) fail('wire-route-or-tools')
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (maxTokens !== request.generation.maxTokens) fail('wire-output-budget')
  for (const [index, expected] of messages.entries()) {
    const actual = body.messages[index]
    const roles = expected.role === 'system' ? ['system', 'developer'] : [expected.role]
    if (!roles.includes(actual?.role) || messageText(actual.content) !== messageText(expected.content)) fail('wire-messages')
  }
}

function loopbackEvents(model, body) {
  const evidence = JSON.parse(messageText(body.messages[1].content))
  const output = JSON.stringify({ items: evidence.items.map(item => ({ id: item.id, verdict: 'needs-evidence', sourceIds: [],
    reason: '这是仅验证真实宿主传输的虚构答复。' })) })
  const base = { id: 'dream-loopback-completion', object: 'chat.completion.chunk', created: 1, model }
  const event = (choices, usage) => `data: ${JSON.stringify({ ...base, choices, ...(usage ? { usage } : {}) })}\n\n`
  return event([{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }]) +
    event([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
    event([], { prompt_tokens: 902, completion_tokens: 168, total_tokens: 1070,
      prompt_tokens_details: { cached_tokens: 600 } }) + 'data: [DONE]\n\n'
}

export function dreamTrialProviderPayload(endpoint, body) {
  const payload = { ...body, stream_options: { ...body.stream_options, include_usage: true } }
  if (endpoint.origin !== 'https://api.deepseek.com') return { payload }
  delete payload.reasoning_effort
  payload.thinking = { type: 'disabled' }
  return { payload, providerThinking: 'explicit-off' }
}

async function startGateway(request, messages, { endpoint, apiKey, signal }) {
  const localKey = randomUUID()
  const proof = { calls: 0, verified: false, status: 'waiting', models: new Set() }
  const server = createServer(async (incoming, response) => {
    if (incoming.method !== 'POST' || incoming.url !== '/v1/chat/completions' || incoming.headers.authorization !== `Bearer ${localKey}`) {
      response.writeHead(404).end()
      return
    }
    if (proof.status !== 'waiting') { response.writeHead(429).end(); return }
    proof.status = 'validating'
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of incoming) {
        bytes += chunk.length
        if (bytes > 32 * 1024) fail('wire-payload-too-large')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      verifyWire(body, messages, request)
      signal.throwIfAborted()
      proof.verified = true
      proof.calls += 1
      if (!endpoint) {
        proof.models.add(request.route.model)
        proof.status = 'completed'
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(loopbackEvents(request.route.model, body))
        return
      }
      proof.status = 'upstream'
      const { payload, providerThinking } = dreamTrialProviderPayload(endpoint, body)
      proof.providerThinking = providerThinking
      const upstream = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(payload) })
      if (!upstream.ok || !upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
        proof.status = upstream.status === 401 || upstream.status === 403 ? 'provider-authentication' : upstream.status === 429 ? 'provider-rate-limit' : 'provider-response'
        await upstream.body?.cancel()
        response.writeHead(502).end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const decoder = new TextDecoder()
      let pending = '', wireBytes = 0
      for await (const chunk of upstream.body) {
        signal.throwIfAborted()
        wireBytes += chunk.byteLength
        if (wireBytes > 512 * 1024) fail('provider-stream-too-large')
        const lines = (pending + decoder.decode(chunk, { stream: true })).split('\n')
        pending = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const model = JSON.parse(line.slice(5).trim()).model
            if (identifier(model) && proof.models.size < 4) proof.models.add(model)
          } catch { /* Comments and end markers have no model label. */ }
        }
        if (!response.write(chunk)) await once(response, 'drain', { signal })
      }
      proof.status = 'completed'
      response.end()
    } catch (error) {
      proof.status = proof.verified ? 'provider-transport' : error?.code?.startsWith('dream-trial-dsh-wire-') ? error.code : 'wire-invalid'
      if (!response.headersSent) response.writeHead(502)
      response.end()
    }
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return { localKey, url: `http://127.0.0.1:${server.address().port}/v1`, proof, async close() {
    await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections() })
  } }
}

function profileFiles(root, gateway, route, executable, candidate, companion, mode) {
  const env = probeEnvironment(root)
  const profile = join(env.DSH_HOME, 'profiles', PROFILE)
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(env.TMPDIR, { mode: 0o700 })
  writeSafely(join(profile, 'package.json'), JSON.stringify({ name: 'solopup-dream-trial-profile', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
  writeSafely(join(profile, 'cordis.yml'), '[]\n')
  const patches = [
    { id: 'llm-pi-ai', config: { providers: { [route.provider]: { api: 'openai-completions', baseURL: gateway.url,
      apiKeyEnv: KEY_ENV, models: [{ id: route.model, contextWindow: 32768, maxTokens: 2048 }] } } } },
  ]
  if (candidate) {
    if (fileHash(candidate.path) !== candidate.sha256) fail('candidate-changed')
    const result = spawnSync(executable, ['plugin', '--profile', PROFILE, 'add', candidate.path, '--offline', '--ignore-scripts'], {
      cwd: root, env: { ...env, CFFIXED_USER_HOME: env.HOME }, stdio: 'ignore', timeout: 45_000,
    })
    if (result.status !== 0) fail('candidate-install-failed')
    const pkg = JSON.parse(readSafely(join(profile, 'package.json')))
    if (!pkg.dsh?.profile?.bundles?.includes('solopup-memory')) fail('candidate-plugin-unavailable')
    patches.push({ id: 'memory', config: { autoCapture: { enabled: false }, dream: { enabled: false } } })
  }
  if (mode === 'superagent') {
    if (fileHash(companion.bundle) !== companion.sha256) fail('prototype-bundle-changed')
    patches.push({ insert: [{ id: 'solopup-dream-companion', name: installedModule(root, 'scripts/dream-companion-plugin.mjs'), config: {
      dshCli: executable, prototypeBundle: companion.bundle, prototypeBundleSha256: companion.sha256,
      stateDir: join(env.DSH_HOME, 'dream-companion-state'),
    } }] })
  }
  patches.push({ insert: [{ id: name, name: import.meta.url }] })
  writeSafely(join(profile, 'cordis.patch.yml'), JSON.stringify(patches))
  return { ...env, CFFIXED_USER_HOME: env.HOME, [KEY_ENV]: gateway.localKey, SOLOPUP_DREAM_TRIAL_ROOT: root,
    ...(candidate ? { SOLOPUP_DREAM_TRIAL_INSTALLED: '1' } : {}) }
}

async function stopHost(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit').catch(() => undefined)
  child.kill('SIGTERM')
  await Promise.race([exited, delay(900)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(900)])
  }
}

export function createDshDreamTrialTransport({ cli = process.env.DSH_CLI ?? DEFAULT_CLI, baseURL, apiKey, timeoutMs = 95_000,
  candidateTgz, prototypeBundle, prototypeBundleSha256 } = {}) {
  if (!boundedInt(timeoutMs, 1, 110_000)) fail('invalid-timeout')
  const endpoint = configuredEndpoint(baseURL, apiKey)
  let executable
  try { executable = realpathSync(cli) } catch { fail('cli-unavailable') }
  let candidate, companion
  if (candidateTgz !== undefined) {
    try {
      const path = realpathSync(candidateTgz)
      candidate = { path, sha256: fileHash(path) }
    } catch { fail('candidate-unavailable') }
  }
  if (prototypeBundle !== undefined || prototypeBundleSha256 !== undefined) {
    if (!candidate || typeof prototypeBundle !== 'string' || typeof prototypeBundleSha256 !== 'string' || !HASH.test(prototypeBundleSha256)) fail('companion-configuration-required')
    try {
      const bundle = realpathSync(prototypeBundle)
      if (fileHash(bundle) !== prototypeBundleSha256) fail('prototype-bundle-changed')
      companion = { bundle, sha256: prototypeBundleSha256 }
    } catch { fail('prototype-bundle-unverified') }
  }
  const runs = []
  return {
    kind: endpoint ? 'real-model' : 'scripted',
    ...(candidate ? { candidateSha256: candidate.sha256 } : {}),
    ...(companion ? { prototypeBundleSha256: companion.sha256, prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE } : {}),
    proof() { return structuredClone(runs) },
    async execute(request) {
      const messages = verifyRequest(request)
      if (request.mode === 'superagent' && !companion) fail('companion-required')
      const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
      let gateway, child, hostResult, spawnFailed = false
      try {
        gateway = await startGateway(request, messages, { endpoint, apiKey, signal })
        const env = profileFiles(root, gateway, request.route, executable, candidate, companion, request.mode)
        const { signal: _signal, ...plainRequest } = request
        writeSafely(join(root, 'request.json'), JSON.stringify(plainRequest))
        child = spawn(executable, ['--profile', PROFILE], { cwd: root, env, stdio: 'ignore' })
        child.once('error', () => { spawnFailed = true })
        const responsePath = join(root, 'response.json')
        for (;;) {
          const raw = readSafely(responsePath, { maxBytes: 32 * 1024 })
          if (raw !== undefined) {
            const result = hostResult = JSON.parse(raw)
            if (result.ok !== true || result.prepared !== true || result.runId !== request.runId || result.mode !== request.mode || result.requestSha256 !== digest(messages) ||
                gateway.proof.status !== 'completed' || gateway.proof.calls !== 1 || !gateway.proof.verified) fail('host-result-unavailable')
            if (request.mode === 'superagent' && (!workerBinding(result.worker) || result.worker.prototypeCommit !== SUPER_AGENT_DREAM_PROTOTYPE ||
                !boundedInt(result.worker.modelChecks, 1, 8))) fail('worker-result-unbound')
            if (gateway.proof.models.size !== 1) fail('provider-model-unverified')
            const [reportedModel] = gateway.proof.models
            const { inputTokens, outputTokens } = result.usage ?? {}
            return { output: result.output, route: { provider: request.route.provider, model: reportedModel },
              ...(boundedInt(inputTokens, 0, Number.MAX_SAFE_INTEGER) && boundedInt(outputTokens, 0, Number.MAX_SAFE_INTEGER)
                ? { usage: { calls: gateway.proof.calls, inputTokens, outputTokens } } : {}) }
          }
          if (spawnFailed || child.exitCode !== null || child.signalCode !== null) fail('host-stopped')
          await delay(50, undefined, { signal })
        }
      } finally {
        if (gateway) runs.push({ runId: request.runId, mode: request.mode, requestSha256: digest(messages), calls: gateway.proof.calls,
          wireVerified: gateway.proof.verified, status: gateway.proof.status, providerReportedModels: [...gateway.proof.models],
          ...(gateway.proof.providerThinking ? { providerThinking: gateway.proof.providerThinking } : {}),
          ...(hostResult?.ok === false ? { hostCode: safeErrorCode(hostResult) } : {}),
          ...(hostResult?.ok === true && identifier(hostResult.hostNode) ? { hostNode: hostResult.hostNode } : {}),
          ...(request.mode === 'superagent' && workerBinding(hostResult?.worker) ? { worker: { ...workerBinding(hostResult.worker),
            modelChecks: hostResult.worker.modelChecks, prototypeCommit: SUPER_AGENT_DREAM_PROTOTYPE } } : {}) })
        await stopHost(child)
        await gateway?.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

function hostVersion(cli) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
  try {
    const result = spawnSync(cli, ['--version'], { env: probeEnvironment(root), encoding: 'utf8', timeout: 10_000 })
    const version = result.stdout?.trim()
    if (result.status !== 0 || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) fail('cli-version-unavailable')
    return version
  } finally { rmSync(root, { recursive: true, force: true }) }
}

async function main() {
  const { values } = parseArgs({ options: {
    loopback: { type: 'boolean' }, real: { type: 'boolean' }, 'receipt-dir': { type: 'string' },
    provider: { type: 'string' }, model: { type: 'string' }, 'base-url': { type: 'string' },
    dual: { type: 'boolean' }, tgz: { type: 'string' },
  } })
  if (values.loopback === values.real || !values['receipt-dir']) fail('usage')
  const real = values.real === true
  const apiKey = real ? process.env.SOLOPUP_DREAM_TRIAL_API_KEY : undefined
  if (real && (!values.provider || !values.model || !values['base-url'] || !apiKey)) fail('credential-unavailable')
  if (!real && (values.provider || values.model || values['base-url'])) fail('unexpected-provider-options')
  const prototypeBundle = values.dual ? process.env.SOLOPUP_DREAM_BUNDLE : undefined
  const prototypeBundleSha256 = values.dual ? process.env.SOLOPUP_DREAM_BUNDLE_SHA256 : undefined
  if (values.dual && (!prototypeBundle || !prototypeBundleSha256 || !values.tgz)) fail('companion-configuration-required')
  const cli = process.env.DSH_CLI ?? DEFAULT_CLI
  const transport = createDshDreamTrialTransport({ cli, baseURL: values['base-url'], apiKey,
    candidateTgz: values.tgz, prototypeBundle, prototypeBundleSha256 })
  const route = real ? { provider: values.provider, model: values.model } : LOOPBACK_ROUTE
  const result = await runDreamReviewTrial({ dir: values['receipt-dir'], route, transport, modes: values.dual ? ['ordinary', 'superagent'] : ['ordinary'], metadata: {
    hostVersion: hostVersion(cli), platform: `${process.platform}-${process.arch}`, profile: PROFILE,
    ...(transport.candidateSha256 ? { candidateSha256: transport.candidateSha256 } : {}),
    ...(transport.prototypeCommit ? { prototypeCommit: transport.prototypeCommit, bridgeVersion: transport.prototypeBundleSha256 } : {}),
  } })
  process.stdout.write(`${JSON.stringify({ status: result.status, hostVersion: result.receipt.metadata.hostVersion,
    transportKind: transport.kind, totals: result.receipt.totals, modelRoute: result.receipt.route,
    ...(transport.candidateSha256 ? { candidateSha256: transport.candidateSha256 } : {}),
    ...(transport.prototypeCommit ? { prototypeCommit: transport.prototypeCommit, prototypeBundleSha256: transport.prototypeBundleSha256 } : {}),
    semanticTruthEvaluated: false, wireProof: transport.proof() }, null, 2)}\n`)
  if (result.status !== 'selection-complete' && result.status !== 'complete') process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main() } catch (error) {
    const code = typeof error?.code === 'string' && /^dream-trial-(?:dsh-)?[a-z-]+$/.test(error.code) ? error.code : 'dream-trial-dsh-unavailable'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  }
}
