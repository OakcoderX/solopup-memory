import {applyWithValidationFixture as apply} from './fixture-host.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash,randomUUID} from 'node:crypto'
import {indexLine, searchStore, withdrawManagedSource, adoptCandidate, storeRevision, recoverMemoryPublication} from './index.mjs'
import {writeFixtureMemory} from './fixture-host.mjs'
import {listCaptureJobs} from './capture-jobs.mjs'
import {candidateSnapshot,stageCandidate} from './candidates.mjs'
import {normalizeMeaning} from './meaning.mjs'
import {buildUserPrompt} from './capture-llm.mjs'
const hash=text=>createHash('sha256').update(text).digest('hex')
async function box(run,options={}){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-belief-'))),home=join(base,'home'),cwd=join(base,'project'),previous=process.env.DSH_HOME
 mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 const captured={tools:[],handlers:[]},ctx={systemPrompt:{context(entry){captured.context=entry}},workingDirectory:{get(){return cwd}},tools:{register(tool){captured.tools.push(tool)}},on(name,handler){captured.handlers.push([name,handler])},...options.llm?{llm:options.llm}:{}}
 try{apply(ctx,{autoCapture:options.autoCapture??{enabled:false}});await run({root:join(home,'memory'),home,cwd,captured})}
 finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
}
function seed(root,summary,meaning,extra={}){
 const scope=extra.scope??'global';writeFixtureMemory({type:'user',scope,dir:root,line:indexLine('user',summary),summary,meaning,...extra})
 return candidateSnapshot(root,scope).records.find(record=>record.summary===summary)
}
const hypothesis=root=>seed(root,'长期暂定假设：暖色使这个画面更亲近',{kind:'belief',alternatives:['也可能只是构图更好'],falsifiedBy:['保持构图和交期，仅改变色温后不再选暖色']})
const evidence=(root,target,summary,stance='contradicts',extra={})=>seed(root,summary,{kind:'episode',relations:[{target:target.id,stance}]},extra)
const read=(root,options={})=>searchStore(root,'长期暂定假设',{mode:'exact',task:{affectsDecision:true,experimentPossible:true},...options}).hits[0]?.interpretation
test('counterobservation changes belief assessment and next advice without inventing verified truth',()=>box(({root})=>{
 const target=hypothesis(root);assert.equal(read(root).revision.state,'unassessed');assert.equal(read(root).advice.action,'propose-experiment')
 const report=evidence(root,target,'控制构图和交期后，用户报告改选冷色完成交付')
 const view=read(root);assert.equal(view.recordId,target.id);assert.equal(view.revision.state,'challenged');assert.equal(view.revision.counterSourceGroups,1)
 assert.deepEqual(view.revision.counterRecords,[report.id]);assert.equal(view.advice.action,'verify');assert.equal(view.revision.worldVerified,false);assert.equal(view.epistemic,'tentative-belief');assert.equal(view.advice.authority,'none')
}))
test('support and counterreports preserve conflict; two reported supports do not promote claim to fact',()=>box(({root})=>{
 const target=hypothesis(root);evidence(root,target,'第一轮交期不变，报告又选暖色草稿','supports');evidence(root,target,'第二轮构图固定，报告选用暖色方案','supports')
 let view=read(root);assert.equal(view.revision.state,'reported-support');assert.equal(view.revision.supportSourceGroups,2);assert.equal(view.revision.worldVerified,false)
 evidence(root,target,'第三轮独立会话报告转选冷色清稿');view=read(root);assert.equal(view.revision.state,'conflicted');assert.equal(view.advice.action,'verify')
}))
test('source withdrawal immediately removes derived challenge; restoring stale files cannot revive it',()=>box(({root})=>{
 const target=hypothesis(root),report=evidence(root,target,'撤回测试：控制变量后用户报告选择冷色')
 const backup=new Map(['MEMORY.md','.candidates.json','.episodes.json'].map(name=>[name,readFileSync(join(root,name))]));assert.equal(read(root).revision.state,'challenged')
 const plan=withdrawManagedSource(root,report.sessionId,report.evidence[0].messageId);withdrawManagedSource(root,report.sessionId,report.evidence[0].messageId,{apply:true,controlReview:plan.controlReview})
 assert.equal(read(root).revision.state,'unassessed')
 for(const [name,body]of backup)writeFileSync(join(root,name),body)
 assert.equal(read(root).revision.state,'unassessed');assert.equal(read(root).revision.counterSourceGroups,0)
}))
test('withdrawing one report preserves an independent confirmation of the observation',()=>box(({root})=>{
 const target=hypothesis(root),first=evidence(root,target,'原始陈述：保持构图后转而选择冷色稿')
 const second=evidence(root,target,'另一来源重新确认：受控比较里仍选了冷色版本')
 const plan=withdrawManagedSource(root,first.sessionId,first.evidence[0].messageId);withdrawManagedSource(root,first.sessionId,first.evidence[0].messageId,{apply:true,controlReview:plan.controlReview})
 assert.equal(read(root).revision.state,'challenged');assert.deepEqual(read(root).revision.counterRecords,[second.id])
}))
test('same-root paraphrases and target-root repetition never multiply source support',()=>box(({root})=>{
 const target=hypothesis(root),provenance={basis:'tool-context',sessionId:target.sessionId,evidence:target.evidence,callHash:hash(randomUUID())}
 evidence(root,target,'对旧假设原话的重新整理，不能成为新实验','supports',{provenance})
 assert.equal(read(root).revision.state,'unassessed');assert.equal(read(root).revision.dependentReports,1)
 const stable={basis:'tool-context',sessionId:'one-observation',evidence:[{messageId:'one-event',hash:hash('original observation'),quote:'独立观察陈述'}]}
 evidence(root,target,'笔记甲记下受控比较后仍选择暖色','supports',{provenance:{...stable,callHash:hash('call-a')}})
 evidence(root,target,'摘要乙转述上述受控比较的暖色选择','supports',{provenance:{...stable,callHash:hash('call-b')}})
 assert.equal(read(root).revision.supportSourceGroups,1);assert.equal(read(root).revision.supportingRecords.length,2)
}))
test('transitive shared roots merge into one group, including inconsistent interpretations',()=>box(({root})=>{
 const target=hypothesis(root)
 for(const [name,ids,stance]of [['甲报告构图固定后选暖色',['a','b'],'supports'],['乙报告交期一致后选冷色',['b','c'],'contradicts'],['丙整理两轮比较仍选暖色',['c','d'],'supports']]){
  evidence(root,target,name,stance,{provenance:{basis:'tool-context',sessionId:'shared-roots',callHash:hash(name),evidence:ids.map(id=>({messageId:id,hash:hash(id),quote:'对照结果 '+id}))}})
 }
 const state=read(root).revision;assert.equal(state.supportSourceGroups,1);assert.equal(state.counterSourceGroups,1);assert.equal(state.mixedSourceGroups,1);assert.equal(state.state,'conflicted')
}))
test('observation applicability is three-valued; missing context does not become counterevidence',()=>box(({root})=>{
 const target=hypothesis(root);seed(root,'只对专业评审的比较，结果报告选择冷色',{kind:'episode',conditions:[{dimension:'audience',value:'review'}],relations:[{target:target.id,stance:'contradicts'}]})
 assert.equal(read(root).revision.state,'unassessed');assert.equal(read(root).revision.unknownApplicabilityReports,1)
 assert.equal(read(root,{context:{audience:'children'}}).revision.unknownApplicabilityReports,0)
 assert.equal(read(root,{context:{audience:'review'}}).revision.state,'challenged')
}))
test('expired observation is not a current premise; historical query does not borrow the current assessment',()=>box(({root})=>{
 const target=hypothesis(root);evidence(root,target,'很早以前的观察报告，不能当本轮现行前提','contradicts',{expires:'2000-01-01'})
 assert.equal(read(root).revision.state,'unassessed')
 const past=searchStore(root,'长期暂定假设',{view:'history',atSequence:1,mode:'exact'}).hits[0].interpretation
 assert.equal(past.recordId,target.id);assert.equal(past.revision,undefined);assert.equal(past.advice.action,'continue')
}))
test('relation targets must be exact current same-store claims; values, absent IDs and derived cycles are rejected',()=>box(({root,home})=>{
 const target=hypothesis(root),value=seed(root,'探索新方法优先于沿用熟悉方案',{kind:'value'})
 assert.throws(()=>evidence(root,value,'不能让审美价值变成世界事实的证据'),/target-not-current-claim/)
 assert.throws(()=>evidence(root,{id:'f'.repeat(64)},'不能给不存在的主张添加支持关系'),/target-not-current-claim/)
 const other=join(home,'unrelated');mkdirSync(other)
 assert.throws(()=>evidence(other,target,'别的库不能直接引用当前库主张身份'),/target-not-current-claim/)
 const derived=seed(root,'报告称受控比较使原假设受到挑战',{kind:'claim',relations:[{target:target.id,stance:'contradicts'}]})
 assert.throws(()=>evidence(root,derived,'再用该整理关系支持一个循环链条'),/target-is-derived-relation/)
}))
test('relation canonicalization rejects forged confidence, invalid kind, duplicate polarities, shortened target and excess links',()=>{
 const link={target:'a'.repeat(64),stance:'contradicts'}
 for(const meaning of [{kind:'value',relations:[link]},{kind:'belief',relations:[link]},{kind:'episode',relations:[{...link,verified:true}]},{kind:'episode',relations:[link,{...link,stance:'supports'}]},{kind:'episode',relations:[{...link,target:'a'.repeat(8)}]},{kind:'episode',relations:Array.from({length:4},(_,i)=>({...link,target:String(i).repeat(64)}))}])assert.throws(()=>normalizeMeaning(meaning),/invalid-relations/)
 assert.equal(normalizeMeaning({kind:'belief'}).relations,undefined,'Legacy source identities keep their original canonical bytes')
})
test('pending inferred evidence has no effect until reviewed adoption; later withdrawal recomputes assessment',()=>box(({root})=>{
 const target=hypothesis(root),proposal={type:'user',scope:'global',summary:'待审的比较记录说构图固定后改选冷色',meaning:{kind:'episode',relations:[{target:target.id,stance:'contradicts'}]},sessionId:'pending-evidence',evidence:[{messageId:'one',hash:hash('one'),quote:'这次比较后我改选冷色稿'}],indexRevision:storeRevision(root)}
 const staged=stageCandidate(root,proposal);assert.equal(read(root).revision.state,'unassessed')
 const preview=adoptCandidate(root,staged.id,{scope:'global'});adoptCandidate(root,staged.id,{scope:'global',apply:true,candidateRevision:preview.candidateRevision,reviewedIndex:preview.reviewedIndex,controlRevision:preview.controlRevision})
 assert.equal(read(root).revision.state,'challenged')
 const plan=withdrawManagedSource(root,proposal.sessionId,'one');withdrawManagedSource(root,proposal.sessionId,'one',{apply:true,controlReview:plan.controlReview});assert.equal(read(root).revision.state,'unassessed')
}))
test('current injected context exposes challenged status instead of repeating an unqualified belief',()=>box(({root,captured})=>{
 const target=hypothesis(root);evidence(root,target,'上下文验证：报告在固定构图后改选冷色')
 const text=captured.context.text({agent:{session:{id:'injection'}}});assert.match(text,/challenged/);assert.match(text,/不是独立验证或置信度/);assert.ok(text.includes(target.id))
}))
test('automatic extraction target list is bounded and leaves supersedes index lines intact',()=>{
 const old='[global] - [user] 旧主张 — 索引摘要',targets=Array.from({length:60},(_,i)=>({scope:'global',recordId:hash('target'+i),kind:'belief',summary:'供关联的旧假设'+i+'。'.repeat(100)}))
 const prompt=buildUserPrompt([{id:'one',role:'user',text:'新的受控观察说结果与旧假设相反。'}],[old],3,2048,targets)
 assert.ok(Buffer.byteLength(prompt)<=2048);assert.match(prompt,/现行目标/);assert.ok(prompt.includes(old));assert.ok(prompt.includes('新的受控观察'));assert.match(prompt,/省略[1-9]/)
})
test('superseding the evidence recomputes polarity; superseding a claim does not transfer old observations to a new proposition',()=>box(({root})=>{
 const target=hypothesis(root),first=evidence(root,target,'最初比较报告称控制构图后仍选择冷色')
 evidence(root,target,'更正实验抄录：固定构图后实际选择的是暖色','supports',{supersedes:first.summary})
 assert.equal(read(root).revision.state,'reported-support');assert.equal(read(root).revision.counterSourceGroups,0)
 seed(root,'长期暂定假设已改变：选择主要由交付时限决定',{kind:'belief'},{supersedes:target.summary})
 assert.equal(read(root).revision.state,'unassessed');assert.equal(read(root).revision.supportSourceGroups,0)
 assert.throws(()=>evidence(root,target,'新观察不能再引用已被取代的旧命题'),/target-not-current-claim/)
}))
test('failed evidence publication blocks reads until recovery; only committed ledger participates in revision',()=>box(({root})=>{
 const target=hypothesis(root)
 assert.throws(()=>evidence(root,target,'中断发布的受控比较报告，不允许半条证据生效','contradicts',{publicationFault({phase}){if(phase==='journal')throw Error('synthetic-interruption')}}),/synthetic-interruption/)
 assert.throws(()=>read(root),/publication-needs-recovery/)
 recoverMemoryPublication(root,{apply:true});assert.equal(read(root).revision.state,'challenged')
 recoverMemoryPublication(root,{apply:true});assert.equal(read(root).revision.counterSourceGroups,1)
}))
test('automatic capture receives real current target IDs and publishes the observation with quoted lineage',()=>{
 let currentTarget,provided=false
 const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},prepareCall:async()=>({config:{},stream:async function*(request){
  const prompt=request.messages[0].content[0].text;provided=prompt.includes(currentTarget.id)
  const message=JSON.parse(prompt.split('对话片段：\n')[1].split('\n')[0])
  yield{type:'text-delta',text:JSON.stringify([{type:'user',scope:'global',basis:'explicit',summary:'受控比较的新观察报告：固定构图和交期后转选冷色',meaning:{kind:'episode',relations:[{target:currentTarget.id,stance:'contradicts'}]},evidence:[{messageId:message.id,quote:message.text}]}])};yield{type:'finish',reason:{kind:'stop'}}
 }})}
 return box(async({root,captured})=>{
  currentTarget=hypothesis(root);const session={id:'automatic-evidence'},emit=event=>{for(const [name,handler]of captured.handlers)if(name==='session/event')handler(session,event)}
  emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text:'请长期保留新观察：固定构图和交期后，我转选冷色。这反驳原来的色温假设。'}]}}});emit({type:'step/end',data:{}})
  const path=join(root,'.capture-state.json'),until=Date.now()+4000;let state
  while(Date.now()<until){state=existsSync(path)?JSON.parse(readFileSync(path)):undefined;if(state?.lastCaptureAt&&!state.running)break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(provided,true);assert.equal(state.lastOutcome,'ok');assert.equal(read(root).revision.state,'challenged')
  const observation=candidateSnapshot(root,'global').records.find(record=>record.meaning?.relations?.length)
  assert.equal(observation.origin,'quoted-extraction');assert.equal(observation.sessionId,session.id)
 },{llm,autoCapture:{everyTurns:1}})
})

test('full record identities retrieve the precise premise in exact and ranked current/history views',()=>box(({root})=>{
 const target=hypothesis(root),report=evidence(root,target,'身份导航测试：控制构图后转选冷色')
 for(const mode of ['exact','ranked'])for(const view of ['current','history']){
  const hits=searchStore(root,report.id,{mode,view}).hits
  assert.ok(hits.length);assert.ok(hits.every(hit=>hit.interpretation.recordId===report.id));assert.ok(hits.some(hit=>hit.text.includes('身份导航测试')))
 }
}))

test('all rejected extraction is distinct from an empty no-op and persists a terminal failed job without discarding evidence to force admission',()=>{
 const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},prepareCall:async()=>({config:{},stream:async function*(request){
  const prompt=request.messages[0].content[0].text,message=JSON.parse(prompt.split('对话片段：\n')[1].split('\n')[0])
  yield{type:'text-delta',text:JSON.stringify([{type:'user',scope:'global',basis:'explicit',summary:'有四份引用的假设必须按既定上限拒绝',meaning:{kind:'belief'},evidence:Array.from({length:4},()=>({messageId:message.id,quote:message.text}))}])};yield{type:'finish',reason:{kind:'stop'}}
 }})}
 return box(async({root,captured})=>{
  const session={id:'all-rejected'},emit=event=>{for(const [name,handler]of captured.handlers)if(name==='session/event')handler(session,event)}
  emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text:'请长期保留这个暂定假设，并保留对应来源。'}]}}});emit({type:'step/end',data:{}})
  const path=join(root,'.capture-state.json'),until=Date.now()+4000;let state
  while(Date.now()<until){state=existsSync(path)?JSON.parse(readFileSync(path)):undefined;if(state?.lastCaptureAt&&!state.running)break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(state.lastOutcome,'rejected');assert.equal(state.lastError,'capture-all-rejected');assert.equal(searchStore(root,'四份引用').hits.length,0)
  const job=listCaptureJobs(root).jobs.find(job=>job.id===state.jobId);assert.equal(job.status,'failed');assert.equal(job.outcome,'rejected');assert.equal(job.reason,'capture-all-rejected');assert.deepEqual(job.counts,{proposed:1,inserted:0,staged:0,rejected:1})
 },{llm,autoCapture:{everyTurns:1}})
})
