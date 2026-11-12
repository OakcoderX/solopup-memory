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
