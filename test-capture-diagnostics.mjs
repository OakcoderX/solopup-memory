import {applyWithValidationFixture as apply} from './fixture-host.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {parseCaptureBatch,buildCaptureDiagnostic,normalizeCaptureDiagnostic,captureDiagnosticOutcome,CAPTURE_RESPONSE_BYTES} from './capture-diagnostics.mjs'
import {extractWithLlm} from './capture-llm.mjs'
import {searchStore, indexLine} from './index.mjs'
import {listCaptureJobs,captureJobStatus,claimCaptureJob,finishCaptureJob} from './capture-jobs.mjs'
import {writeFixtureMemory} from './fixture-host.mjs'
const item=(n=1)=>({type:'user',summary:'持久有效的测试条目'+n})
test('an explicit empty array is a model-reported no-op, never proof that no durable information exists',()=>{
 const batch=parseCaptureBatch('[]',3),d=buildCaptureDiagnostic(batch)
 assert.equal(d.classification,'model-noop');assert.equal(d.responseValid,true);assert.equal(d.responseItems,0);assert.equal(d.semanticCompletenessVerified,false);assert.equal(captureDiagnosticOutcome(d),'ok')
 const wrapped=buildCaptureDiagnostic(parseCaptureBatch('说明\n```json\n[]\n```\n结束',3));assert.equal(wrapped.wrapped,true);assert.equal(wrapped.semanticCompletenessVerified,false)
})
test('object envelopes, quoted arrays, prose and multiple responses cannot masquerade as empty capture',()=>{
 for(const body of ['{"error":[]}','"[]"','null','没有记录 []','[][]','```json\n[]\n```\n```json\n[]\n```'])assert.throws(()=>parseCaptureBatch(body,3),/capture-invalid-json|capture-invalid-envelope/)
 assert.throws(()=>parseCaptureBatch('',3),/capture-empty-response/)
})
test('parser rejection retains counts and safe reasons when every candidate is filtered',()=>{
 const batch=parseCaptureBatch(JSON.stringify([null,[],{type:'nope',summary:'不合类型的测试内容'},{type:'user',summary:10},{type:'user',summary:'短'},{type:'user',summary:'有效长度的标题',detail:{}},{type:'user',summary:'secret sk-'+'a'.repeat(32)}]),3)
 const d=buildCaptureDiagnostic(batch);assert.equal(d.classification,'parser-rejected');assert.equal(d.responseItems,7);assert.equal(d.parserRejected,7);assert.equal(d.parsedItems,0);assert.equal(captureDiagnosticOutcome(d),'rejected');assert.ok(d.codes.some(row=>row.code==='secret'))
 assert.ok(!JSON.stringify(d).includes('secret sk-'));assert.ok(!JSON.stringify(d).includes('不合类型'))
})
test('mixed parser rejection and output limits are visible while valid candidates remain available',()=>{
 const batch=parseCaptureBatch(JSON.stringify([null,item(1),item(2),item(3),item(4)]),2)
 assert.equal(batch.candidates.length,2);assert.equal(batch.deferred,2);assert.equal(batch.parserRejected,1)
 const d=buildCaptureDiagnostic(batch,{inserted:2});assert.equal(d.classification,'partial');assert.equal(d.responseItems,5);assert.equal(captureDiagnosticOutcome(d),'partial')
})
test('responses and item cardinality have hard limits instead of silent unbounded parsing',()=>{
 assert.throws(()=>parseCaptureBatch(JSON.stringify(Array.from({length:65},(_,i)=>item(i))),3),/capture-too-many-items/)
 assert.throws(()=>parseCaptureBatch(' '.repeat(CAPTURE_RESPONSE_BYTES)+'[]',3),/capture-response-too-large/)
 const state=parseCaptureBatch(JSON.stringify(Array.from({length:64},(_,i)=>item(i))),3);assert.equal(state.deferred,61)
})
test('streamed response size failure is typed, bounded and never retried as an empty no-op',async()=>{
 let calls=0
 const llm={async prepareCall(){calls++;return{config:{},async *stream(){yield{type:'text-delta',text:'x'.repeat(CAPTURE_RESPONSE_BYTES+1)}}}}}
 await assert.rejects(extractWithLlm({llm,messages:[],indexLines:[],includeDiagnostics:true}),error=>error.message==='capture-response-too-large');assert.equal(calls,1)
})
test('diagnostic enums, accounting and negative epistemic boundary cannot be forged by arbitrary metadata',()=>{
 const d=buildCaptureDiagnostic(parseCaptureBatch('[]',3))
 for(const patch of [{prompt:'PRIVATE'},{semanticCompletenessVerified:true},{responseItems:1},{classification:'recorded'},{codes:[{code:'PRIVATE_OUTPUT',count:1}]}])assert.throws(()=>normalizeCaptureDiagnostic({...d,...patch}),/capture-diagnostic-invalid/)
 const failure=buildCaptureDiagnostic(undefined,{},'capture-empty-response');assert.equal(failure.classification,'response-error');assert.equal(failure.responseValid,false);assert.equal(captureDiagnosticOutcome(failure),'error')
})
async function box(run){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-capture-diagnostic-'))),home=join(base,'home'),cwd=join(base,'project'),previous=process.env.DSH_HOME;mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 try{await run({base,home,cwd,root:join(home,'memory')})}finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
}
async function capture(f,payload){
 const handlers=[],tools=[],disposers=[];let calls=0
 const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},async prepareCall(){calls++;return{config:{},async *stream(request){
  const message=request.messages[0].content[0].text.split('\n').flatMap(line=>{try{const d=JSON.parse(line);return d.role==='user'?[d]:[]}catch{return[]}}).at(-1)
  const candidate={type:'user',scope:'global',meaning:{kind:'claim'},basis:'explicit',summary:'以后检索优先核对本次实际依据',evidence:[{messageId:message.id,quote:message.text}]}
  const body=typeof payload==='function'?await payload(candidate,request):payload
  if(body!==undefined)yield{type:'text-delta',text:typeof body==='string'?body:JSON.stringify(body)}
 }}}}
 const ctx={llm,systemPrompt:{context(){}},workingDirectory:{get(){return f.cwd}},tools:{register(tool){tools.push(tool)}},on(name,handler){handlers.push([name,handler])},effect(fn){const stop=fn();if(typeof stop==='function')disposers.push(stop)}}
 apply(ctx,{autoCapture:{everyTurns:1}})
 const session={id:'diagnostic-capture'},emit=event=>{for(const [name,handler]of handlers)if(name==='session/event')handler(session,event)}
 try{
  emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text:'以后跨项目检索时优先核对实际依据，并长期保留这项约定。'}]}}});emit({type:'step/end',data:{}})
  const stateFile=join(f.root,'.capture-state.json'),until=Date.now()+5000;let state
  while(Date.now()<until){state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile)):undefined;if(state?.lastCaptureAt&&!state.running)break;await new Promise(resolve=>setTimeout(resolve,20))}
  assert.equal(state?.running,false)
  const jobs=listCaptureJobs(f.root);return{state,job:jobs.jobs.find(job=>job.id===state.jobId),calls,tools}
 }finally{for(const dispose of disposers)dispose()}
}
test('all parser-rejected items persist as failure and remain distinguishable through a fresh ledger/status read',()=>box(async f=>{
 const value=await capture(f,[{type:'not-memory',summary:'PRIVATE_FILTERED_PAYLOAD'}]);assert.equal(value.state.lastOutcome,'rejected');assert.equal(value.state.lastError,'capture-parser-rejected');assert.equal(value.job.status,'failed');assert.equal(value.job.diagnostic.classification,'parser-rejected');assert.deepEqual(value.job.counts,{proposed:1,inserted:0,staged:0,rejected:1})
 const status=captureJobStatus(f.root);assert.equal(status.latest.diagnostic.parserRejected,1);assert.equal(status.semanticCompletenessVerified,false)
 for(const name of ['.capture-state.json','.capture-jobs.json','.audit.jsonl'])assert.ok(!readFileSync(join(f.root,name),'utf8').includes('PRIVATE_FILTERED_PAYLOAD'))
 const tool=value.tools.find(tool=>tool.name==='memory_status'),data=await tool.execute({scope:'global'},{});assert.equal(data.capture.latest.diagnostic.classification,'parser-rejected');assert.match(tool.output.render({},data)[0].text,/解析拒绝1/)
}))
test('mixed invalid/valid capture writes the valid memory and reports partial rather than full success',()=>box(async f=>{
 const value=await capture(f,candidate=>[null,candidate]);assert.equal(value.state.lastOutcome,'partial');assert.equal(value.job.diagnostic.classification,'partial');assert.equal(value.job.diagnostic.inserted,1);assert.equal(value.job.diagnostic.parserRejected,1);assert.equal(searchStore(f.root,'实际依据').hits.length,1)
}))
test('admission rejection, true no-op, empty provider output and pre-validation source changes stay separate',async()=>{
 for(const variant of ['admission','noop','empty','write'])await box(async f=>{
  const payload=variant==='noop'?'[]':variant==='empty'?undefined:variant==='admission'?candidate=>[{...candidate,meaning:{kind:'claim',verified:true}}]:candidate=>{writeFixtureMemory({type:'user',scope:'global',dir:f.root,line:indexLine('user','另外一条同时提交的新约定改变了索引')});return[candidate]}
  const value=await capture(f,payload),expected={admission:'admission-rejected',noop:'model-noop',empty:'response-error',write:'operation-error'}[variant]
  assert.equal(value.job.diagnostic.classification,expected);assert.equal(value.calls,1)
  if(variant==='empty')assert.equal(value.job.reason,'capture-empty-response')
 })
})
test('unknown provider exception text never enters durable diagnostic metadata',()=>box(async f=>{
 const value=await capture(f,()=>{throw Error('PRIVATE_PROVIDER_EXCEPTION_DO_NOT_COPY')});assert.equal(value.job.diagnostic.classification,'response-error');assert.equal(value.job.reason,'capture-failed')
 for(const name of ['.capture-state.json','.capture-jobs.json','.audit.jsonl'])assert.ok(!readFileSync(join(f.root,name),'utf8').includes('PRIVATE_PROVIDER_EXCEPTION'))
}))
test('legacy jobs are explicitly uninstrumented, malformed diagnostic metadata is unavailable and inconsistent success is refused',()=>box(async f=>{
 mkdirSync(f.root,{recursive:true});const job=claimCaptureJob(f.root,'a'.repeat(64));finishCaptureJob(f.root,job,{outcome:'ok',counts:{proposed:0,inserted:0,staged:0,rejected:0}})
 assert.equal(captureJobStatus(f.root).legacy,1);assert.equal(captureJobStatus(f.root).latest.diagnostic,undefined)
 const other=claimCaptureJob(f.root,'b'.repeat(64)),d=buildCaptureDiagnostic(parseCaptureBatch('[null]',3))
 assert.throws(()=>finishCaptureJob(f.root,other,{outcome:'ok',counts:{proposed:1,inserted:0,staged:0,rejected:1},diagnostic:d}),/invalid-result/)
 const path=join(f.root,'.capture-jobs.json'),raw=JSON.parse(readFileSync(path));raw.jobs[0].diagnostic={prompt:'PRIVATE_BAD_METADATA'};writeFileSync(path,JSON.stringify(raw))
 const status=captureJobStatus(f.root);assert.equal(status.available,false);assert.equal(status.retained,undefined);assert.equal(status.reason,'capture-ledger-unavailable')
}))
