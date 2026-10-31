import {applyWithValidationFixture as apply} from './fixture-host.mjs'
import {prepareMountedFixture} from './fixture-host.mjs'
import {realpathSync} from 'node:fs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {captureMessage} from './capture-evidence.mjs'
import {captureSessionEligible,captureInputDescriptor,enqueueCaptureInput,listCaptureInputs,pendingCaptureInputs,bindCaptureInput,blockCaptureInput,reconstructCaptureInput,pruneCaptureInputs,observeCaptureSource} from './capture-inputs.mjs'
import {claimCaptureJob,listCaptureJobs,finishCaptureJob} from './capture-jobs.mjs'
import {storeDirFor, withdrawManagedSource} from './index.mjs'

const options={everyTurns:1,maxEntries:3,maxTokens:800,maxInputBytes:24*1024,timeoutMs:25000}
const route={provider:'fixture',model:'fixture-model'}
const text='以后所有回复都先给明确结论，再解释判断依据。'
const event={seq:0,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}}
const events=[event]
function session(){return{id:'session-synthetic-input',header:{id:'session-synthetic-input',createdAt:1234,isSeeded:false},surface:{nodes:[0]},isOwnSeq:n=>n===0,requestHeader:()=>({config:route})}}
const messages=[{...captureMessage(event,'session-synthetic-input:0'),seq:0}]
const descriptor=(s=session(),cwd='/synthetic/project',o=options,r=route)=>captureInputDescriptor(s,messages,cwd,o,r)
async function box(fn){const dir=realpathSync(mkdtempSync(join(tmpdir(),'dsh-inputs-')));try{return await fn(dir)}finally{rmSync(dir,{recursive:true,force:true})}}
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('fixture did not settle')}

test('来源队列只读不建库；落盘不含正文、项目名、路由或会话明文，重复入队幂等',()=>box(dir=>{
  assert.deepEqual(listCaptureInputs(join(dir,'missing')),{schema:1,revision:0,inputs:[]})
  assert.equal(existsSync(join(dir,'missing')),false)
  const input=enqueueCaptureInput(dir,descriptor(),{now:1000})
  assert.equal(enqueueCaptureInput(dir,descriptor(),{now:1001}).id,input.id)
  assert.equal(listCaptureInputs(dir).revision,1)
  assert.equal(statSync(join(dir,'.capture-inputs.json')).mode&0o777,0o600)
  assert.doesNotMatch(readFileSync(join(dir,'.capture-inputs.json'),'utf8'),/明确结论|synthetic|fixture|project|model/)
  assert.equal(pendingCaptureInputs(dir,session()).length,1)
}))

test('重建保持原始角色与稳定证据ID；重新创建的同名会话不能接管旧输入',()=>box(dir=>{
  const row=enqueueCaptureInput(dir,descriptor())
  assert.deepEqual(reconstructCaptureInput(row,session(),events,'/synthetic/project',options,route),messages)
  const other=session();other.header.createdAt++
  assert.equal(pendingCaptureInputs(dir,other).length,0)
  assert.throws(()=>reconstructCaptureInput(row,other,events,'/synthetic/project',options,route),/source-changed/)
}))

for(const [label,mutate,reason] of [
 ['正文变化',(s,e)=>{e[0].data.content[0].text='替换后的来源正文并未通过原来的哈希核对'},'source-changed'],
 ['来源变成外部',(s,e)=>{e[0].data.source.kind='runtime-context'},'source-changed'],
 ['活动历史撤回',s=>{s.surface.nodes=[]},'source-changed'],
 ['来自继承历史',s=>{s.isOwnSeq=()=>false},'source-changed'],
 ['子代理',s=>{s.header.parentSession='parent'},'session-ineligible'],
 ['种子会话',s=>{s.header.isSeeded=true},'session-ineligible'],
])test(`重建拒绝${label}，原队列不被静默改写`,()=>box(dir=>{
 const row=enqueueCaptureInput(dir,descriptor()),s=session(),e=structuredClone(events),before=readFileSync(join(dir,'.capture-inputs.json'),'utf8')
 mutate(s,e)
 assert.throws(()=>reconstructCaptureInput(row,s,e,'/synthetic/project',options,route),new RegExp(reason))
 assert.equal(readFileSync(join(dir,'.capture-inputs.json'),'utf8'),before)
}))

test('项目、模型路由或预算改变不能让旧输入转移执行',()=>box(dir=>{
 const row=enqueueCaptureInput(dir,descriptor())
 assert.throws(()=>reconstructCaptureInput(row,session(),events,'/another/project',options,route),/scope-changed/)
 assert.throws(()=>reconstructCaptureInput(row,session(),events,'/synthetic/project',{...options,maxTokens:1600},route),/configuration-changed/)
 assert.throws(()=>reconstructCaptureInput(row,session(),events,'/synthetic/project',options,{...route,model:'other'}),/configuration-changed/)
}))

test('绑定未知调用后不再视为待处理，源引用不能重新绑定或解除',()=>box(dir=>{
 const row=enqueueCaptureInput(dir,descriptor()),job=claimCaptureJob(dir,row.id)
 assert.equal(bindCaptureInput(dir,row.id,job.id).status,'bound')
 assert.equal(pendingCaptureInputs(dir,session()).length,0)
 assert.throws(()=>bindCaptureInput(dir,row.id,'f'.repeat(64)),/invalid-binding/)
 assert.throws(()=>blockCaptureInput(dir,row.id,'source-changed'),/stale/)
 assert.equal(claimCaptureJob(dir,row.id).claimed,false)
}))

test('损坏、多余正文字段、链接及无效引用拒绝并保留现场',()=>box(dir=>{
 const path=join(dir,'.capture-inputs.json');enqueueCaptureInput(dir,descriptor())
 const state=listCaptureInputs(dir);state.inputs[0].body='must-not-persist';const corrupt=JSON.stringify(state);writeFileSync(path,corrupt)
 assert.throws(()=>listCaptureInputs(dir),/corrupt/);assert.equal(readFileSync(path,'utf8'),corrupt)
 rmSync(path);const target=join(dir,'unrelated');writeFileSync(target,'unchanged');symlinkSync(target,path)
 assert.throws(()=>listCaptureInputs(dir),/corrupt/);assert.equal(readFileSync(target,'utf8'),'unchanged')
 for(const refs of [[],[{seq:0,role:'tool',hash:'a'.repeat(64)}]])assert.throws(()=>enqueueCaptureInput(dir,{...descriptor(),refs}),/invalid-source/)
}))

test('来源入队后真实进程SIGKILL，重开保留尚未发出的输入',()=>box(dir=>{
 const modulePath=fileURLToPath(new URL('./capture-inputs.mjs',import.meta.url))
 const code=`import{enqueueCaptureInput}from${JSON.stringify(modulePath)};enqueueCaptureInput(process.env.INPUT_DIR,${JSON.stringify(descriptor())});process.kill(process.pid,'SIGKILL')`
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,INPUT_DIR:dir},timeout:5000})
 assert.equal(child.signal,'SIGKILL');assert.equal(pendingCaptureInputs(dir,session()).length,1)
 assert.equal(existsSync(join(dir,'.capture-jobs.json')),false)
}))

test('清理只选已知终态，双版本过期拒绝；待处理与未决保留',()=>box(dir=>{
 const a=enqueueCaptureInput(dir,descriptor()),ja=claimCaptureJob(dir,a.id);bindCaptureInput(dir,a.id,ja.id)
 finishCaptureJob(dir,ja,{outcome:'ok'})
 const b=enqueueCaptureInput(dir,descriptor({...session(),id:'synthetic-other-source'},'/other')),jb=claimCaptureJob(dir,b.id,{now:1000,leaseMs:1000});bindCaptureInput(dir,b.id,jb.id)
 enqueueCaptureInput(dir,descriptor({...session(),id:'synthetic-pending-source'},'/pending'))
 const review=pruneCaptureInputs(dir);assert.deepEqual(review.removable,[a.id])
 assert.throws(()=>pruneCaptureInputs(dir,{apply:true}),/review-required/)
 claimCaptureJob(dir,'a'.repeat(64))
 assert.throws(()=>pruneCaptureInputs(dir,{apply:true,expectedRevision:review.revision,expectedJobsRevision:review.jobsRevision}),/review-stale/)
 const fresh=pruneCaptureInputs(dir);const applied=pruneCaptureInputs(dir,{apply:true,expectedRevision:fresh.revision,expectedJobsRevision:fresh.jobsRevision})
 assert.equal(applied.applied,true);assert.equal(listCaptureInputs(dir).inputs.length,2)
 assert.ok(listCaptureInputs(dir).inputs.some(r=>r.id===b.id));assert.equal(listCaptureJobs(dir).jobs.find(j=>j.id===jb.id).status,'uncertain')
}))

test('输入CLI默认只读，明确清理须同时带两份版本',()=>box(dir=>{
 const script=fileURLToPath(new URL('./scripts/capture-jobs.mjs',import.meta.url)),env={...process.env,DSH_HOME:dir}
 const run=(...args)=>spawnSync(process.execPath,[script,...args],{env,encoding:'utf8',timeout:5000})
 assert.equal(run('inputs').status,0);assert.equal(existsSync(join(dir,'memory')),false)
 const store=join(dir,'memory'),row=enqueueCaptureInput(store,descriptor());blockCaptureInput(store,row.id,'source-changed')
 const preview=JSON.parse(run('inputs-prune').stdout)
 assert.equal(run('inputs-prune','--apply','--revision',String(preview.revision)).status,1)
 assert.equal(run('inputs-prune','--apply','--revision',String(preview.revision),'--jobs-revision',String(preview.jobsRevision)).status,0)
 assert.equal(listCaptureInputs(store).inputs.length,0)
}))

test('原会话读取硬超时不领取模型调用，迟到观察仍释放',async()=>{
 let release,disposed=0
 const query={observeSession:()=>new Promise(r=>{release=r})}
 await assert.rejects(observeCaptureSource(query,'synthetic',10),/source-unavailable/)
 release({[Symbol.dispose](){disposed++}});await new Promise(r=>setTimeout(r,10))
 assert.equal(disposed,1)
 await assert.rejects(observeCaptureSource(query,'synthetic',0),/invalid-timeout/)
})

function mount(dir,{mutatePrepare,changedEvents=events,cwd='/synthetic/project',llmOverride,serviceControl}={}){
 const handlers=new Map(),liveSessions=new Map();let calls=0,streams=0,disposed=0
 const llm=llmOverride??{listProviders:()=>[route],async prepareCall(){calls++;mutatePrepare?.();return{config:{},async *stream(request){streams++
  const input=JSON.parse(request.messages[0].content[0].text.split('\n').find(l=>l.startsWith('{')))
  yield JSON.stringify([{type:'user',scope:'global',meaning:{kind:'claim'},basis:'explicit',summary:'回答先给明确结论再解释依据',evidence:[{messageId:input.id,quote:'以后所有回复都先给明确结论'}]}])
 }}}}
 const ctx={systemPrompt:{context(){}},tools:{register(){}},workingDirectory:{get:()=>cwd},llm,
  sessionQuery:{async observeSession(id){return{header:{...session().header,id},events:changedEvents,[Symbol.dispose](){disposed++}}}},on(name,fn){handlers.set(name,name==='session/created'?session=>{liveSessions.set(session.id,session);return fn(session)}:name==='session/disposed'?session=>{try{return fn(session)}finally{liveSessions.delete(session.id)}}:fn)}}
 if(serviceControl){
  serviceControl.cleanup=[]
  ctx.get=name=>name==='llm'?llm:name==='sessionQuery'&&serviceControl.available?ctx.sessionQuery:undefined
  ctx.effect=fn=>serviceControl.cleanup.push(fn())
  if(serviceControl.injected)ctx.inject=(names,fn)=>{
   // Native-write admission independently observes the already active LLM.
   // Query-service readiness/release below must not replace that owning scope.
   if(names.length===1&&names[0]==='llm'){fn({...ctx,effect:callback=>serviceControl.cleanup.push(callback())});return}
   assert.deepEqual(names,['sessionQuery'])
   serviceControl.activate=()=>{const cleanups=[];fn({...ctx,effect:callback=>cleanups.push(callback())});serviceControl.release=()=>cleanups.reverse().forEach(run=>run())}
   if(serviceControl.available)serviceControl.activate()
  }
 }
 const before=process.env.DSH_HOME;process.env.DSH_HOME=dir
 try{prepareMountedFixture();apply(ctx,{autoCapture:{everyTurns:1}})}finally{if(before===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=before}
 return{handlers,ctx,liveSessions,get calls(){return calls},get streams(){return streams},get disposed(){return disposed}}
}
async function withHome(dir,fn){const before=process.env.DSH_HOME;process.env.DSH_HOME=dir;try{return await fn()}finally{if(before===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=before}}

test('完整接线：恢复原会话即重建未调用输入，经原证据闸写入一次，第二次恢复不重发',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory');enqueueCaptureInput(store,descriptor())
 const host=mount(dir);host.handlers.get('session/created')(session())
 await until(()=>existsSync(join(store,'MEMORY.md')))
 await until(()=>host.disposed===1)
 assert.equal(host.calls,2);assert.equal(host.streams,1)
 assert.match(readFileSync(join(store,'MEMORY.md'),'utf8'),/先给明确结论/)
 assert.equal(listCaptureInputs(store).inputs[0].status,'bound')
 host.handlers.get('session/created')(session());await new Promise(r=>setTimeout(r,30));assert.equal(host.calls,2)
})))

test('领取调用后绑定前崩溃的窗口：原会话恢复只补绑定，不重发未知调用',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory'),row=enqueueCaptureInput(store,descriptor());claimCaptureJob(store,row.id)
 const host=mount(dir);host.handlers.get('session/created')(session())
 await until(()=>listCaptureInputs(store).inputs[0].status==='bound')
 assert.equal(host.calls,0);assert.equal(listCaptureJobs(store).jobs[0].status,'running')
})))

test('准备模型期间撤回来源：发送前阻断；不写入旧正文',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory');enqueueCaptureInput(store,descriptor());const s=session()
 const host=mount(dir,{mutatePrepare(){s.surface.nodes=[]}})
 host.handlers.get('session/created')(s)
 await until(()=>listCaptureJobs(store).jobs[0]?.status==='failed')
 assert.equal(host.calls,1);assert.equal(host.streams,0);assert.equal(existsSync(join(store,'MEMORY.md')),false)
})))

test('已标撤回的来源即使原日志仍在也不允许补跑',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory');enqueueCaptureInput(store,descriptor())
 const review=withdrawManagedSource(store,session().id,'session-synthetic-input:0',{scope:'global'})
 withdrawManagedSource(store,session().id,'session-synthetic-input:0',{scope:'global',apply:true,reviewedIndex:review.reviewedIndex,candidateRevision:review.candidateRevision})
 const host=mount(dir);host.handlers.get('session/created')(session())
 await until(()=>listCaptureInputs(store).inputs[0].status==='blocked')
 assert.equal(listCaptureInputs(store).inputs[0].reason,'source-withdrawn');assert.equal(host.calls,0)
})))

test('不再可见的来源在恢复时显式阻断，没有模型调用',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory');enqueueCaptureInput(store,descriptor());const s=session();s.surface.nodes=[]
 const host=mount(dir);host.handlers.get('session/created')(s)
 await until(()=>listCaptureInputs(store).inputs[0].status==='blocked')
 assert.equal(host.calls,0);assert.equal(host.disposed,1)
})))

test('服务晚于原会话恢复就绪：不唤醒代理也能重建未领取输入，重复就绪不重复调用',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory');enqueueCaptureInput(store,descriptor())
 const control={available:false,injected:true},host=mount(dir,{serviceControl:control}),s=session()
 host.handlers.get('session/created')(s)
 await new Promise(r=>setTimeout(r,20));assert.equal(host.calls,0)
 control.available=true;control.activate()
 await until(()=>existsSync(join(store,'MEMORY.md')))
 await until(()=>host.disposed===1)
 assert.equal(host.calls,2)
 assert.equal(listCaptureInputs(store).inputs[0].status,'bound')
 assert.equal(JSON.parse(readFileSync(join(store,'.loaded.json'))).autoCapture.inputRecovery.available,true)
 control.release();control.available=false
 assert.equal(JSON.parse(readFileSync(join(store,'.loaded.json'))).autoCapture.inputRecovery.available,false)
 control.available=true;control.activate();await new Promise(r=>setTimeout(r,30))
 assert.equal(host.calls,2)
 control.cleanup.reverse().forEach(run=>run())
})))

test('兼容无依赖子作用域的上下文：首次捕获时重新发现活动查询服务并持久入队',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory'),control={available:false},host=mount(dir,{serviceControl:control}),s=session()
 host.handlers.get('session/event')(s,event)
 control.available=true
 host.handlers.get('session/event')(s,{type:'step/end'})
 await until(()=>existsSync(join(store,'MEMORY.md')))
 assert.equal(listCaptureInputs(store).inputs[0].status,'bound')
 assert.equal(host.calls,2)
 control.cleanup.reverse().forEach(run=>run())
})))

test('准备期间查询服务消失：不发送模型流，旧输入保持绑定且服务重来不重发',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory');enqueueCaptureInput(store,descriptor())
 const control={available:true,injected:true},host=mount(dir,{serviceControl:control,mutatePrepare(){control.release();control.available=false}})
 host.handlers.get('session/created')(session())
 await until(()=>listCaptureJobs(store).jobs[0]?.status==='failed')
 assert.equal(host.calls,1);assert.equal(host.streams,0)
 assert.equal(existsSync(join(store,'MEMORY.md')),false)
 assert.equal(listCaptureInputs(store).inputs[0].status,'bound')
 control.available=true;control.activate();await new Promise(r=>setTimeout(r,30))
 assert.equal(host.calls,1)
 control.cleanup.reverse().forEach(run=>run())
})))

test('捕获流等待期间查询服务卸载：忽略取消的迟到正文也不能写入',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory');enqueueCaptureInput(store,descriptor())
 let finish,started=false,calls=0
 const llm={async prepareCall(){calls++;return{config:{},async *stream(){started=true;await new Promise(r=>finish=r);yield JSON.stringify([{type:'user',scope:'global',meaning:{kind:'claim'},basis:'explicit',summary:'回答先给明确结论再解释依据',evidence:[{messageId:'session-synthetic-input:0',quote:'以后所有回复都先给明确结论'}]}])}}}}
 const control={available:true,injected:true},host=mount(dir,{serviceControl:control,llmOverride:llm})
 host.handlers.get('session/created')(session());await until(()=>started)
 control.release();control.available=false
 await until(()=>listCaptureJobs(store).jobs[0]?.status==='failed')
 finish();await new Promise(r=>setTimeout(r,20))
 assert.equal(calls,1);assert.equal(existsSync(join(store,'MEMORY.md')),false)
 control.cleanup.reverse().forEach(run=>run())
})))

test('插件卸载后服务才就绪，不能重新订阅或执行已观察会话的输入',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory');enqueueCaptureInput(store,descriptor())
 const control={available:false,injected:true},host=mount(dir,{serviceControl:control})
 host.handlers.get('session/created')(session())
 control.cleanup.reverse().forEach(run=>run())
 control.available=true;control.activate();await new Promise(r=>setTimeout(r,30))
 assert.equal(host.calls,0);assert.equal(listCaptureInputs(store).inputs[0].status,'pending')
})))

test('多个已恢复会话等待服务：来源恢复最多并行两项，并最终处理所有已观察待办',()=>box(dir=>withHome(dir,async()=>{
 const store=join(dir,'memory'),activeSessions=Array.from({length:4},(_,i)=>{const s=session();s.id+='-'+i;s.header={...s.header,id:s.id};return s})
 for(const s of activeSessions)enqueueCaptureInput(store,descriptor(s))
 let calls=0,active=0,peak=0
 const llm={async prepareCall(){calls++;active++;peak=Math.max(peak,active);return{config:{},async *stream(){await new Promise(r=>setTimeout(r,20));active--;yield '[]'}}}}
 const control={available:false,injected:true},host=mount(dir,{serviceControl:control,llmOverride:llm})
 for(const s of activeSessions)host.handlers.get('session/created')(s)
 control.available=true;control.activate()
 await until(()=>{const jobs=listCaptureJobs(store).jobs;return jobs.length===4&&jobs.every(job=>job.status==='succeeded')})
 assert.equal(calls,4);assert.ok(peak<=2);assert.ok(peak>=1)
 control.cleanup.reverse().forEach(run=>run())
})))
