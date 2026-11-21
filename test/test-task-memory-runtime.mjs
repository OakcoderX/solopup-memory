import { test } from 'node:test'
import assert from 'node:assert/strict'
import { trackTaskMemory } from '../task-memory-runtime.mjs'

function harness() {
  const callbacks = new Map()
  const tracker = trackTaskMemory({ on: (event, fn) => callbacks.set(event, fn) })
  return { ...tracker, emit: (session, event) => callbacks.get('session/event')(session, event),
    preStep: (session, turn, messages) => callbacks.get('agent/pre-step')({ agent: { session }, turn, messages }, () => {}) }
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
