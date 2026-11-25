import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply,indexLine,storeDirFor} from '../index.mjs'
import {writeFixtureMemory,prepareMountedFixture} from '../fixture-host.mjs'
import {candidateSnapshot,listCandidates} from '../candidates.mjs'
import {listCaptureJobs} from '../capture-jobs.mjs'
import {VALIDATION_FIELDS} from '../capture-validation-contract.mjs'
import {selectEffectiveMemory} from '../effective-memory.mjs'
import {applicability} from '../meaning.mjs'
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

test('Zhou briefing captures the pre-signoff boundary and a trial report without installing a bell rule',async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-validated-zhou-'))),home=join(base,'home'),cwd=join(base,'project'),root=join(home,'memory'),previous=process.env.DSH_HOME
 mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 try{
  prepareMountedFixture()
  const boundary='我明天再去棚里试一下，在制片签字之前，请先给我留个试听文件，暂时别替换交付母版。'
  const trial='展映版先试留船尾最后一声铃。'
  const body='《夜渡》后期通话纪要，2024年10月17日。\n周原：我们上次在混录棚放的是小厅的素材，现场比剪辑机听到的要空得多。小杨开门那声进得很快，接下来是拖行李的轮子，接着河水拍了一下船帮，三个声音在家里听会有些黏在一起。在电影院反而能分清，观众的注意力一直跟着离开甲板的那个人。'+boundary+trial
  const handlers=[],session={id:'zhou-owner-source'}
  let validations=0
  const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},async prepareCall(config){return{config,async*stream(req){
   const text=req.messages[0].content[0].text
   if(req.purpose==='memory-validation'){
    validations++
    const {candidates}=JSON.parse(text)
    assert.equal(candidates.length,2)
    const checks=candidates.map(record=>({candidateId:record.candidateId,
     fields:Object.fromEntries(VALIDATION_FIELDS.map(field=>[field,'supported'])),
     taskRestriction:'none',sourceRefs:Object.keys(record.requiredSourceRefs),evidence:[]}))
    yield{type:'text-delta',text:JSON.stringify({checks})}
   }else{
    const owner=text.split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}).find(row=>row.role==='user')
    const proposal=(summary,quote,meaning)=>({type:'project',scope:'project',basis:'explicit',summary,meaning,evidence:[{messageId:owner.id,quote}]})
    yield{type:'text-delta',text:JSON.stringify([
     proposal('《夜渡》制片签字前允许保留试听文件，暂不替换交付母版。',boundary,{kind:'claim',conditions:[{dimension:'signoff',value:'pending'}]}),
     proposal('《夜渡》展映版先试留船尾最后一声铃作为声音方案。',trial,{kind:'claim'}),
     proposal('《夜渡》展映版正式选定船尾最后一声铃。','留船尾最后一声铃',{kind:'decision'}),
    ])}
   }
   yield{type:'finish',reason:{kind:'stop'}}
  }}}}
  apply({llm,systemPrompt:{context(){}},workingDirectory:{get(){return cwd}},tools:{register(){}},on(name,fn){handlers.push([name,fn])}},{autoCapture:{everyTurns:1}})
  const emit=event=>{for(const[name,fn]of handlers)if(name==='session/event')fn(session,event)}
  emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text:body}]}}})
  emit({type:'step/end',data:{}})
  let state;const until=Date.now()+5000
  while(Date.now()<until){try{state=JSON.parse(readFileSync(join(root,'.capture-state.json')))}catch{}if(state?.lastCaptureAt&&!state.running)break;await new Promise(r=>setTimeout(r,20))}
  assert.equal(state?.running,false);assert.equal(validations,1)
  assert.equal(state.diagnostic.inserted,2);assert.equal(state.diagnostic.admissionRejected,1)
  const records=candidateSnapshot(storeDirFor('project',cwd),'project').records
  assert.equal(records.length,2)
  for(const record of records){
   assert.equal(record.status,'recorded');assert.equal(record.meaning.kind,'claim')
   assert.equal(record.sessionId,session.id);assert.equal(record.sources.length,1)
   assert.match(record.summary,/2024年10月17日.*周原/u)
  }
  const delivery=records.find(record=>record.summary.includes('母版'))
  assert.match(delivery.summary,/签字前.*试听.*暂不替换/u)
  assert.equal(delivery.evidence[0].quote,boundary)
  assert.equal(applicability(delivery.meaning).state,'unknown')
  assert.equal(applicability(delivery.meaning,{signoff:'pending'}).state,'applicable')
  assert.equal(applicability(delivery.meaning,{signoff:'signed'}).state,'not-applicable')
  const bell=records.find(record=>record.summary.includes('铃'))
  assert.match(bell.summary,/展映版先试留/u);assert.equal(bell.evidence[0].quote,trial)
  assert.deepEqual(selectEffectiveMemory({records,query:'《夜渡》展映版船尾铃声',includeProjectDefaults:true}),[])
 }finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
})
