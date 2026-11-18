import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'

const [armArg, promptArg, mode, budgetArg] = process.argv.slice(2)
assert.ok(armArg && promptArg && ['mock', 'live'].includes(mode), 'Specify arm root, prompt file, mock/live, and budget in ms')
const arm = resolve(armArg)
const home = join(arm, 'home')
const tmp = join(arm, 'tmp')
const cwd = join(arm, 'checkout')
const profile = 'coding'
const profilePath = join(home, 'profiles', profile)
const app = '/Applications/DeepSeek Harness.app'
const cli = join(app, 'Contents/Resources/runtime/cli/bin/dsh')
const model = 'deepseek-flash'
const provider = 'deepseek-fixed'
const venv = process.env.SOLOPUP_EVAL_PYTHON
const relayKey = 'isolated-relay-only'
const maxOutputTokens = 6144
const maxRuntimeMs = Number(budgetArg)
assert.ok(Number.isInteger(maxRuntimeMs) && maxRuntimeMs >= 1_000 && maxRuntimeMs <= 1_200_000,
  'Budget must be 1 through 1,200 seconds')
const output = join(arm, 'run.json')
assert.ok(!existsSync(output), 'Each evaluation requires a fresh arm')
const pieces = [
  { id: 'session-title-llm', disabled: true },
  { id: 'telemetry', disabled: true },
  { id: 'tool-web', disabled: true },
  { id: 'web-search-deepseek', disabled: true },
  { id: 'web-deepseek-api', disabled: true },
  { id: 'web-fetch-http', disabled: true },
  { id: 'tool-plugin-manager', disabled: true },
  { id: 'tool-skill', disabled: true },
  { id: 'tool-subagent', disabled: true },
  { id: 'tool-subagent-fork', disabled: true },
  { id: 'tool-subagent-control', disabled: true },
  { id: 'tool-agent-team', disabled: true },
  { id: 'tool-workflow', disabled: true },
  { id: 'tool-goal', disabled: true },
]
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fixPaths = string => string.replaceAll(arm, '/BENCHMARK').replaceAll(provider, 'FIXED_PROVIDER')
const jsonBytes = value => Buffer.from(JSON.stringify(value))
const prompt = readFileSync(resolve(promptArg), 'utf8')
const profilePackage = JSON.parse(readFileSync(join(profilePath, 'package.json'), 'utf8'))
const enabled = profilePackage.dsh.profile.bundles.includes('solopup-memory')
const key = mode === 'live' ? readFileSync(0, 'utf8').trim() : undefined
if (mode === 'live') assert.ok(key?.length >= 12 && !/\s/.test(key), 'DeepSeek credential unavailable on stdin')
const baseCommand = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
assert.equal(baseCommand.status, 0, 'Git baseline unavailable')
const base = baseCommand.stdout.trim()
const metadata = {
  mode, enabled, state: 'starting', base, promptSha256: sha256(prompt),
  provider, model, temperature: 0, thinking: false, maxOutputTokens, maxRuntimeMs,
  sandbox: 'external macOS Seatbelt: one arm checkout and one relay',
  requests: [], toolCalls: [], turnEnds: [],
}
const shellMode = 'danger-full-access'

function save() { writeFileSync(output, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 }) }
function resultSse(response, message, finishReason = 'stop') {
  const id = 'coding-preflight'
  const delta = { ...message }
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }))
  const frame = choices => 'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, choices }) + '\n\n'
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(frame([{ index: 0, delta, finish_reason: null }]) +
    frame([{ index: 0, delta: {}, finish_reason: finishReason }]) + 'data: [DONE]\n\n')
}
function mock(response, row, body) {
  if (row.index > 2) return resultSse(response, { role: 'assistant', content: 'DSH_PAIR_PREFLIGHT_COMPLETE' })
  if (row.index === 2) {
    const tool = body.tools?.find(entry => entry.function?.name === 'write')
    const props = tool?.function.parameters.properties ?? {}
    const pathKey = ['path', 'file_path', 'filePath'].find(key => props[key])
    assert.ok(pathKey && props.content, 'The native write argument shape changed')
    const args = {
      [pathKey]: '.pair_artifact',
      content: 'Controlled mock write.\n',
      ...(props.description && { description: 'Verify native file write' }),
    }
    return resultSse(response, { role: 'assistant', tool_calls: [{
      id: 'native-write-check', type: 'function', function: { name: 'write', arguments: JSON.stringify(args) },
    }] }, 'tool_calls')
  }
  const bash = body.tools?.find(tool => tool.function?.name === 'bash')
  assert.ok(bash, 'The origin request lacks native Bash')
  const options = bash.function.parameters.properties
  const args = {
    command: [
      "test -f ../outside-read",
      "if /bin/cat ../outside-read > /dev/null 2>&1; then echo OUTSIDE_READ; exit 1; fi",
      "if printf '%s\\n' no > ../escape-write; then echo OUTSIDE_WRITE; exit 1; fi",
      "if /usr/bin/curl --noproxy '*' -sSf --connect-timeout 2 http://1.1.1.1 > /dev/null 2>&1; then echo OUTSIDE_NETWORK; exit 1; fi",
      "printf '%s\\n' ok > .pair_sandbox_check",
    ].join('; '),
    ...(options.description && { description: 'Verify workspace permissions' }),
  }
  resultSse(response, { role: 'assistant', tool_calls: [{
    id: 'shell-check', type: 'function', function: { name: 'bash', arguments: JSON.stringify(args) },
  }] }, 'tool_calls')
}
function captureSse(row, source) {
  let lines = ''
  return async function* () {
    for await (const chunk of source) {
      lines += Buffer.from(chunk).toString('utf8')
      let boundary
      while ((boundary = lines.indexOf('\n')) !== -1) {
        const line = lines.slice(0, boundary).trim()
        lines = lines.slice(boundary + 1)
        if (!line.startsWith('data: {')) continue
        try {
          const data = JSON.parse(line.slice(6))
          row.servedModel ??= data.model
          if (data.usage) row.usage = data.usage
          const finish = data.choices?.map(choice => choice.finish_reason).filter(Boolean)
          if (finish?.length) row.finish = finish
        } catch {}
      }
      yield chunk
    }
  }()
}

const sourcesPath = join(arm, 'memory-evidence.json')
const sourceChecks = existsSync(sourcesPath) ? JSON.parse(readFileSync(sourcesPath, 'utf8')) : []
const connections = new Set()
const relay = createServer(async (request, response) => {
  const started = Date.now()
  const row = { index: metadata.requests.length + 1 }
  metadata.requests.push(row)
  try {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer ' + relayKey)
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      assert.ok(size <= 16_000_000, 'Request exceeded byte limit')
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks))
    assert.equal(body.model, model, 'DSH requested a different model')
    assert.equal(body.stream, true, 'DSH unexpectedly requested nonstreaming response')
    const messages = JSON.stringify(body.messages)
    row.roleCounts = Object.fromEntries(['system', 'user', 'assistant', 'tool'].map(role =>
      [role, body.messages.filter(message => message.role === role).length]))
    row.tools = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean)
    assert.ok(!row.tools.some(name => ['web_search', 'web_fetch', 'subagent', 'subagent_fork'].includes(name)),
      'Unexpected browsing or subagent tool is present')
    row.messageBytes = Buffer.byteLength(messages)
    row.normalizedMessageSha256 = sha256(fixPaths(messages))
    const hits = sourceChecks.filter(source => messages.includes(source.text) ||
      messages.includes(JSON.stringify(source.text).slice(1, -1)))
    row.exactSourceHits = hits.map(source => ({ id: source.id, sha256: sha256(source.text) }))
    row.memoryContext = /memory:index|<memory-store\b|SoloPup Memory|memory\/projects/iu.test(messages)
    row.effectiveView = messages.includes('以下是带来源的记忆约定')
    row.reviewCue = messages.includes('SoloPup 交付复核。一次性插件提示。')
    const present = text => body.messages.some(message => message.role === 'user' &&
      (typeof message.content === 'string' && message.content.includes(text) ||
        Array.isArray(message.content) &&
        message.content.some(block => typeof block.text === 'string' && block.text.includes(text))))
    row.promptPresent = present(prompt.trimEnd())
    row.toolOutcome = body.messages.filter(message => message.role === 'tool').slice(-1).map(message => ({
      bytes: Buffer.byteLength(JSON.stringify(message.content)),
      sha256: sha256(fixPaths(JSON.stringify(message.content))),
    }))
    if (row.index === 1) {
      // Keep the source excerpts on the local lab only, separately from the shareable hashes.
      writeFileSync(join(arm, 'first-request.private.json'), JSON.stringify(body.messages, null, 2) + '\n', { mode: 0o600 })
      assert.ok(row.promptPresent, 'Native request omitted the task prompt')
    }
    save()
    if (mode === 'mock') return mock(response, row, body)
    const upstream = {
      ...body, model, temperature: 0, max_tokens: maxOutputTokens, thinking: { type: 'disabled' },
      stream_options: { include_usage: true },
    }
    delete upstream.reasoning_effort
    const result = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(155_000),
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(upstream),
    })
    row.upstreamStatus = result.status
    if (!result.ok) {
      await result.body?.cancel()
      throw Error('DeepSeek HTTP ' + result.status)
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    await new Promise((done, reject) => {
      const stream = Readable.from(captureSse(row, result.body))
      stream.once('error', reject)
      response.once('finish', done)
      response.once('close', () => { stream.destroy(); done() })
      stream.pipe(response)
    })
  } catch (error) {
    row.error = error.message.replace(/Bearer [^\s]+/g, 'Bearer [redacted]')
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
    if (!response.writableEnded) response.end(JSON.stringify({ error: { message: 'Isolated provider request failed' } }))
  } finally {
    row.elapsedMs = Date.now() - started
    save()
  }
})
relay.on('connection', socket => {
  connections.add(socket)
  socket.once('close', () => connections.delete(socket))
})
await new Promise((done, reject) => {
  relay.once('error', reject)
  relay.listen(0, '127.0.0.1', done)
})
const port = relay.address().port
pieces.push(
  { id: 'agent-default-model', config: { provider, model } },
  { id: 'llm-pi-ai', config: { providers: { [provider]: {
    api: 'openai-completions', baseURL: 'http://127.0.0.1:' + port + '/v1', apiKeyEnv: 'CATTRS_RELAY_KEY',
    models: [{ id: model, contextWindow: 128_000, maxTokens: maxOutputTokens }],
  } } } },
)
// Leave the installed memory recall path active, and hold background side effects fixed.
if (enabled) pieces.push({ id: 'memory', config: { autoCapture: { enabled: false }, dream: { enabled: false } } })
writeFileSync(join(profilePath, 'cordis.patch.yml'), JSON.stringify(pieces) + '\n', { mode: 0o600 })

const sbPath = join(arm, 'scope.sb')
const visible = [cwd, home, tmp, ...(venv ? [venv] : [])].map(path => '(subpath ' + JSON.stringify(path) + ')').join(' ')
const writable = [cwd, home, tmp].map(path => '(subpath ' + JSON.stringify(path) + ')').join(' ')
writeFileSync(sbPath, `(version 1)
(allow default)
(deny file-read-data
  (require-all (require-any (subpath "/Users") (subpath "/private/tmp") (subpath "/Volumes"))
    (require-not (require-any ${visible}))))
(deny file-write*
  (require-not (require-any (literal "/dev/null") ${writable})))
(deny network-outbound (require-not (remote tcp "localhost:${port}")))
(deny network-inbound)
`, { mode: 0o600 })
const env = {
  PATH: [venv && join(venv, 'bin'), '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'].filter(Boolean).join(':'),
  HOME: home, DSH_HOME: home,
  USERPROFILE: home, CFFIXED_USER_HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', CATTRS_RELAY_KEY: relayKey,
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', PYTHONPATH: 'src',
  PYTHONDONTWRITEBYTECODE: '1', HYPOTHESIS_STORAGE_DIRECTORY: join(tmp, 'hypothesis'),
}
const child = spawn('/usr/bin/sandbox-exec', [
  '-f', sbPath, cli, '--profile', profile, '--json', '--permission-mode', shellMode,
  '--approval-policy', 'never', '-',
], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
const stdinDone = new Promise(done => child.stdin.once('error', done))
child.stdin.end(prompt)
createInterface({ input: child.stdout }).on('line', line => {
  let row
  try { row = JSON.parse(line) } catch { return }
  const event = row.event ?? row.params?.event ?? row
  const type = event.type ?? row.type
  const data = event.data ?? row.data ?? event
  if (type === 'session') metadata.sessionId = row.sessionId
  if (type === 'tool_call') metadata.toolCalls.push({ name: row.tool, id: row.callId })
  if (type === 'tool_result') {
    const call = metadata.toolCalls.find(item => item.id === row.callId)
    if (call) call.status = row.status
  }
  if (type === 'turn/end' || type === 'status' && row.phase === 'turn_end') {
    metadata.turnEnds.push({ reason: data.reason, turn: row.turn })
  }
  if (type === 'final') {
    const answer = String(row.text ?? '')
    metadata.final = { reason: row.reason, textBytes: Buffer.byteLength(answer), textSha256: sha256(answer) }
    writeFileSync(join(arm, 'final.private.txt'), answer, { mode: 0o600 })
  }
  if (mode === 'mock') writeFileSync(join(arm, 'last-event.private.log'), line + '\n', { mode: 0o600, flag: 'a' })
})
let stderr = ''
child.stderr.on('data', buffer => { stderr = (stderr + buffer).slice(-5000) })
let timeout = false
let killTimer
const timer = setTimeout(() => {
  timeout = true
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  killTimer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }, 5000)
}, maxRuntimeMs)
const error = await Promise.race([
  new Promise(done => {
    child.once('error', launchError => done({ error: launchError.message }))
    child.once('close', (code, signal) => done({ code, signal }))
  }),
  stdinDone.then(() => new Promise(done => child.once('close', (code, signal) => done({ code, signal })))),
])
clearTimeout(timer)
clearTimeout(killTimer)
for (const socket of connections) socket.destroy()
await new Promise(done => relay.close(done))
metadata.exit = error
metadata.stderrTail = stderr
metadata.timeout = timeout
const nonzero = error.code !== 0 || timeout || !metadata.requests.length || metadata.final?.reason.kind !== 'completed' ||
  metadata.requests.some(row => row.error) || metadata.turnEnds.some(row => row.reason?.kind === 'error')
const mockOK = mode !== 'mock' || existsSync(join(cwd, '.pair_sandbox_check')) &&
  existsSync(join(cwd, '.pair_artifact')) && !existsSync(join(arm, 'escape-write'))
metadata.state = !nonzero && mockOK ? 'completed' : 'failed'
if (mode === 'mock') metadata.mockWorkspaceAccessVerified = mockOK
metadata.pluginLoaded = existsSync(join(home, 'memory', '.loaded.json'))
save()
console.log(JSON.stringify({ state: metadata.state, requests: metadata.requests.length,
  toolCalls: metadata.toolCalls.length, turnEnds: metadata.turnEnds.length, output }))
process.exitCode = metadata.state === 'completed' ? 0 : 1
