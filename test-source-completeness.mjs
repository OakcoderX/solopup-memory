import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {captureMessage,assessCandidate} from './capture-evidence.mjs'
import {captureInputDescriptor,reconstructCaptureInput,listCaptureInputs} from './capture-inputs.mjs'
import {extractWithLlm} from './capture-llm.mjs'
import {apply} from './index.mjs'
import {candidateSnapshot} from './candidates.mjs'
import {captureJobStatus,listCaptureJobs} from './capture-jobs.mjs'
const prefix='甲'.repeat(2000),long=prefix+'但上述约定只在初稿反馈时适用，正式稿不采用。'
const event=text=>({seq:0,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}})
const shortMessage=()=>({...captureMessage(event(prefix),'synthetic:0'),seq:0}),longMessage=()=>({...captureMessage(event(long),'synthetic:0'),seq:0})
const options={everyTurns:1,maxEntries:3,maxTokens:800,maxInputBytes:24576,timeoutMs:25000},route={provider:'fixture',model:'fixture'}
const session={id:'synthetic',header:{createdAt:1},surface:{nodes:[0]},isOwnSeq:n=>n===0}
test('the complete boundary and a clipped prefix are distinguishable even when prefix hashes match',()=>{
 const short=shortMessage(),clipped=longMessage();assert.equal(short.sourceComplete,undefined);assert.equal(clipped.sourceComplete,false);assert.equal(short.hash,clipped.hash)
 const assistant=captureMessage({type:'assistant/message',data:{content:[{type:'text',text:long}]}},'assistant');assert.equal(assistant.sourceComplete,undefined)
})
test('a durable automatic source descriptor cannot accept an incomplete owner window',()=>{assert.throws(()=>captureInputDescriptor(session,[longMessage()],'/synthetic',options,route),/source-incomplete/)})
test('reconstruction rejects a changed hidden tail despite the same clipped-prefix hash',()=>{
 const d=captureInputDescriptor(session,[shortMessage()],'/synthetic',options,route)
 assert.throws(()=>reconstructCaptureInput(d,session,[event(long)],'/synthetic',options,route),/source-incomplete/)
})
test('direct automatic extraction refuses incomplete owner sources before prepareCall',async()=>{
 let calls=0;await assert.rejects(()=>extractWithLlm({messages:[longMessage()],llm:{prepareCall(){calls++;throw Error('must not dispatch')}}}),/source-incomplete/);assert.equal(calls,0)
})
test('a candidate cannot borrow a short unrelated source while hiding an incomplete earlier exception',()=>{
 const own={id:'short',role:'user',text:'跨所有项目，长期反馈先列两处问题再给办法。'},candidate={type:'user',scope:'global',basis:'explicit',summary:own.text,meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'}]},evidence:[{messageId:own.id,quote:own.text}]}
 assert.equal(assessCandidate(candidate,[longMessage(),own],false).reason,'incomplete-user-source')
})
test('automatic pipeline blocks before any model/queue claim and exposes the bounded refusal in status',async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'complete-source-'))),home=join(base,'home'),cwd=join(base,'project'),previous=process.env.DSH_HOME;mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 const handlers=[],effects=[];let calls=0;const root=join(home,'memory')
 try{
  apply({llm:{async listProviders(){return[route]},async prepareCall(){calls++;throw Error('must not dispatch')}},systemPrompt:{context(){}},workingDirectory:{get:()=>cwd},tools:{register(){}},on:(name,fn)=>handlers.push([name,fn]),effect:fn=>{const dispose=fn();if(typeof dispose==='function')effects.push(dispose)}},{autoCapture:{everyTurns:1}})
  const emit=e=>{for(const[name,fn]of handlers)if(name==='session/event')fn({id:'synthetic-long'},e)}
  emit(event(long));emit({type:'step/end',data:{}});await new Promise(r=>setTimeout(r,30))
  const state=JSON.parse(readFileSync(join(root,'.capture-state.json')));assert.equal(state.running,false);assert.equal(state.lastOutcome,'blocked');assert.equal(state.lastError,'capture-input-source-incomplete')
  assert.equal(calls,0);assert.equal(listCaptureInputs(root).inputs.length,0);assert.equal(listCaptureJobs(root).jobs.length,0);assert.equal(candidateSnapshot(root,'global').records.length,0)
  assert.equal(captureJobStatus(root).blockedInput.reason,'source-incomplete');assert.match(readFileSync(join(root,'.audit.jsonl'),'utf8'),/capture-input-blocked/)
 }finally{for(const dispose of effects.reverse())dispose();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
})
