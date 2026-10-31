import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createToolInputTracker} from './tool-inputs.mjs'
import {createObservationTracker,normalizeObservationCertificate,observationRoots,argumentFingerprint} from './tool-observations.mjs'
import {apply,searchStore,withdrawManagedSource,indexLine} from './index.mjs'
import {candidateSnapshot} from './candidates.mjs'
import {prepareSourceRetirement,validateRetiredSource} from './source-retirement.mjs'
import {writeFixtureMemory,scriptedNativeValidationLlm} from './fixture-host.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
function fixture(){
 const inputs=createToolInputTracker(),session={id:'native-observation-session',deriveMessages:()=>messages},agent={session},obs=createObservationTracker((session,callId)=>inputs.forExecution({agent:{session},callId})),messages=[]
 const pre=(turn=1,step=1,claimed=[])=>{const input={agent,turn,step,messages:claimed};inputs.preStep(input);obs.preStep(input)}
 const emit=event=>{inputs.event(session,event);obs.event(session,event)}
 const owner={id:'owner-message',role:'user',source:{kind:'user'},content:[{type:'text',text:'Please check the controlled measurement and keep its output.'}]}
 pre(1,1,[owner]);emit({type:'user/message',seq:1,data:owner});messages.push(owner)
 const call=(callId='measure-1',at=2,name='fixture_measure',turn=1,step=1)=>emit({type:'tool/call',seq:at,data:{callId,name,arguments:'{"sample":"A"}',turn,step}})
 const result=(patch={})=>{const message={id:'result-message',role:'tool',source:{kind:'tool',callId:'measure-1'},toolCallId:'measure-1',content:[{type:'text',text:'controlled_measurement=40'}],...patch.message};const event={type:'tool/result',seq:3,surfaceOp:'append',sourceEventSeqs:[2],data:{turn:1,step:1,message,...patch.data},...patch.event};emit(event);messages.push(event.data.message);return event}
 const request=()=>obs.request({sessionId:session.id,tools:[{name:'memory_write'}],messages})
 const ready=()=>{pre(1,2);request();call('save',4,'memory_write',1,2)}
 const exec=reference=>obs.forExecution({agent,callId:'save'},reference??{callId:'measure-1',quote:'controlled_measurement=40'},inputs.forExecution({agent,callId:'save'}))
 return{inputs,obs,session,agent,messages,pre,emit,call,result,request,ready,exec}
}
test('native event, result ancestry, actual model-visible quote and current surface are all required',()=>{
 const f=fixture();f.call();f.result();f.ready();const proof=f.exec()
 assert.equal(proof.observation.kind,'native-tool-result');assert.equal(proof.observation.outcome,'succeeded');assert.equal(proof.observation.quote,'controlled_measurement=40');assert.equal(proof.evidence[0].messageId,f.session.id+':1');assert.equal(observationRoots(proof.observation).length,2)
 assert.throws(()=>f.exec({callId:'measure-1',quote:'controlled_measurement=70'}),/quote-not-in-result/)
 assert.throws(()=>f.exec({callId:'measure-1',quote:'40',verified:true}),/invalid-reference/)
})
test('pending calls, missing ancestry, result-before-call, forged source and unseen outputs fail closed',()=>{
 for(const variant of ['pending','ancestry','ordering','source','unseen']){
  const f=fixture();f.call();if(variant!=='pending')f.result(variant==='ancestry'?{event:{sourceEventSeqs:[1]}}:variant==='ordering'?{event:{seq:1}}:variant==='source'?{message:{source:{kind:'assistant'}}}:{})
  f.pre(1,2);if(variant!=='unseen')f.request();f.call('save',4,'memory_write',1,2)
  assert.throws(()=>f.exec(),/source-unavailable/)
 }
})
test('tool error is a checked error output, never a successful measurement',()=>{
 const f=fixture();f.call();f.result({message:{isError:true,content:[{type:'text',text:'controlled_measurement=40'}]},data:{error:{code:'SYNTHETIC_FAILURE'}}});f.ready();assert.equal(f.exec().observation.outcome,'error')
})
test('memory output, duplicate call/result identities and unsafe/oversized payloads cannot be laundered as observations',()=>{
 for(const variant of ['memory','duplicate-call','duplicate-result','oversize','nontext','secret']){
  const f=fixture();f.call('measure-1',2,variant==='memory'?'memory_search':'fixture_measure')
  const patch=variant==='oversize'?{message:{content:[{type:'text',text:'x'.repeat(16385)}]}}:variant==='nontext'?{message:{content:[{type:'image',data:'synthetic'}]}}:variant==='secret'?{message:{content:[{type:'text',text:'OPENAI_API_KEY=sk-synthetic123456789012345678901234567890'}]}}:{}
  f.result(patch);if(variant==='duplicate-call')f.call('measure-1',4);if(variant==='duplicate-result')f.result({event:{seq:4}});f.pre(1,2);f.request();f.call('save',5,'memory_write',1,2);assert.throws(()=>f.exec(),/source-unavailable/)
 }
})
test('shadowed or mutated results cannot be used even if a previous request contained the original text',()=>{
 for(const variant of ['mutation','replacement','removal']){
  const f=fixture();f.call();f.result();f.ready()
  if(variant==='mutation')f.messages[1]={...f.messages[1],content:[{type:'text',text:'changed_measurement=70'}]}
  if(variant==='replacement')f.emit({type:'tool/result',seq:5,surfaceOp:{op:'replace',startSeq:3,endSeq:3},sourceEventSeqs:[3],data:{message:{}}})
  if(variant==='removal')f.messages.splice(1,1)
  assert.throws(()=>f.exec(),/source-unavailable|surface-changed/)
 }
})
test('other sessions, stale request steps, disposal and cancellation cannot reuse a live certificate',()=>{
 const f=fixture();f.call();f.result();f.ready();const owner=f.inputs.forExecution({agent:f.agent,callId:'save'})
 assert.throws(()=>f.obs.forExecution({agent:{session:{id:f.session.id}},callId:'save'},{callId:'measure-1',quote:'40'},owner),/source-unavailable/)
 f.pre(1,3);f.call('later',5,'memory_write',1,3);assert.throws(()=>f.obs.forExecution({agent:f.agent,callId:'later'},{callId:'measure-1',quote:'40'},owner),/source-unavailable/)
 const abort=new AbortController();abort.abort();assert.throws(()=>f.obs.forExecution({agent:f.agent,callId:'save',signal:abort.signal},{callId:'measure-1',quote:'40'},owner),/abort/i)
 f.obs.dispose();assert.throws(()=>f.exec(),/disposed/)
})
async function box(run){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-native-output-'))),home=join(base,'home'),cwd=join(base,'project'),previous=process.env.DSH_HOME;mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 const handlers=[],tools=[],effects=[],ctx={llm:scriptedNativeValidationLlm(),systemPrompt:{context(entry){ctx.context=entry}},workingDirectory:{get(){return cwd}},tools:{register(tool){tools.push(tool)}},on(name,handler){handlers.push([name,handler])},effect(fn){const dispose=fn();if(typeof dispose==='function')effects.push(dispose)}}
 try{apply(ctx,{autoCapture:{enabled:false,provider:'fixture',model:'fixture'}});await run({root:join(home,'memory'),ctx,handlers,tools})}finally{for(const dispose of effects)dispose();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
}
async function observedWrite(f,{summary='执行观察：控制读数为40',target,callId='measure-live',at=2,output='controlled_measurement=40',error=false}={}){
 const {handlers,tools}=f,emit=(name,...args)=>{for(const [event,handler]of handlers)if(event===name)handler(...args)},messages=[],session=f.session??(f.session={id:'native-live',deriveMessages:()=>messages}),agent={session};if(f.sessionMessages)messages.push(...f.sessionMessages)
 session.deriveMessages=()=>messages;f.sessionMessages=messages
 const owner={id:'owner-'+at,role:'user',source:{kind:'user'},content:[{type:'text',text:'Keep this controlled execution observation '+at}]}
 emit('agent/pre-step',{agent,turn:at,step:1,messages:[owner]},()=>{});emit('session/event',session,{type:'user/message',seq:at*10,data:owner});messages.push(owner)
 emit('session/event',session,{type:'tool/call',seq:at*10+1,data:{callId,name:'fixture_measure',arguments:'{"sample":"A"}',turn:at,step:1}})
 const result={id:'result-'+at,role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:[{type:'text',text:output}],...error?{isError:true}:{}}
 emit('session/event',session,{type:'tool/result',seq:at*10+2,surfaceOp:'append',sourceEventSeqs:[at*10+1],data:{turn:at,step:1,message:result}});messages.push(result)
 emit('agent/pre-step',{agent,turn:at,step:2,messages:[]},()=>{});emit('llm/stream',{sessionId:session.id,tools:[{name:'memory_write'}],messages},()=>{})
 emit('session/event',session,{type:'tool/call',seq:at*10+3,data:{callId:'save-'+at,name:'memory_write',arguments:'{}',turn:at,step:2}})
 return tools.find(tool=>tool.name==='memory_write').execute({type:'reference',scope:'global',summary,observation:{callId,quote:output},meaning:{kind:'episode',...target?{relations:[{target,stance:'contradicts'}]}:{}}},{agent,callId:'save-'+at})
}
test('SDK observed write publishes certificate and owner/call/result roots; current and historical output keep the verification boundary',()=>box(async f=>{
 await observedWrite(f);const record=candidateSnapshot(f.root,'global').records[0];assert.equal(record.sources.length,3);assert.equal(record.observation.outcome,'succeeded');assert.equal(record.evidence[0].messageId,'native-live:20')
 for(const view of ['current','history']){const hit=searchStore(f.root,'执行观察',{view}).hits[0];assert.equal(hit.interpretation.observation.quoteChecked,true);assert.equal(hit.interpretation.observation.currentWorldStateVerified,false)}
 assert.throws(()=>normalizeObservationCertificate({...record.observation,worldVerified:true},record.sessionId),/invalid-certificate/)
}))
for(const state of ['unsupported','uncertain'])test('an '+state+' checked observation is never staged without its execution certificate',()=>box(async f=>{
 f.ctx.llm=scriptedNativeValidationLlm(state)
 const result=await observedWrite(f);assert.equal(result.status,state==='unsupported'?'rejected':'not-applied');assert.equal(candidateSnapshot(f.root,'global').records.length,0);assert.equal(searchStore(f.root,'执行观察').hits.length,0)
}))
for(const at of [20,21,22])test('withdrawing '+at+' (owner/call/result) removes observed evidence even after restoring old files',()=>box(async f=>{
 await observedWrite(f);const backup=new Map(['MEMORY.md','.candidates.json','.episodes.json'].map(name=>[name,readFileSync(join(f.root,name))]))
 const p=withdrawManagedSource(f.root,'native-live','native-live:'+at);withdrawManagedSource(f.root,'native-live','native-live:'+at,{apply:true,controlReview:p.controlReview});assert.equal(searchStore(f.root,'执行观察').hits.length,0)
 for(const [name,body]of backup)writeFileSync(join(f.root,name),body)
 assert.equal(searchStore(f.root,'执行观察').hits.length,0);assert.equal(searchStore(f.root,'执行观察',{view:'history'}).hits.length,0)
}))
test('identical executed reads do not multiply support; execution errors cannot become counterevidence',()=>box(async f=>{
 writeFixtureMemory({type:'user',scope:'global',dir:f.root,line:indexLine('user','待验证的设备读数假设为70'),meaning:{kind:'belief'}})
 const target=candidateSnapshot(f.root,'global').records[0].id
 await observedWrite(f,{target});await observedWrite(f,{target,summary:'再次读取同一受控工具结果仍为40',callId:'measure-second',at:3})
 const view=searchStore(f.root,'设备读数假设',{task:{affectsDecision:true}}).hits[0].interpretation;assert.equal(view.revision.state,'challenged');assert.equal(view.revision.counterSourceGroups,1);assert.equal(view.revision.nativeOutputRecords,2);assert.equal(view.revision.worldVerified,false)
 await assert.rejects(observedWrite(f,{target,summary:'失败结果不证明读数与假设矛盾',callId:'measure-error',at:4,error:true}),/invalid-observation-role/)
 await observedWrite(f,{summary:'工具失败的原生记录仅用于诊断',callId:'measure-error-other',at:5,error:true});assert.equal(searchStore(f.root,'仅用于诊断').hits[0].interpretation.observation.outcome,'error')
}))
test('all three original owner roots plus execution call/result survive publication and bounded retirement',()=>box(async f=>{
 const g=fixture(),owners=[2,3].map(at=>({id:'owner-'+at,role:'user',source:{kind:'user'},content:[{type:'text',text:'Controlled steering input '+at}]}))
 g.pre(1,1,owners);owners.forEach((owner,i)=>g.emit({type:'user/message',seq:i+2,data:owner}));g.call('measure-1',4);g.result({event:{seq:5,sourceEventSeqs:[4]}});g.pre(1,2);g.request();g.call('save',6,'memory_write',1,2)
 const proof=g.exec();assert.equal(proof.evidence.length,3)
 writeFixtureMemory({type:'reference',scope:'global',dir:f.root,line:indexLine('reference','多来源原生观察需要保留全部五个撤回根'),meaning:{kind:'episode'},provenance:proof})
 const state=JSON.parse(readFileSync(join(f.root,'.candidates.json')));assert.equal(state.records[0].sources.length,5)
 prepareSourceRetirement(f.root,state,{force:true,indexText:'# empty after removal'});assert.equal(state.retired.length,1);assert.equal(validateRetiredSource(state.retired[0]).sources.length,5)
}))

test('available references expose actual visible call IDs without treating discovery as proof or executing a tool',()=>{
 const f=fixture();f.call('transport-generated-A92',2);f.result({message:{source:{kind:'tool',callId:'transport-generated-A92'},toolCallId:'transport-generated-A92'}});f.pre(1,2);f.request();f.call('status',4,'memory_status',1,2)
 const list=f.obs.availableForExecution({agent:f.agent,callId:'status'});assert.equal(list.items[0].callId,'transport-generated-A92');assert.equal(list.items[0].quotePreview,'controlled_measurement=40');assert.equal(list.items[0].outcome,'succeeded');assert.equal(list.truncated,false)
 f.messages.splice(1,1);assert.equal(f.obs.availableForExecution({agent:f.agent,callId:'status'}).items.length,0)
})
test('equivalent JSON arguments share an execution identity despite whitespace or object-key order',()=>{
 assert.equal(argumentFingerprint('{ "b":2,"a":{"y":1,"x":0} }'),argumentFingerprint({a:{x:0,y:1},b:2}))
 assert.notEqual(argumentFingerprint('{"reading":40}'),argumentFingerprint('{"reading":70}'))
 let nested={};for(let i=0;i<20;i++)nested={nested};assert.throws(()=>argumentFingerprint(nested),/arguments-too-complex/)
})
