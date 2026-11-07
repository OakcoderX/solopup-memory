import test from 'node:test'
import assert from 'node:assert/strict'
import {memoryProtocol} from '../memory-protocol.mjs'
import {captureSourceAliases} from '../capture-source-aliases.mjs'
import {extractWithLlm} from '../capture-llm.mjs'
import {assessCandidate} from '../capture-evidence.mjs'

test('protocol reports scoped availability and remains available with no memory data', () => {
  const agent={session:{id:'owner'}}
  const text=memoryProtocol({tools:{schemas:scope=>{assert.equal(scope,agent);return [{name:'memory_write'}]}}},{agent})
  assert.match(text,/本轮调用正式 memory_write/)
  assert.match(text,/claim 只表示本人陈述/)
  assert.match(text,/pending-review 是待审/)
  assert.match(text,/不伪造 callHash/)
  assert.match(memoryProtocol({tools:{schemas:()=>[]}},{agent}),/当前会话未提供/)
  assert.equal(memoryProtocol({},{}),'')
  assert.match(memoryProtocol({}, {agent}),/未能核对/)
})

test('source labels are request-local and cannot collide with actual identifiers', () => {
  const messages=[{id:'source1',role:'user',text:'原话不变'},{id:'long-session:22',role:'assistant',text:'助手猜测'}]
  const mapped=captureSourceAliases(messages)
  assert.equal(mapped.messages[0].id,'_source1')
  const batch=mapped.restore({candidates:[{evidence:[{messageId:'_source1',quote:'原话不变'},{messageId:'source2',quote:'助手猜测'},{messageId:'unknown',quote:'未知'}]}],parserRejected:0})
  assert.deepEqual(batch.candidates[0].evidence.map(e=>e.messageId),['source1','long-session:22','unknown'])
  assert.equal(messages[0].id,'source1')
})

test('real extraction boundary binds short ids back before owner quote validation',async()=>{
  const quote='记住：验收角色沈沐出生于1990年5月12日，男性。'
  const messages=[{id:'session-synthetic:7177',role:'user',text:quote,hash:'a'.repeat(64)},
    {id:'session-synthetic:7179',role:'assistant',text:'我猜他出生于长沙。',hash:'b'.repeat(64)}]
  const llm={async prepareCall(config){return{config,async*stream(request){
    assert.match(request.messages[0].content[0].text,/"id":"source1"/)
    assert.doesNotMatch(request.messages[0].content[0].text,/session-synthetic:7177/)
    yield {type:'text-delta',text:JSON.stringify([{type:'user',scope:'global',basis:'explicit',meaning:{kind:'claim'},summary:quote,evidence:[{messageId:'source1',quote}]}])}
  }}}}
  const candidates=await extractWithLlm({llm,messages,indexLines:[]})
  assert.equal(candidates[0].evidence[0].messageId,messages[0].id)
  assert.equal(assessCandidate(candidates[0],messages,true).status,'eligible')
  for(const ref of [{messageId:messages[1].id,quote:messages[1].text},{messageId:'unknown',quote},{messageId:messages[0].id,quote:'他出生于长沙'}])
    assert.equal(assessCandidate({...candidates[0],evidence:[ref]},messages,true).reason,'invalid-user-evidence')
})
