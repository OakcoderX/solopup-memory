import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineMemoryReceiptTool, trackTaskMemory } from '../task-memory-runtime.mjs'

function harness() {
  const callbacks = new Map()
  const tracker = trackTaskMemory({ on: (event, fn) => callbacks.set(event, fn) })
  return { ...tracker, emit: tracker.event,
    preStep: (session, turn, messages, step) => callbacks.get('agent/pre-step')({ agent: { session }, turn, step, messages }, () => {}) }
}

function message(text, kind = 'user') {
  return { type: 'user/message', surfaceOp: 'append', data: {
    role: 'user', source: { kind }, content: [{ type: 'text', text }],
  } }
}

test('tracks both ends of long owner instructions, ignoring plugin messages and closing scope', () => {
  const tracker = harness()
  const session = { id: 'current' }
  tracker.emit(session, { type: 'turn/start', data: { turn: 2 } })
  tracker.preStep(session, 2, [message(`Chapter seven\n${'a'.repeat(5500)}\nKeep the final paragraph.`).data])
  tracker.preStep(session, 2, [message('Replace the task.', 'plugin').data])
  assert.match(tracker.queryFor(session), /^Chapter seven/)
  assert.match(tracker.queryFor(session), /Keep the final paragraph\.$/)
  assert.ok(tracker.queryFor(session).length < 4200)
  tracker.emit(session, { type: 'turn/end', data: { turn: 2 } })
  assert.equal(tracker.queryFor(session), '')
})

test('only a single, literal first-line edition declaration in a direct owner message selects a draft', () => {
  const tracker = harness()
  const session = { id: 'writer' }
  tracker.emit(session, { type: 'turn/start', data: { turn: 1 } })
  const submit = (...messages) => {
    tracker.preStep(session, 1, messages)
    return tracker.contextFor(session)
  }
  const direct = text => message(text).data
  for (const text of [
    '请比较两个版本\n本轮稿本：审读版', '> 本轮稿本：审读版', '    Current edition: Draft',
    '```\nCurrent edition: Draft\n```', '本轮稿本：“审读版”',
    '本轮稿本：审读版\n' + 'a'.repeat(4200) + '\nCurrent edition: Trial\n' + 'b'.repeat(4200),
    '本轮稿本：审\u200b读版', '本轮稿本：审读版\n' + 'a'.repeat(65536),
  ]) assert.deepEqual(submit(direct(text)), {})
  assert.deepEqual(submit(direct('本轮稿本：审读版\r\n\r\n写第七章')), { edition: '审读版' })
  assert.deepEqual(submit(message('Current edition: Trial', 'plugin').data), { edition: '审读版' })
  assert.deepEqual(submit(direct('Current edition: Editor copy v2.1\nRevise chapter seven.')), { edition: 'Editor copy v2.1' })
  assert.deepEqual(submit(direct('本轮稿本：甲'), direct('本轮稿本：乙')), {})
  assert.deepEqual(submit({ ...direct('本轮稿本：乙'), source: { kind: 'user', principal: 'worker' } }), {})
  assert.deepEqual(submit({ ...direct('本轮稿本：乙'), role: 'assistant' }), {})
  const worker = { id: 'worker', header: { origin: 'subagent' } }
  tracker.emit(worker, { type: 'turn/start', data: { turn: 1 } })
  tracker.preStep(worker, 1, [direct('本轮稿本：审读版')])
  assert.deepEqual(tracker.contextFor(worker), {})
})

test('the selected draft expires on a directory change or the next turn, including replay of the old message', () => {
  const tracker = harness()
  const session = { id: 'writer' }
  const input = [message('Current edition: Reading').data]
  tracker.emit(session, { type: 'turn/start', data: { turn: 1 } })
  tracker.preStep(session, 1, input)
  assert.deepEqual(tracker.contextFor(session), { edition: 'Reading' })
  tracker.emit(session, { type: 'working-directory/change', data: {} })
  tracker.preStep(session, 1, input)
  assert.deepEqual(tracker.contextFor(session), {})
  tracker.emit(session, { type: 'turn/start', data: { turn: 2 } })
  tracker.preStep(session, 1, input)
  assert.deepEqual(tracker.contextFor(session), {})
  tracker.preStep(session, 2, input)
  assert.deepEqual(tracker.contextFor(session), { edition: 'Reading' })
  tracker.emit(session, { type: 'turn/start', data: { turn: 3 } })
  tracker.preStep(session, 3, [])
  assert.deepEqual(tracker.contextFor(session), {})
  tracker.preStep(session, 3, [message('Continue the same chapter.').data])
  assert.deepEqual(tracker.contextFor(session), {})
  tracker.emit(session, { type: 'turn/end', data: { turn: 3 } })
  assert.deepEqual(tracker.contextFor(session), {})
})

test('reports work only for a matched successful mutation in the open turn', () => {
  const tracker = harness()
  const session = { id: 'current' }
  tracker.emit(session, { type: 'turn/start', data: { turn: 1 } })
  const call = (name, seq, args) => tracker.emit(session, { type: 'tool/call', seq, data: {
    turn: 1, callId: `call-${seq}`, name, arguments: args,
  } })
  const result = (seq, isError = false) => tracker.emit(session, { type: 'tool/result', surfaceOp: 'append',
    sourceEventSeqs: [seq], data: { turn: 1, message: {
      role: 'tool', source: { kind: 'tool', callId: `call-${seq}` }, toolCallId: `call-${seq}`, isError,
    } },
  })
  call('bash', 1, { command: 'git diff' })
  result(1)
  call('write', 2)
  result(2, true)
  assert.equal(tracker.hasAppliedWork(session, 1), false)
  call('edit', 3)
  result(3)
  assert.equal(tracker.hasAppliedWork(session, 1), true)
  tracker.emit(session, { type: 'working-directory/change', data: {} })
  assert.equal(tracker.hasAppliedWork(session, 1), false)
  call('bash', 4, JSON.stringify({ command: 'git add . && git commit -m fixed' }))
  result(4)
  assert.equal(tracker.hasAppliedWork(session, 1), true)
})

test('detects successful project heredoc writes without treating read arguments or temporary files as work', () => {
  const tracker = harness()
  const session = { id: 'current' }
  tracker.emit(session, { type: 'turn/start', data: { turn: 1 } })
  const bash = (seq, command, isError = false) => {
    const callId = `bash-${seq}`
    tracker.emit(session, { type: 'tool/call', seq, data: { turn: 1, callId, name: 'bash', arguments: { command } } })
    tracker.emit(session, {
      type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [seq], data: { turn: 1, message: {
        role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError,
      } },
    })
  }
  bash(1, "printf '%s' 'cat > draft.md <<EOF'")
  bash(2, "cat >/tmp/draft.md <<'EOF'\nscratch\nEOF")
  bash(3, "cat > ../draft.md <<'EOF'\nelsewhere\nEOF")
  bash(4, "cat > draft.md <<'EOF'\nfailed\nEOF", true)
  assert.equal(tracker.hasAppliedWork(session, 1), false)
  bash(5, "cat <<'EOF' > 小说初稿.md\n" + 'a'.repeat(9000) + "\nEOF")
  assert.equal(tracker.hasAppliedWork(session, 1), true)
})

test('detects workspace_bash mutations and MCP write tools while ignoring read-only MCP calls', () => {
  const tracker = harness()
  const session = { id: 'mcp-and-ws' }
  tracker.emit(session, { type: 'turn/start', data: { turn: 1 } })
  const run = (seq, name, args) => {
    const callId = `c-${seq}`
    tracker.emit(session, { type: 'tool/call', seq, data: { turn: 1, callId, name, arguments: args } })
    tracker.emit(session, {
      type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [seq], data: { turn: 1, message: {
        role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: false,
      } },
    })
  }
  run(1, 'mcp__teams__list_users', {})
  run(2, 'workspace_bash', { command: 'git status' })
  assert.equal(tracker.hasAppliedWork(session, 1), false)
  run(3, 'workspace_bash', { command: "cd /workspace && cat <<'EOF' > solution.py\nprint(1)\nEOF" })
  assert.equal(tracker.hasAppliedWork(session, 1), true)

  const mcpSession = { id: 'mcp-write' }
  tracker.emit(mcpSession, { type: 'turn/start', data: { turn: 1 } })
  tracker.emit(mcpSession, { type: 'tool/call', seq: 10, data: { turn: 1, callId: 'm-1', name: 'mcp__teams__create_call', arguments: {} } })
  tracker.emit(mcpSession, {
    type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [10], data: { turn: 1, message: {
      role: 'tool', source: { kind: 'tool', callId: 'm-1' }, toolCallId: 'm-1', isError: false,
    } },
  })
  assert.equal(tracker.hasAppliedWork(mcpSession, 1), true)
})

test('receipts separate a pending save, a checked request, a tool response and a file fingerprint', () => {
  const tracker = harness()
  const session = { id: 'writer', header: { cwd: '/private/project' } }
  const receipt = defineMemoryReceiptTool(tracker)
  const execute = (view, caller = session) => receipt.execute({ view }, { agent: { session: caller } })
  const id = 'a'.repeat(64), candidateId = 'b'.repeat(64), sha256 = 'd'.repeat(64)
  tracker.emit(session, { type: 'turn/start', data: { turn: 7 } })
  tracker.preStep(session, 7, [message('内容不应出现在回执。').data], 2)
  assert.equal(execute('current').context, undefined)
  tracker.observeContext(session, sha256, [{ id, scope: 'project', applicability: 'applicable' }])
  const observed = tracker.begin(session)
  observed.write('project', { status: 'pending-review', candidateId, recordId: id, indexLine: '内容不应出现在回执。' })
  observed.write('project', { status: 'recorded', recordId: id })
  observed.source({ status: 'verified', recordId: id, scope: 'project', sources: [{ sha256, seq: 5, quote: '内容不应出现在回执。' }] })
  observed.file({ status: 'matched', recordId: id, sha256, path: '/private/project/终稿.md' })
  tracker.emit(session, { type: 'tool/call', seq: 20, data: { name: 'write', turn: 7, callId: 'write-file' } })
  tracker.emit(session, { type: 'tool/result', seq: 21, surfaceOp: 'append', sourceEventSeqs: [20],
    data: { turn: 7, message: { role: 'tool', source: { kind: 'tool', callId: 'write-file' }, toolCallId: 'write-file',
      content: [{ type: 'text', text: '内容不应出现在回执。' }] } } })
  const current = execute('current')
  assert.equal(current.status, 'observed')
  assert.deepEqual(current.context, { phase: 'request-validated', step: 2, sha256,
    rules: [{ recordId: id, scope: 'project', applicability: 'applicable' }] })
  assert.deepEqual(current.writes, [{ scope: 'project', status: 'pending-review', candidateId },
    { scope: 'project', status: 'recorded', recordId: id }])
  assert.deepEqual(current.sources, [{ recordId: id, scope: 'project', pointers: [{ sha256, seq: 5 }] }])
  assert.deepEqual(current.delivery[0], { kind: 'file-checked', status: 'matched', recordId: id, sha256 })
  assert.equal(current.delivery[1].kind, 'tool-result-observed')
  assert.notEqual(current.delivery[1].sha256, sha256)
  assert.doesNotMatch(JSON.stringify(current), /private|内容不应|终稿/u)
  assert.deepEqual(execute('current', { id: session.id, header: session.header }), { status: 'unavailable' })
  tracker.emit(session, { type: 'turn/end', data: { turn: 7 } })
  tracker.emit(session, { type: 'turn/start', data: { turn: 8 } })
  observed.file({ status: 'mismatch', recordId: id, sha256 })
  assert.deepEqual(execute('previous'), { ...current, view: 'previous' })
  assert.deepEqual(execute('current').delivery, [])
  session.header.cwd = '/private/other'
  tracker.emit(session, { type: 'working-directory/change' })
  assert.deepEqual(execute('previous'), { status: 'unavailable' })
  assert.equal(execute('current').context, undefined)
})

test('six most recent entries per phase bound the receipt deterministically', () => {
  const tracker = harness(), session = { id: 'writer', header: { cwd: '/workspace' } }
  tracker.emit(session, { type: 'turn/start', data: { turn: 1 } })
  const record = tracker.begin(session)
  for (let seq = 0; seq < 10; seq++) {
    record.file({ status: 'matched', recordId: 'a'.repeat(64), sha256: seq.toString().padStart(64, '0') })
  }
  const receipt = tracker.receiptFor(session, 'current')
  assert.equal(receipt.truncated, true)
  assert.equal(receipt.delivery.length, 6)
  assert.deepEqual(receipt.delivery.map(item => Number(item.sha256)), [4, 5, 6, 7, 8, 9])
})
