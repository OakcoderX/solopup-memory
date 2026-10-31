import {applyWithValidationFixture as apply} from './fixture-host.mjs'
import {test}from'node:test'
import assert from'node:assert/strict'
import{readFileSync,mkdtempSync,realpathSync,mkdirSync,rmSync,existsSync}from'node:fs'
import{join}from'node:path'
import{tmpdir}from'node:os'
import{captureProjection}from'./capture-projections.mjs'
import{candidateDetail}from'./withdrawal.mjs'
import{buildUserPrompt,extractWithLlm}from'./capture-llm.mjs'
import{captureInputDescriptor,reconstructCaptureInput,enqueueCaptureInput,bindCaptureInput,listCaptureInputs,blockCaptureInput}from'./capture-inputs.mjs'
import{claimCaptureJob,recoverCaptureJobs,listCaptureJobs}from'./capture-jobs.mjs'
import {indexLine, searchStore, storeRevision, withdrawManagedSource} from './index.mjs'
import{writeFixtureMemory,prepareMountedFixture}from'./fixture-host.mjs'
import{candidateSnapshot}from'./candidates.mjs'
const record={id:'a'.repeat(64),type:'user',scope:'global',summary:'只对初稿用标记 jade26',meaning:{kind:'preference',conditions:[]},detail:'Synthetic detail restricted to drafts.',origin:'tool-context',sessionId:'synthetic',evidence:[{messageId:'synthetic:1',quote:'Synthetic draft-only source'}]}
const line='[global] - [user] 只对初稿用标记 jade26 — user.md'
test('projection exposes complete existing fields and source references as data, not a new message',()=>{
 const p=captureProjection(record,'global',line,candidateDetail(record.id,record.detail));assert.equal(p.recordId,record.id);assert.equal(p.indexLine,line);assert.equal(p.meaning.conditions.length,0);assert.equal(p.detail,record.detail);assert.deepEqual(p.evidence,[{messageId:'synthetic:1',quote:'Synthetic draft-only source'}])
})
test('removed, changed or ambiguous topic blocks do not expose ledger-only old detail',()=>{
 for(const topic of ['',record.detail,candidateDetail(record.id,record.detail)+'\n'+candidateDetail(record.id,record.detail)]){const p=captureProjection(record,'global',line,topic);assert.equal(p.detailAvailable,false);assert.equal(p.detail,undefined)}
})
test('legacy source record with no meaning stays explicitly unclassified in the projection',()=>{
 const p=captureProjection({...record,meaning:undefined},'global',line,'');assert.equal(p.meaning,null)
})
test('structured projections fit the input byte budget atomically and report omissions',()=>{
 const projected=Array.from({length:60},(_,n)=>({...captureProjection(record,'global',line,candidateDetail(record.id,record.detail)),recordId:String(n).padStart(64,'a'),detail:'長'.repeat(2000)}))
 for(const limit of [1024,2048,24576,65536]){const prompt=buildUserPrompt([{id:'source',role:'user',text:'原话只对初稿适用'}],[line],3,limit,[],projected);assert.ok(Buffer.byteLength(prompt)<=limit,`budget ${limit}`);assert.match(prompt,/省略/);for(const row of prompt.split('\n').filter(x=>x.startsWith('{')))assert.doesNotThrow(()=>JSON.parse(row))}
})
test('the actual v25 descriptor cannot resume under a changed extraction contract',()=>{
 const f=JSON.parse(readFileSync(new URL('./corpus/capture-contract-v25.json',import.meta.url))),session={...f.session,surface:{nodes:[1]},isOwnSeq:n=>n===1},events=[];events[1]=f.event
 const next=captureInputDescriptor(session,[f.message],f.cwd,f.options,f.route)
 assert.notEqual(next.configurationHash,f.descriptor.configurationHash);assert.notEqual(next.id,f.descriptor.id)
 assert.throws(()=>reconstructCaptureInput(f.descriptor,session,events,f.cwd,f.options,f.route),/configuration-changed/)
 assert.equal(reconstructCaptureInput(next,session,events,f.cwd,f.options,f.route).length,1)
})
for(const mode of ['repair','stale','withdrawn'])test('live capture projection and source-bound repair integration: '+mode,async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-projection-'))),home=join(base,'home'),cwd=join(base,'project'),previous=process.env.DSH_HOME;mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 try{
  const root=join(home,'memory'),summary='所有项目初稿使用合成标记 jade26',old=writeFixtureMemory({dir:root,scope:'global',type:'user',summary,line:indexLine('user',summary),detail:'Original draft-only convention.',meaning:{kind:'preference'}})
  prepareMountedFixture()
  if(mode==='withdrawn'){const prior=candidateSnapshot(root,'global').records[0],e=prior.evidence[0],preview=withdrawManagedSource(root,prior.sessionId,e.messageId);withdrawManagedSource(root,prior.sessionId,e.messageId,{apply:true,controlReview:preview.controlReview})}
  const handlers=[],session={id:'projection-'+mode};let calls=0
  const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},async prepareCall(){return{config:{},async*stream(request){
   calls++;const prompt=request.messages[0].content[0].text,rows=prompt.split('\n').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}}),shown=rows.find(x=>x.recordId)
   if(mode==='withdrawn'){assert.equal(shown,undefined);yield{type:'text-delta',text:'[]'};yield{type:'finish',reason:{kind:'stop'}};return}
   assert.equal(shown.meaning.conditions.length,0);assert.ok(shown.indexLine.startsWith('[global] - [user]'));assert.equal(shown.detailAvailable,true)
   const user=rows.find(x=>x.role==='user')
   if(mode==='stale')writeFixtureMemory({dir:root,scope:'global',type:'user',summary:'独立长期方法要求简短结论',line:indexLine('user','独立长期方法要求简短结论'),meaning:{kind:'preference'}})
   yield{type:'text-delta',text:JSON.stringify([{type:'user',summary:'仅对初稿：跨项目默认合成标记 jade26',scope:'global',basis:'explicit',meaning:{kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}]},supersedes:shown.indexLine,revisionMode:'replace',evidence:[{messageId:user.id,quote:user.text}]}])};yield{type:'finish',reason:{kind:'stop'}}
  }}}}
  apply({llm,systemPrompt:{context(){}},workingDirectory:{get(){return cwd}},tools:{register(){}},on(name,handler){handlers.push([name,handler])}},{autoCapture:{everyTurns:1}})
  const emit=event=>{for(const [name,handler]of handlers)if(name==='session/event')handler(session,event)}
  emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text:'我的初稿都使用 jade26，这只对初稿适用，跨所有项目。'}]}}});emit({type:'step/end',data:{}})
  let state;const until=Date.now()+5000;while(Date.now()<until){try{state=JSON.parse(readFileSync(join(root,'.capture-state.json')))}catch{}if(state?.lastCaptureAt&&!state.running)break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(calls,1);assert.equal(state?.running,false)
  const current=candidateSnapshot(root,'global').records.filter(r=>r.status==='recorded')
  if(mode==='repair'){assert.equal(state.lastOutcome,'ok');assert.ok(current.some(r=>r.meaning.conditions.some(c=>c.dimension==='document_kind')));assert.equal(candidateSnapshot(root,'global').records.find(r=>r.indexLine===old.indexLine).status,'superseded');assert.equal(searchStore(root,'jade26',{context:{document_kind:'final'}}).hits.length,0)}
  else if(mode==='stale'){assert.equal(state.lastOutcome,'error');assert.equal(state.lastError,'capture-input-source-changed');assert.equal(current.find(r=>r.summary===summary).meaning.conditions.length,0)}
  else{assert.equal(current.length,0);assert.equal(state.diagnostic.classification,'model-noop')}
 }finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
})

for(const status of ['pending','bound','blocked'])test('changed contract cannot create another durable invocation for the same owner sources: '+status,()=>{
 const f=JSON.parse(readFileSync(new URL('./corpus/capture-contract-v25.json',import.meta.url))),root=mkdtempSync(join(tmpdir(),'dsh-contract-alias-'))
 try{
  enqueueCaptureInput(root,f.descriptor,{now:100})
  if(status==='bound'){const job=claimCaptureJob(root,f.descriptor.id,{now:100,leaseMs:1000});bindCaptureInput(root,f.descriptor.id,job.id,{now:101});recoverCaptureJobs(root,{now:2000})}
  if(status==='blocked')blockCaptureInput(root,f.descriptor.id,'configuration-changed',{now:101})
  const next=captureInputDescriptor(f.session,[f.message],'/different/project',f.options,{provider:'another',model:'another'})
  const alias=enqueueCaptureInput(root,next,{now:2001});assert.equal(alias.id,f.descriptor.id);assert.equal(alias.status,status);assert.equal(listCaptureInputs(root).inputs.length,1)
  if(status==='bound')assert.equal(listCaptureJobs(root).jobs[0].status,'uncertain')
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('genuine new owner source can create a new durable input under the new contract',()=>{
 const f=JSON.parse(readFileSync(new URL('./corpus/capture-contract-v25.json',import.meta.url))),root=mkdtempSync(join(tmpdir(),'dsh-contract-new-'))
 try{enqueueCaptureInput(root,f.descriptor,{now:100});const next=captureInputDescriptor(f.session,[{...f.message,seq:2,id:f.session.id+':2'}],f.cwd,f.options,f.route);assert.equal(enqueueCaptureInput(root,next,{now:101}).id,next.id);assert.equal(listCaptureInputs(root).inputs.length,2)}finally{rmSync(root,{recursive:true,force:true})}
})
