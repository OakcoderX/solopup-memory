import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runCandidateValidation} from './capture-validation-job.mjs'
import {VALIDATION_FIELDS} from './capture-validation-contract.mjs'
import {listCaptureJobs,claimCaptureJob,finishCaptureJob,captureJobStatus} from './capture-jobs.mjs'
import {buildCaptureDiagnostic} from './capture-diagnostics.mjs'
import {writeFileSync} from 'node:fs'
import {spawn,spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
const message={id:'synthetic-owner',role:'user',text:'我处理评审反馈时始终先看两处问题，再看修改办法，跨项目通用。'}
const candidate={type:'user',scope:'global',basis:'explicit',summary:'处理反馈时先看两处问题再给办法，跨项目通用',meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'}]},evidence:[{messageId:message.id,quote:message.text}]}
const result=(request,status)=>JSON.stringify({checks:JSON.parse(request.messages[0].content[0].text).candidates.map(r=>({candidateId:r.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(f=>[f,status])),evidence:status==='uncertain'?[]:[{messageId:message.id,quote:message.text}]}))})
async function box(fn){const dir=mkdtempSync(join(tmpdir(),'dsh-validator-job-'));try{await fn(dir)}finally{rmSync(dir,{recursive:true,force:true})}}
test('separate durable invocation approves an unchanged candidate once, and no bodies enter the call ledger',()=>box(async dir=>{
 let calls=0,guards=0
 const llm={async prepareCall(config){return{config,async*stream(req){calls++;yield{type:'text-delta',text:result(req,'supported')};yield{type:'finish',reason:{kind:'stop'}}}}}}
 const opts={jobDir:dir,parentId:'a'.repeat(64),llm,messages:[message],candidates:[candidate],sessionId:'synthetic',route:{provider:'fixture',model:'fixture'},assertCurrent(){guards++}}
 const first=await runCandidateValidation(opts);assert.equal(first.verdicts[0].status,'approved');assert.equal(calls,1);assert.ok(guards>=2)
 const again=await runCandidateValidation(opts);assert.equal(again.reason,'previous-invocation');assert.equal(calls,1)
 const raw=readFileSync(join(dir,'.capture-jobs.json'),'utf8');assert.ok(!raw.includes(candidate.summary));assert.ok(!raw.includes(message.text));assert.equal(listCaptureJobs(dir).jobs.length,1)
}))
test('bad validation protocol is settled as failed and never resent; it cannot implicitly approve',()=>box(async dir=>{
 let calls=0;const llm={async prepareCall(config){return{config,async*stream(){calls++;yield{type:'text-delta',text:'{"checks":[]}'};yield{type:'finish',reason:{kind:'stop'}}}}}}
 const opts={jobDir:dir,parentId:'b'.repeat(64),llm,messages:[message],candidates:[candidate],sessionId:'synthetic'}
 const first=await runCandidateValidation(opts);assert.equal(first.reason,'capture-invalid-envelope');assert.deepEqual(first.verdicts,[]);assert.equal(listCaptureJobs(dir).jobs[0].status,'failed')
 await runCandidateValidation(opts);assert.equal(calls,1)
}))
test('late ignored cancellation has no approval and the same validation is not retried',()=>box(async dir=>{
 let calls=0;const llm={async prepareCall(config){return{config,async*stream(req){calls++;await new Promise(r=>setTimeout(r,60));yield{type:'text-delta',text:result(req,'supported')};yield{type:'finish',reason:{kind:'stop'}}}}}}
 const opts={jobDir:dir,parentId:'c'.repeat(64),llm,messages:[message],candidates:[candidate],sessionId:'synthetic',timeoutMs:15}
 const first=await runCandidateValidation(opts);assert.equal(first.reason,'capture-timeout');assert.deepEqual(first.verdicts,[])
 await new Promise(r=>setTimeout(r,80));const again=await runCandidateValidation(opts);assert.equal(again.reason,'previous-invocation');assert.equal(calls,1)
}))
test('a source/revision change during validation propagates and prevents a publishable approval',()=>box(async dir=>{
 let changed=false,calls=0
 const llm={async prepareCall(config){return{config,async*stream(req){calls++;changed=true;yield{type:'text-delta',text:result(req,'supported')};yield{type:'finish',reason:{kind:'stop'}}}}}}
 await assert.rejects(runCandidateValidation({jobDir:dir,parentId:'d'.repeat(64),llm,messages:[message],candidates:[candidate],sessionId:'synthetic',assertCurrent(){if(changed)throw Error('capture-input-source-changed')}}),/source-changed/)
 assert.equal(calls,1);assert.equal(listCaptureJobs(dir).jobs[0].status,'failed')
}))
test('SIGKILL after a validation invocation is claimed cannot resend that child from a new process',()=>box(async dir=>{
 const marker=join(dir,'invocation-started'),moduleUrl=new URL('./capture-validation-job.mjs',import.meta.url).href
 const opts={jobDir:dir,parentId:'e'.repeat(64),messages:[message],candidates:[candidate],sessionId:'synthetic-crash',timeoutMs:5000}
 const script=`import{runCandidateValidation}from${JSON.stringify(moduleUrl)};import{writeFileSync}from'node:fs';let calls=0;let ticker;const opts=${JSON.stringify(opts)};opts.llm={async prepareCall(config){return{config,async*stream(){calls++;writeFileSync(${JSON.stringify(marker)},'started');if(process.argv[1]==='issue'){ticker=setInterval(()=>{},1000);await new Promise(()=>{})}yield{type:'text-delta',text:'{"checks":[]}'};yield{type:'finish',reason:{kind:'stop'}}}}}};const r=await runCandidateValidation(opts);clearInterval(ticker);console.log(JSON.stringify({calls,reason:r.reason}));`
 const child=spawn(process.execPath,['--input-type=module','-e',script,'issue'],{stdio:['ignore','pipe','pipe']})
 try{
  const until=Date.now()+4000;while(!existsSync(marker)&&Date.now()<until&&child.exitCode===null)await new Promise(r=>setTimeout(r,10))
  assert.ok(existsSync(marker));const done=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await done
  assert.equal(child.signalCode,'SIGKILL');assert.equal(listCaptureJobs(dir).jobs.length,1)
  const resumed=spawnSync(process.execPath,['--input-type=module','-e',script,'resume'],{encoding:'utf8',timeout:4000});assert.equal(resumed.status,0,resumed.stderr)
  assert.deepEqual(JSON.parse(resumed.stdout),{calls:0,reason:'previous-invocation'});assert.equal(listCaptureJobs(dir).jobs.length,1)
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')}
}))

test('same-millisecond child completion cannot hide its substantive parent capture status',()=>box(async dir=>{
 const parent=claimCaptureJob(dir,'f'.repeat(64),{now:1000,leaseMs:1000}),child=claimCaptureJob(dir,'0'.repeat(64),{now:1010,leaseMs:1000})
 const noop=buildCaptureDiagnostic({responseItems:0,parsedItems:0,parserRejected:0,deferred:0,wrapped:false,codes:[]})
 finishCaptureJob(dir,child,{outcome:'ok',counts:{proposed:0,inserted:0,staged:0,rejected:0},diagnostic:noop},{now:1020})
 const recorded=buildCaptureDiagnostic({responseItems:1,parsedItems:1,parserRejected:0,deferred:0,wrapped:false,codes:[]},{inserted:1})
 finishCaptureJob(dir,parent,{outcome:'ok',counts:{proposed:1,inserted:1,staged:0,rejected:0},diagnostic:recorded},{now:1020})
 assert.equal(captureJobStatus(dir).latest.jobId,parent.id);assert.equal(captureJobStatus(dir).latest.diagnostic.classification,'recorded')
}))
test('transient local source-check contention retries the read without replaying the model invocation',()=>box(async dir=>{
 let reads=0,calls=0,linked=false
 const llm={async prepareCall(config){return{config,async*stream(req){assert.equal(linked,true);calls++;yield{type:'text-delta',text:result(req,'supported')};yield{type:'finish',reason:{kind:'stop'}}}}}}
 const out=await runCandidateValidation({jobDir:dir,parentId:'1'.repeat(64),llm,messages:[message],candidates:[candidate],sessionId:'synthetic',onClaim(){linked=true},assertCurrent(){if(++reads===1){const error=Error('synthetic local contention');error.code='memory-lock-busy';throw error}}})
 assert.equal(calls,1);assert.equal(out.verdicts[0].status,'approved');assert.ok(reads>=3)
}))
test('a busy completion ledger retries only metadata persistence, never the settled validation call',()=>box(async dir=>{
 let calls=0,timer;const lock=join(dir,'.write.lock')
 const llm={async prepareCall(config){return{config,async*stream(req){calls++;writeFileSync(lock,JSON.stringify({pid:process.pid,token:'synthetic-lock'}));timer=setTimeout(()=>rmSync(lock,{force:true}),40);yield{type:'text-delta',text:result(req,'supported')};yield{type:'finish',reason:{kind:'stop'}}}}}}
 try{const out=await runCandidateValidation({jobDir:dir,parentId:'2'.repeat(64),llm,messages:[message],candidates:[candidate],sessionId:'synthetic'});assert.equal(calls,1);assert.equal(out.verdicts[0].status,'approved');assert.equal(listCaptureJobs(dir).jobs[0].status,'succeeded')}
 finally{clearTimeout(timer);rmSync(lock,{force:true})}
}))
