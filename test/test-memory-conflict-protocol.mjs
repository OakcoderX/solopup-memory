import {test} from 'node:test'
import assert from 'node:assert/strict'
import {memoryProtocol} from '../memory-protocol.mjs'

test('conflict guidance accompanies the actual protocol with no write tool', () => {
  const result = memoryProtocol({tools:{schemas:()=>[]}}, {agent:{}})
  assert.match(result, /任务历史是当时的记录/)
  assert.match(result, /核对来源、适用范围和时间/)
  assert.match(result, /证据不足时说明不确定并询问用户/)
  assert.match(result, /不能声称已经保存/)
  assert.match(result, /未提供 memory_search/)
  assert.match(result, /不得声称已查过/)
})
test('reports available search and unknown availability separately', () => {
  assert.match(memoryProtocol({tools:{schemas:()=>[{name:'memory_search'}]}}, {agent:{}}), /已提供 memory_search/)
  assert.match(memoryProtocol({}, {agent:{}}), /memory_search 可用性未能核对/)
})
test('no agent receives no protocol', () => {
  assert.equal(memoryProtocol({}, {}), '')
})
test('read-only sessions omit write-only boilerplate while retaining conflict rules', () => {
  const readOnly = memoryProtocol({tools:{schemas:()=>[{name:'memory_search'}]}}, {agent:{}})
  const readWrite = memoryProtocol({tools:{schemas:()=>[{name:'memory_write'},{name:'memory_search'}]}}, {agent:{}})
  assert.doesNotMatch(readOnly, /星座推断|pending-review|callHash|每4轮/)
  assert.match(readWrite, /pending-review/)
  assert.match(readWrite, /不伪造 callHash/)
  assert.ok(Buffer.byteLength(readOnly) < Buffer.byteLength(readWrite) * 0.65)
})
