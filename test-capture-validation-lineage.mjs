import {VALIDATION_FIELDS} from './capture-validation-contract.mjs'
/** Scripted pipeline regression; optional source override reproduces the frozen dev28 bug. */
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
const baseUrl=process.env.DSH_VALIDATION_LINEAGE_SOURCE?pathToFileURL(resolve(process.env.DSH_VALIDATION_LINEAGE_SOURCE)+'/'):new URL('./',import.meta.url)
const {apply,withdrawManagedSource,searchStore}=await import(new URL('index.mjs',baseUrl))
const {candidateSnapshot}=await import(new URL('candidates.mjs',baseUrl))
const {writeFixtureMemory}=await import(new URL('fixture-host.mjs',baseUrl))
test('every extra owner source used to approve a candidate remains a withdrawal root of the published memory',async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-validator-roots-'))),home=join(base,'home'),cwd=join(base,'project'),root=join(home,'memory'),oldHome=process.env.DSH_HOME
 mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 try{
  const handlers=[],session={id:'synthetic-validation-extra-root'};let extraSourceId
  const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},async prepareCall(config){return{config,async*stream(req){
   if(req.purpose==='memory-validation'){
    const data=JSON.parse(req.messages[0].content[0].text),users=data.ownerMessages;assert.equal(users.length,2);extraSourceId=users[1].id
    yield{type:'text-delta',text:JSON.stringify({checks:data.candidates.map(c=>({candidateId:c.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(k=>[k,'supported'])),evidence:users.map(m=>({messageId:m.id,quote:m.text}))}))})};yield{type:'finish',reason:{kind:'stop'}};return
   }
   const users=req.messages[0].content[0].text.split('\n').flatMap(line=>{try{const x=JSON.parse(line);return x.role==='user'?[x]:[]}catch{return[]}})
   yield{type:'text-delta',text:JSON.stringify([{type:'user',scope:'global',basis:'explicit',summary:'sourceMergeSentinel：跨项目反馈先两处问题再给办法',meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'}]},evidence:[{messageId:users[0].id,quote:users[0].text}]}])};yield{type:'finish',reason:{kind:'stop'}}
  }}}}
  apply({llm,systemPrompt:{context(){}},workingDirectory:{get(){return cwd}},tools:{register(){}},on(name,fn){handlers.push([name,fn])}},{autoCapture:{everyTurns:2}})
  const emit=e=>{for(const[name,fn]of handlers)if(name==='session/event')fn(session,e)}
  for(const text of ['我在这个项目处理反馈时先看最重要的两处问题，再看怎么改。','补充归属：这个反馈顺序跨我的所有项目都一样，是长期约定。'])emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text}]}}})
  emit({type:'step/end',data:{}})
  let state;const until=Date.now()+5000;while(Date.now()<until){try{state=JSON.parse(readFileSync(join(root,'.capture-state.json')))}catch{}if(state?.lastCaptureAt&&!state.running)break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(state?.lastOutcome,'ok');assert.equal(state?.diagnostic.classification,'recorded')
  const published=candidateSnapshot(root,'global').records.find(r=>r.status==='recorded'&&r.summary.includes('sourceMergeSentinel'))
  assert.equal(published.evidence.length,2,'Approval must not discard the additional source authorizing global scope')
  assert.ok(published.evidence.some(e=>e.messageId===extraSourceId))
  writeFixtureMemory({dir:root,type:'user',scope:'global',summary:'independentRootSentinel：另一个独立来源要求长期答复简洁',meaning:{kind:'preference'}})
  const preview=withdrawManagedSource(root,session.id,extraSourceId);withdrawManagedSource(root,session.id,extraSourceId,{apply:true,controlReview:preview.controlReview})
  assert.equal(searchStore(root,'sourceMergeSentinel',{mode:'exact'}).hits.length,0)
  assert.ok(searchStore(root,'independentRootSentinel',{mode:'exact'}).hits.length>0)
 }finally{if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;rmSync(base,{recursive:true,force:true})}
})
