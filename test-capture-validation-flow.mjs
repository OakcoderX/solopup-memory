import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply,indexLine} from './index.mjs'
import {writeFixtureMemory,prepareMountedFixture} from './fixture-host.mjs'
import {candidateSnapshot,listCandidates} from './candidates.mjs'
import {listCaptureJobs} from './capture-jobs.mjs'
import {VALIDATION_FIELDS} from './capture-validation-contract.mjs'
for(const mode of ['approved','rejected','uncertain','validation-error','correction-rejected','transition-rejected','stale'])test('actual automatic acquisition → durable validation → source-bound admission: '+mode,async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-validated-flow-'))),home=join(base,'home'),cwd=join(base,'project'),root=join(home,'memory'),previous=process.env.DSH_HOME
 mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 try{
  let old
  if(['correction-rejected','transition-rejected'].includes(mode))old=writeFixtureMemory({dir:root,type:'user',scope:'global',summary:'处理评审反馈原约定先看一处问题再给办法',meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'}]}})
  prepareMountedFixture()
  const handlers=[],session={id:'source-validation-'+mode};let acquisitions=0,validations=0,proposed
  const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},async prepareCall(config){return{config,async*stream(req){
   if(req.purpose==='memory-validation'){
    validations++;const input=JSON.parse(req.messages[0].content[0].text)
    assert.equal(input.currentMemorySummary.provided,true);assert.equal(input.currentMemory[0].scope,'global');assert.equal(input.currentMemory[0].records.length,old?1:0)
    if(old){assert.equal(input.currentMemory[0].records[0].summary,'处理评审反馈原约定先看一处问题再给办法');assert.equal(input.currentMemory[0].records[0].evidence,undefined)}
    if(mode==='stale')writeFixtureMemory({dir:root,type:'user',scope:'global',summary:'独立来源约定长期答复保持简洁',meaning:{kind:'preference'}})
    const state=['rejected','correction-rejected'].includes(mode)?'unsupported':mode==='uncertain'?'uncertain':'supported'
    const checks=mode==='validation-error'?[]:input.candidates.map(r=>({candidateId:r.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(f=>[f,mode==='transition-rejected'&&f==='transition'?'unsupported':state])),evidence:state==='uncertain'?[]:r.value.evidence.map(({messageId,quote})=>({messageId,quote}))}))
    yield{type:'text-delta',text:JSON.stringify({checks})};yield{type:'finish',reason:{kind:'stop'}};return
   }
   acquisitions++;const source=req.messages[0].content[0].text.split('\n').flatMap(line=>{try{const r=JSON.parse(line);return r.role==='user'?[r]:[]}catch{return[]}}).at(-1)
   proposed={type:'user',scope:'global',basis:'explicit',summary:'处理评审反馈先看两处问题再给办法，跨项目通用',meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'}]},evidence:[{messageId:source.id,quote:source.text}],...old&&mode!=='transition-rejected'?{supersedes:'[global] '+old.indexLine}:{}}
   yield{type:'text-delta',text:JSON.stringify([proposed])};yield{type:'finish',reason:{kind:'stop'}}
  }}}}
  apply({llm,systemPrompt:{context(){}},workingDirectory:{get(){return cwd}},tools:{register(){}},on(name,fn){handlers.push([name,fn])}},{autoCapture:{everyTurns:1}})
  const emit=event=>{for(const[name,fn]of handlers)if(name==='session/event')fn(session,event)}
  emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text:'我处理评审反馈时始终先看最重要的两处问题，再看怎么改，这个顺序跨所有项目通用。'}]}}});emit({type:'step/end',data:{}})
  let state;const until=Date.now()+5000
  while(Date.now()<until){try{state=JSON.parse(readFileSync(join(root,'.capture-state.json')))}catch{}if(state?.lastCaptureAt&&!state.running)break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(state?.running,false);assert.equal(acquisitions,1);assert.equal(validations,1);assert.equal(listCaptureJobs(root).jobs.length,2)
  const active=candidateSnapshot(root,'global').records.filter(r=>r.status==='recorded'),pending=listCandidates(root,{scope:'global',status:'pending'}).total
  if(mode==='approved'){assert.equal(active.length,1);assert.equal(pending,0);assert.deepEqual(active[0].meaning.conditions,proposed.meaning.conditions);assert.equal(state.diagnostic.classification,'recorded')}
  else if(mode==='rejected'){assert.equal(active.length,0);assert.equal(pending,0);assert.equal(state.diagnostic.classification,'admission-rejected')}
  else if(['correction-rejected','transition-rejected'].includes(mode)){assert.equal(active.length,1);assert.equal(active[0].summary,'处理评审反馈原约定先看一处问题再给办法');assert.equal(pending,0);assert.equal(state.diagnostic.classification,'admission-rejected')}
  else if(mode==='stale'){assert.equal(active.length,1);assert.equal(pending,0);assert.equal(state.lastOutcome,'error');assert.equal(state.lastError,'capture-input-source-changed')}
  else{assert.equal(active.length,0);assert.equal(pending,1);assert.equal(state.diagnostic.classification,'pending-review');assert.ok(!existsSync(join(root,'MEMORY.md'))||!readFileSync(join(root,'MEMORY.md'),'utf8').includes(proposed.summary))}
  if(mode==='validation-error')assert.ok(listCaptureJobs(root).jobs.some(j=>j.status==='failed'))
 }finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
})
