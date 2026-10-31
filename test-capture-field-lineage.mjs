import {createHash} from 'node:crypto'
/** Actual automatic pipeline with scripted public LLM streams; not a real-model evaluation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {apply,searchStore,withdrawManagedSource} from './index.mjs'
import {candidateSnapshot} from './candidates.mjs'
import {VALIDATION_FIELDS} from './capture-validation-contract.mjs'
import {writeFixtureMemory} from './fixture-host.mjs'
const modes=['value','expiring-value','complete','changed-condition','inferred','wrong-target','unsupported','uncertain','withdraw-during','root-overflow','self-excluding'];
for(const mode of modes)test('automatic code-owned field lineage: '+mode,async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'auto-field-lineage-'))),home=join(base,'home'),cwd=join(base,'project'),root=join(home,'memory'),previous=process.env.DSH_HOME;
 mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home;
 const handlers=[],effects=[],requests=[];let parent,colour='青色',session;
 const records=()=>candidateSnapshot(root,'global').records;
 const revoke=record=>{const p=withdrawManagedSource(root,record.sessionId,record.evidence[0].messageId);withdrawManagedSource(root,record.sessionId,record.evidence[0].messageId,{apply:true,controlReview:p.controlReview})};
 const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},async prepareCall(config){return{config,async*stream(request){
  requests.push(request);const text=request.messages[0].content[0].text;
  if(request.purpose==='memory-validation'){
   const input=JSON.parse(text),candidate=input.candidates[0].value;
   if(mode==='complete'){assert.equal(candidate.inheritedMetadata,undefined);assert.deepEqual(candidate.meaning,{kind:'preference'})}
   else{assert.deepEqual(candidate.meaning.conditions,[{dimension:'document_kind',value:'draft'}]);assert.equal(candidate.inheritedMetadata.parentId,parent.id);assert.ok(input.ownerMessages.every(m=>m.id!==parent.evidence[0].messageId));assert.equal(candidate.fieldLineage,undefined)}
   if(mode==='withdraw-during')revoke(parent);
   const state=mode==='unsupported'?'unsupported':mode==='uncertain'?'uncertain':'supported';
   yield{type:'text-delta',text:JSON.stringify({checks:input.candidates.map(c=>({candidateId:c.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(f=>[f,state])),evidence:state==='uncertain'?[]:c.value.evidence.map(({messageId,quote})=>({messageId,quote}))}))})};yield{type:'finish',reason:{kind:'stop'}};return;
  }
  const sources=text.split('\n').flatMap(line=>{try{const x=JSON.parse(line);return x.role==='user'?[x]:[]}catch{return[]}}),source=sources.at(-1);
  const candidate={type:'user',scope:'global',basis:mode==='inferred'?'inferred':'explicit',summary:mode==='complete'?'所有项目所有阶段默认标记为'+colour:'所有项目仅初稿默认标记为'+colour,
   meaning:mode==='self-excluding'?{kind:'preference',conditions:[{dimension:'task',value:'review'}],except:[{dimension:'task',value:'review'}]}:mode==='changed-condition'?{kind:'preference',conditions:[{dimension:'document_kind',value:'final'}]}:{kind:'preference'},
   supersedes:mode==='wrong-target'?parent.summary:'[global] '+parent.indexLine,...mode==='complete'?{revisionMode:'replace'}:{},evidence:(mode==='root-overflow'?sources:[source]).map(m=>({messageId:m.id,quote:m.text}))};
  yield{type:'text-delta',text:JSON.stringify([candidate])};yield{type:'finish',reason:{kind:'stop'}};
 }}}};
 const emit=event=>{for(const[name,fn]of handlers)if(name==='session/event')fn(session,event)};
 async function turn(id,text){session={id};if(mode==='root-overflow')emit({type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'这是新会话对同一项约定的独立补充来源，不删除旧条件。'}]}});emit({type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}});emit({type:'step/end',data:{}});
  let state;const until=Date.now()+5000;while(Date.now()<until){try{state=JSON.parse(readFileSync(join(root,'.capture-state.json')))}catch{}if(state?.sessionId===id&&state.lastCaptureAt&&!state.running)break;
   await new Promise(r=>setTimeout(r,20))}
  assert.equal(state?.sessionId,id);assert.equal(state?.running,false);return state;
 }
 try{
  apply({llm,systemPrompt:{context(){}},workingDirectory:{get:()=>cwd},tools:{register(){}},on:(name,fn)=>handlers.push([name,fn]),effect:fn=>{const dispose=fn();if(typeof dispose==='function')effects.push(dispose)}},{autoCapture:{everyTurns:1}});
  const hash=x=>createHash('sha256').update(x).digest('hex'),twoRootProof={basis:'tool-context',sessionId:'synthetic-original-two-roots',callHash:hash('old-call'),evidence:['original condition source','original scope source'].map((quote,i)=>({messageId:'old-'+i,hash:hash(quote),quote:'Synthetic original '+quote}))};
  writeFixtureMemory({...mode==='root-overflow'?{provenance:twoRootProof}:{},dir:root,type:'user',scope:'global',summary:'所有项目仅初稿默认标记为橄榄色',meaning:{kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}]},...mode==='expiring-value'?{expires:'2030-04-05'}:{}});
  parent=records().find(r=>r.status==='recorded');const original=parent;
  const state=await turn('new-owner-'+mode,mode==='complete'?'重新完整约定：所有项目所有阶段均使用青色，不再限初稿。':'同一项长期标记约定，颜色现在改为青色。');
  const active=records().filter(r=>r.status==='recorded');assert.equal(records().filter(r=>r.status==='pending').length,0);
  if(['value','expiring-value','complete'].includes(mode)){
   assert.equal(state.lastOutcome,'ok');assert.equal(active.length,1);const next=active[0];assert.equal(next.sessionId,session.id);assert.equal(next.evidence.length,1);
   if(['value','expiring-value'].includes(mode)){
    assert.equal(next.expires,original.expires);assert.deepEqual(next.meaning.conditions,original.meaning.conditions);assert.equal(next.sources.length,2);assert.equal(next.fieldLineage.parentId,original.id);
    parent=next;colour='紫色';const second=await turn('third-owner-'+mode,'同一项长期标记约定，颜色再改为紫色。');assert.equal(second.lastOutcome,'ok');
    const latest=records().find(r=>r.status==='recorded');assert.equal(latest.sources.length,2);assert.ok(latest.sources.includes(original.sources[0]));assert.equal(latest.sources.some(root=>next.sources.includes(root)&&!original.sources.includes(root)),false);
    revoke(next);assert.ok(searchStore(root,'紫色',{context:{document_kind:'draft'}}).hits.length);assert.equal(searchStore(root,'紫色',{context:{document_kind:'final'}}).hits.length,0);revoke(original);assert.equal(searchStore(root,'紫色').hits.length,0);
   }else{assert.equal(next.fieldLineage,undefined);assert.equal(next.sources.length,1);revoke(original);assert.ok(searchStore(root,'青色',{context:{document_kind:'final'}}).hits.length)}
  }else{
   assert.equal(searchStore(root,'青色').hits.length,0);
   if(mode==='withdraw-during')assert.equal(active.length,0);else assert.deepEqual(active.map(r=>r.id),[original.id]);
   if(['changed-condition','inferred','wrong-target','root-overflow','self-excluding'].includes(mode))assert.equal(requests.filter(r=>r.purpose==='memory-validation').length,0);
  }
  if(['changed-condition','inferred','wrong-target','root-overflow','self-excluding'].includes(mode)){assert.equal(state.diagnostic.classification,'admission-rejected');assert.equal(state.diagnostic.admissionRejected,1);assert.equal(state.diagnostic.writeFailures,0);assert.equal(state.diagnostic.inserted,0);if(mode!=='self-excluding')assert.match(readFileSync(join(root,'.audit.jsonl'),'utf8'),/revisionReason/)}
 }finally{for(const dispose of effects.reverse())dispose();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
});
