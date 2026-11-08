/** Synthetic, scripted transport tests; no claim of real-model semantic quality. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,rmSync,readFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply,storeDirFor,searchStore,withdrawManagedSource} from '../index.mjs'
import {candidateSnapshot} from '../candidates.mjs'
import {VALIDATION_FIELDS} from '../capture-validation-contract.mjs'
import {writeFixtureMemory} from '../fixture-host.mjs'
const proposal={type:'user',scope:'global',summary:'长期反馈先列两处问题再给办法',meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'}]}}
const text='跨我的所有项目，长期反馈都先列两处问题再给修改办法。'
async function box(options,run){
 if(typeof options==='function'){run=options;options={}}
 const base=realpathSync(mkdtempSync(join(tmpdir(),'native-validator-'))),home=join(base,'home'),old=process.env.DSH_HOME
 mkdirSync(home);process.env.DSH_HOME=home
 const root=join(home,'memory'),handlers=[],tools=[],effects=[],requests=[],session={id:'synthetic-native-validator'}
 let seq=0,turn=0,cwd=join(base,'project-a'),f;mkdirSync(cwd)
 const llm={async prepareCall(config){await options.beforePrepare?.(f);return{config,async*stream(req){
  requests.push(req);assert.equal(req.purpose,'memory-validation');const input=JSON.parse(req.messages[0].content[0].text)
  await options.duringStream?.(f,input)
  const state=options.state??'supported',checks=input.candidates.map(r=>({candidateId:r.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(k=>[k,options.fields?.[k]??state])),evidence:state==='uncertain'?[]:options.evidence?options.evidence(input):r.value.evidence.map(({messageId,quote})=>({messageId,quote}))}))
  if(options.rewrite)checks[0].summary='伪造改写'
  yield{type:'text-delta',text:JSON.stringify({checks})};yield{type:'finish',reason:{kind:'stop'}}
 }}}}
 const ctx={...options.offline?{}:{llm},systemPrompt:{context(){}},workingDirectory:{get:()=>cwd},tools:{register:t=>tools.push(t)},on:(name,fn)=>handlers.push([name,fn]),effect:fn=>{const dispose=fn();if(typeof dispose==='function')effects.push(dispose)}}
 const agent={session,options:{provider:'fixture',model:'fixture'}},emit=(name,...args)=>{for(const[event,fn]of handlers)if(event===name)fn(...args)}
 apply(ctx,{autoCapture:{enabled:false,timeoutMs:options.timeoutMs??2000}})
 const tool=tools.find(t=>t.name==='memory_write')
 f={base,root,session,agent,ctx,requests,tool,effects,emit,
  cwd(value){if(value===undefined)return cwd;cwd=value;mkdirSync(cwd,{recursive:true})},
  owner(value=text,{queued=false}={}){const message={id:'owner-'+(++seq),role:'user',source:{kind:'user'},content:[{type:'text',text:value}]};if(!queued)emit('agent/pre-step',{agent,turn:++turn,step:1,messages:[message]},()=>{});emit('session/event',session,{type:'user/message',seq,data:message});return session.id+':'+seq},
  call(id='native-'+(++seq)){emit('session/event',session,{type:'tool/call',seq:++seq,data:{callId:id,name:'memory_write',arguments:'{}',turn,step:1}});return{agent,callId:id}},
  records:()=>candidateSnapshot(root,'global').records,
  rendered:value=>tool.output.render({},value).map(b=>b.text).join('\n')}
 try{return await run(f)}finally{for(const dispose of effects)dispose();if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;rmSync(base,{recursive:true,force:true})}
}
test('native approval publishes the unchanged typed candidate; exact replay is an explicit no-op',()=>box(async f=>{
 f.owner();const exec=f.call(),result=await f.tool.execute(proposal,exec)
 assert.equal(result.status,'recorded');assert.equal(f.records()[0].summary,proposal.summary);assert.equal(f.requests.length,1)
 assert.equal((await f.tool.execute(proposal,exec)).status,'duplicate');assert.equal(f.requests.length,1)
}))
test('unrelated native admission does not disclose saved private records to its reviewer',()=>box({duringStream:(_f,input)=>{
 assert.doesNotMatch(JSON.stringify(input.currentMemory),/1993|4月16|个人档案/)
}},async f=>{
 writeFixtureMemory({dir:f.root,type:'user',scope:'global',summary:'个人档案：出生于1993年4月16日，女性',meaning:{kind:'claim'}})
 f.owner();const result=await f.tool.execute(proposal,f.call());assert.equal(result.status,'recorded')
}))
test('definite rejection leaves no current or pending memory and does not render success',()=>box({state:'unsupported'},async f=>{
 f.owner();const result=await f.tool.execute(proposal,f.call());assert.equal(result.status,'rejected');assert.equal(f.records().length,0);assert.doesNotMatch(f.rendered(result),/已写入/);assert.equal(searchStore(f.root,'长期反馈').hits.length,0)
}))
for(const mode of ['uncertain','offline','rewrite'])test(mode+' retains only a non-injected fresh pending candidate',()=>box({state:mode==='uncertain'?'uncertain':'supported',offline:mode==='offline',rewrite:mode==='rewrite'},async f=>{
 f.owner();const result=await f.tool.execute(proposal,f.call());assert.equal(result.status,'pending-review');assert.equal(f.records()[0].status,'pending');assert.equal(f.records()[0].summary,proposal.summary);assert.equal(searchStore(f.root,'长期反馈').hits.length,0);assert.doesNotMatch(f.rendered(result),/已写入/)
}))
test('a real short owner source uses minimumQuoteLength=1 without weakening the pending inbox',()=>box(async f=>{
 f.owner('记住红色');const result=await f.tool.execute({...proposal,summary:'长期偏好红色',meaning:{kind:'preference'}},f.call());assert.equal(result.status,'recorded');assert.equal(f.records()[0].evidence[0].quote,'记住红色');assert.equal(JSON.parse(f.requests[0].messages[0].content[0].text).minimumQuoteLength,1)
}))
test('offline short sources cannot become source-free or schema-weakened pending memory',()=>box({offline:true},async f=>{
 f.owner('记住红色');const result=await f.tool.execute(proposal,f.call());assert.equal(result.status,'not-applied');assert.equal(result.reason,'pending-source-too-short');assert.equal(f.records().length,0)
}))
test('all additional same-project owner citations remain roots of a native accepted memory',()=>box({evidence:input=>input.ownerMessages.map(m=>({messageId:m.id,quote:m.text}))},async f=>{
 const older=f.owner('反馈顺序是先两处问题，再说修改办法。');f.owner('这个顺序是跨项目的长期约定。');await f.tool.execute(proposal,f.call())
 const record=f.records().find(r=>r.status==='recorded');assert.equal(record.evidence.length,2);assert.ok(record.evidence.some(e=>e.messageId===older))
 const plan=withdrawManagedSource(f.root,f.session.id,older);withdrawManagedSource(f.root,f.session.id,older,{apply:true,controlReview:plan.controlReview});assert.equal(searchStore(f.root,'长期反馈').hits.length,0)
}))
test('another project, queued input, and later input are excluded from native validation history',()=>box(async f=>{
 f.owner('Earlier project-specific owner source must stay in project A.');f.cwd(join(f.base,'project-b'))
 f.owner('This queued input has not been admitted to the agent.',{queued:true});const current=f.owner();const exec=f.call();f.owner('This later input cannot support the earlier call.',{queued:true})
 await f.tool.execute(proposal,exec);const input=JSON.parse(f.requests[0].messages[0].content[0].text);assert.deepEqual(input.ownerMessages.map(m=>m.id),[current])
}))
test('a claimed native call cannot resend validation by changing candidate arguments',()=>box({state:'uncertain'},async f=>{
 f.owner();const exec=f.call();await f.tool.execute(proposal,exec);const next=await f.tool.execute({...proposal,summary:'改变候选参数也不能重发同一调用'},exec);assert.equal(next.status,'pending-review');assert.equal(next.reason,'previous-invocation');assert.equal(f.requests.length,1);assert.equal(f.records().some(r=>r.status==='recorded'),false)
}))
for(const mode of ['cwd','route','dispose','withdraw','index'])test(mode+' changing during native validation cannot publish or stage stale content',()=>box({duringStream(f){
 if(mode==='cwd')f.cwd(join(f.base,'project-b'))
 if(mode==='route')f.agent.options.model='changed-model'
 if(mode==='dispose')f.emit('session/disposed',f.session)
 if(mode==='withdraw'){const plan=withdrawManagedSource(f.root,f.session.id,f.ownerId);withdrawManagedSource(f.root,f.session.id,f.ownerId,{apply:true,controlReview:plan.controlReview})}
 if(mode==='index')storeDirFor('project',f.cwd()) // Project registration changes the managed control revision.
}},async f=>{
 f.ownerId=f.owner();const exec=f.call();await assert.rejects(()=>f.tool.execute(proposal,exec));assert.equal(f.records().some(r=>['pending','recorded'].includes(r.status)),false)
}))
test('unload during prepare aborts before a native validation stream is dispatched',()=>box({beforePrepare(f){for(const dispose of f.effects)dispose()}},async f=>{
 f.owner();await assert.rejects(()=>f.tool.execute(proposal,f.call()));assert.equal(f.requests.length,0);assert.equal(f.records().length,0)
}))
test('long owner messages cannot silently lose a trailing exception at the 2000-character bound',()=>box(async f=>{
 f.owner('甲'.repeat(2001)+'但是仅本项目适用。');await assert.rejects(()=>f.tool.execute(proposal,f.call()),/source-incomplete/);assert.equal(f.requests.length,0);assert.equal(f.records().length,0)
}))
test('an unapproved replacement keeps its target intact instead of staging a targetless append',()=>box({state:'uncertain'},async f=>{
 const old=writeFixtureMemory({dir:f.root,type:'user',scope:'global',summary:'之前长期反馈先列一处问题',meaning:{kind:'preference'}})
 f.owner();const result=await f.tool.execute({...proposal,supersedes:old.indexLine,revisionMode:'replace'},f.call());assert.equal(result.status,'not-applied');assert.equal(f.requests.length,1);assert.equal(f.records().filter(r=>r.status==='pending').length,0);assert.equal(searchStore(f.root,'之前长期反馈',{mode:'exact'}).hits.length,1)
}))
test('a missing native route never picks the first configured account',()=>box(async f=>{
 delete f.agent.options.provider;f.owner();const result=await f.tool.execute(proposal,f.call());assert.equal(result.status,'pending-review');assert.equal(f.requests.length,0)
}))

const draftMeaning={kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}]}
function seedDraft(f,expires){writeFixtureMemory({dir:f.root,type:'user',scope:'global',summary:'所有项目仅初稿默认标记为橄榄色',meaning:draftMeaning,expires});return f.records().find(r=>r.status==='recorded')}
function revoke(f,record){const plan=withdrawManagedSource(f.root,record.sessionId,record.evidence[0].messageId);withdrawManagedSource(f.root,record.sessionId,record.evidence[0].messageId,{apply:true,controlReview:plan.controlReview})}
test('native current-state context shows target conditions and expiry without old owner evidence',()=>box(async f=>{
 const old=seedDraft(f,'2030-04-05');f.owner('重新完整约定：跨所有项目、所有阶段默认标记为青色，不再限定初稿，仍只保留到2030年4月5日。')
 const r=await f.tool.execute({type:'user',scope:'global',summary:'所有项目所有阶段默认标记为青色',meaning:{kind:'preference'},expires:'2030-04-05',supersedes:old.indexLine,revisionMode:'replace'},f.call())
 assert.equal(r.status,'recorded');const input=JSON.parse(f.requests[0].messages[0].content[0].text),context=input.currentMemory[0]
 assert.equal(context.targetShown,true);assert.equal(context.records[0].recordId,old.id);assert.equal(context.records[0].expires,old.expires);assert.deepEqual(context.records[0].meaning.conditions,old.meaning.conditions)
 assert.equal(context.records[0].evidence,undefined);assert.equal(input.ownerMessages.some(m=>m.id===old.evidence[0].messageId),false)
}))
test('scripted transition rejection of targetless append leaves old rule current and provides safe feedback',()=>box({fields:{transition:'unsupported'}},async f=>{
 const old=seedDraft(f);f.owner('同一项长期约定，颜色改为青色。')
 const r=await f.tool.execute({type:'user',scope:'global',summary:'所有项目仅初稿默认标记改为青色',meaning:draftMeaning},f.call())
 assert.equal(r.status,'rejected');assert.equal(r.reason,'revision-intent-unsupported');assert.deepEqual(r.reviewIssues,{unsupported:['transition'],uncertain:[]})
 const input=JSON.parse(f.requests[0].messages[0].content[0].text);assert.equal(input.currentMemory[0].records[0].recordId,old.id)
 assert.equal(f.records().length,1);assert.equal(f.records()[0].id,old.id);assert.match(f.rendered(r),/transition/);assert.doesNotMatch(f.rendered(r),/已写入/)
}))
test('native value-only revision binds prior metadata before validation and drops obsolete intermediate roots',()=>box(async f=>{
 const old=seedDraft(f);f.owner('同一项长期约定，颜色改为青色。');
 let r=await f.tool.execute({type:'user',scope:'global',summary:'所有项目仅初稿默认标记改为青色',meaning:{kind:'preference'},supersedes:old.indexLine},f.call());assert.equal(r.status,'recorded');
 const middle=f.records().find(r=>r.status==='recorded'),v=JSON.parse(f.requests[0].messages[0].content[0].text).candidates[0].value;
 assert.equal(v.revisionMode,'value');assert.equal(v.inheritedMetadata.parentId,old.id);assert.deepEqual(v.meaning.conditions,old.meaning.conditions);
 assert.equal(middle.evidence.length,1);assert.notEqual(middle.sessionId,old.sessionId);assert.equal(middle.sources.length,2);
 f.owner('同一项长期约定，再改为紫色。');r=await f.tool.execute({type:'user',scope:'global',summary:'所有项目仅初稿默认标记改为紫色',meaning:{kind:'preference'},supersedes:middle.indexLine},f.call());assert.equal(r.status,'recorded');
 const latest=f.records().find(r=>r.status==='recorded');assert.equal(latest.sources.length,2);assert.ok(latest.sources.includes(old.sources[0]));assert.equal(latest.sources.some(root=>middle.sources.includes(root)&&!old.sources.includes(root)),false);
 revoke(f,middle);assert.ok(searchStore(f.root,'紫色',{context:{document_kind:'draft'}}).hits.length);assert.equal(searchStore(f.root,'紫色',{context:{document_kind:'final'}}).hits.length,0);
 revoke(f,old);assert.equal(searchStore(f.root,'紫色').hits.length,0);
}))
test('native complete restatement carries its own roots and no inherited field certificate',()=>box(async f=>{
 const old=seedDraft(f);f.owner('重新完整约定：跨所有项目，所有阶段默认标记均为青色，不再限定初稿。');
 const r=await f.tool.execute({type:'user',scope:'global',summary:'跨所有项目所有阶段默认标记为青色',meaning:{kind:'preference'},supersedes:old.indexLine,revisionMode:'replace'},f.call());assert.equal(r.status,'recorded');
 const next=f.records().find(r=>r.status==='recorded'),v=JSON.parse(f.requests[0].messages[0].content[0].text).candidates[0].value;
 assert.equal(v.inheritedMetadata,undefined);assert.equal(next.fieldLineage,undefined);assert.deepEqual(next.meaning.conditions,[]);assert.equal(next.sources.length,1);revoke(f,old);assert.ok(searchStore(f.root,'青色',{context:{document_kind:'final'}}).hits.length);
}))
test('native value-only change retains expiry in line, validation and field certificate',()=>box(async f=>{
 const old=seedDraft(f,'2030-04-05');f.owner('同一项长期约定，颜色改为青色。');const r=await f.tool.execute({type:'user',scope:'global',summary:'所有项目仅初稿默认标记改为青色',meaning:{kind:'preference'},supersedes:old.indexLine},f.call());
 assert.equal(r.status,'recorded');assert.match(r.indexLine,/exp:2030-04-05/);const next=f.records().find(r=>r.status==='recorded');assert.equal(next.expires,old.expires);
 const v=JSON.parse(f.requests[0].messages[0].content[0].text).candidates[0].value;assert.equal(v.expires,old.expires);assert.equal(v.inheritedMetadata.expires,old.expires);
}))
for(const state of ['unsupported','uncertain'])test('native '+state+' value revision never replaces or stages without its target',()=>box({state},async f=>{
 const old=seedDraft(f);f.owner('同一项长期约定，颜色改为青色。');const r=await f.tool.execute({type:'user',scope:'global',summary:'所有项目仅初稿默认标记改为青色',meaning:{kind:'preference'},supersedes:old.indexLine},f.call());
 assert.equal(r.status,state==='unsupported'?'rejected':'not-applied');assert.equal(f.records().length,1);assert.ok(searchStore(f.root,'橄榄色').hits.length);
}))
test('native value mode cannot silently change a condition or be used without a target',()=>box(async f=>{
 const old=seedDraft(f);f.owner('请把正式稿的颜色改为青色。');
 await assert.rejects(()=>f.tool.execute({type:'user',scope:'global',summary:'正式稿改为青色',meaning:{kind:'preference',conditions:[{dimension:'document_kind',value:'final'}]},supersedes:old.indexLine},f.call()),/meaning-change-needs-complete-replacement/);
 await assert.rejects(()=>f.tool.execute({...proposal,revisionMode:'replace'},f.call()),/mode-needs-target/);assert.equal(f.requests.length,0);
}))
test('withdrawing inherited condition source during native validation blocks publication',()=>box({duringStream(f){revoke(f,f.parent)}},async f=>{
 f.parent=seedDraft(f);f.owner('同一项长期约定，颜色改为青色。');
 await assert.rejects(()=>f.tool.execute({type:'user',scope:'global',summary:'所有项目仅初稿默认标记改为青色',meaning:{kind:'preference'},supersedes:f.parent.indexLine},f.call()));assert.equal(f.records().some(r=>r.status==='recorded'),false);
}))
test('extra accepted current sources cannot displace an inherited source to fit the root bound',()=>box({evidence:input=>input.ownerMessages.map(m=>({messageId:m.id,quote:m.text}))},async f=>{
 const old=seedDraft(f);f.owner('这是一条用于校对的额外真实用户说明甲。');f.owner('这是一条用于校对的额外真实用户说明乙。');f.owner('同一项长期约定，颜色改为青色。');
 await assert.rejects(()=>f.tool.execute({type:'user',scope:'global',summary:'所有项目仅初稿默认标记改为青色',meaning:{kind:'preference'},supersedes:old.indexLine},f.call()),/source-overflow/);assert.equal(f.records().filter(r=>r.status==='recorded').length,1);assert.ok(searchStore(f.root,'橄榄色').hits.length);
}))

test('native self-excluding candidate is refused before any model stream or ledger write',()=>box(async f=>{
 f.owner();await assert.rejects(()=>f.tool.execute({...proposal,meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'}],except:[{dimension:'task',value:'review'}]}},f.call()),/contradictory-conditions/);assert.equal(f.requests.length,0);assert.equal(f.records().length,0)
}))

test('native validation cannot silently omit a clipped earlier owner exception',()=>box(async f=>{
 f.owner('甲'.repeat(2000)+'但这条约定只适用于初稿，不要忽略末尾例外。');f.owner();await assert.rejects(()=>f.tool.execute(proposal,f.call()),/source-incomplete/);assert.equal(f.requests.length,0);assert.equal(f.records().length,0)
}))
