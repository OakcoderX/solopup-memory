import {test} from 'node:test'
import assert from 'node:assert/strict'
import {prepareValidationPrompt,ValidationSubmission,validateCandidatesWithLlm,validationCandidateId} from './capture-validation.mjs'
import {VALIDATION_FIELDS,VALIDATION_NAME} from './capture-validation-contract.mjs'
const message={id:'owner-1',role:'user',text:'我在所有项目处理反馈时都先看最重要的两处问题，然后再看怎么改。'}
const candidate={type:'user',scope:'global',basis:'explicit',summary:'处理反馈先看两处问题再给修改办法，跨项目通用',meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'}]},evidence:[{messageId:message.id,quote:message.text}]}
const prepared=()=>prepareValidationPrompt([message],[candidate])
const check=(status='supported')=>({candidateId:validationCandidateId(candidate),fields:Object.fromEntries(VALIDATION_FIELDS.map(f=>[f,status])),evidence:status==='uncertain'?[]:[{messageId:message.id,quote:message.text}]})
const parse=p=>new ValidationSubmission(prepared()).batch(JSON.stringify(p),3)
test('source validator can only approve, reject or abstain on the exact whole candidate',()=>{
 assert.equal(parse({checks:[check()]}).verdicts[0].status,'approved')
 assert.equal(parse({checks:[check('unsupported')]}).verdicts[0].status,'rejected')
 assert.equal(parse({checks:[check('uncertain')]}).verdicts[0].status,'uncertain')
 for(const p of [{checks:[check()],entries:[candidate]},{checks:[{...check(),replacement:candidate}]}])assert.throws(()=>parse(p),/invalid-envelope/)
 const c={...candidate,detail:'An added requirement changes the validation identity.'};assert.notEqual(validationCandidateId(c),validationCandidateId(candidate))
 assert.equal(validationCandidateId({...candidate,meaning:{conditions:candidate.meaning.conditions,kind:'preference'}}),validationCandidateId(candidate))
})
test('missing, repeated and forged identities cannot approve unchecked candidates',()=>{
 for(const checks of [[],[check(),check()],[{...check(),candidateId:'b'.repeat(64)}]])assert.throws(()=>parse({checks}),/invalid-envelope/)
})
test('support must cite all current owner sources; assistant, old, invented and altered quotes fail',()=>{
 for(const e of [{messageId:'old',quote:message.text},{messageId:message.id,quote:'不曾出现的另一段合成用户原话'},{messageId:message.id,quote:'短'}])assert.throws(()=>parse({checks:[{...check(),evidence:[e]}]}),/invalid-envelope/)
 assert.throws(()=>parse({checks:[{...check(),evidence:[]}]}),/invalid-envelope/)
 const other={id:'owner-2',role:'user',text:'这段独立的当前消息提供另一条合成来源用于测试引用覆盖。'},c={...candidate,evidence:[...candidate.evidence,{messageId:other.id,quote:other.text}]},p=prepareValidationPrompt([message,other],[c])
 assert.throws(()=>new ValidationSubmission(p).batch(JSON.stringify({checks:[{...check(),candidateId:validationCandidateId(c)}]})),/invalid-envelope/)
})
test('bounded input never splits candidate fields or includes assistant testimony as owner evidence',()=>{
 const large={...candidate,detail:'長'.repeat(4000)}
 for(const limit of [1024,2048,24576,65536]){
  const p=prepareValidationPrompt([message,{id:'assistant',role:'assistant',text:'Invented assistant requirement'}],[candidate,large],limit),data=JSON.parse(p.text)
  assert.ok(Buffer.byteLength(p.text)<=limit);assert.equal(data.candidates.length,p.records.length);assert.ok(!p.text.includes('Invented assistant requirement'));assert.ok(p.records.every(r=>r.candidateId===validationCandidateId(r.value)))
 }
})
test('a separate native data tool settles once and cannot return rewritten fields',async()=>{
 let calls=0
 const llm={async prepareCall(config){return{config,async*stream(req){calls++;assert.equal(req.purpose,'memory-validation');assert.equal(req.tools[0].name,VALIDATION_NAME);const args=JSON.stringify({checks:[check()]});yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'block-end',index:0,block:{type:'tool-call',id:'synthetic',name:VALIDATION_NAME,arguments:args}};yield{type:'finish',reason:{kind:'tool-calls'}}}}}}
 const out=await validateCandidatesWithLlm({llm,messages:[message],candidates:[candidate],sessionId:'fixture',timeoutMs:1000});assert.equal(calls,1);assert.equal(out.verdicts[0].status,'approved')
})
test('no whole candidate fits means no model call, not implicit approval',async()=>{
 let calls=0;const out=await validateCandidatesWithLlm({llm:{prepareCall(){calls++}},messages:[message],candidates:[{...candidate,detail:'長'.repeat(4000)}],maxInputBytes:1024})
 assert.equal(calls,0);assert.equal(out.shown,0);assert.equal(out.omitted,1);assert.deepEqual(out.verdicts,[])
})
test('a delayed asynchronous pre-dispatch guard cannot issue a model stream after timeout',async()=>{
 let streams=0
 const llm={async prepareCall(config){return{config,async*stream(){streams++;yield{type:'text-delta',text:'{"checks":[]}'};yield{type:'finish',reason:{kind:'stop'}}}}}}
 await assert.rejects(validateCandidatesWithLlm({llm,messages:[message],candidates:[candidate],timeoutMs:15,beforeStream:async()=>{await new Promise(r=>setTimeout(r,60))}}),/capture-timeout/)
 await new Promise(r=>setTimeout(r,80));assert.equal(streams,0)
})
const prior=(patch={})=>({id:'a'.repeat(64),status:'recorded',scope:'global',type:'user',summary:'所有项目仅初稿默认标记橄榄色',indexLine:'- [user] 所有项目仅初稿默认标记橄榄色 — 索引摘要',meaning:{kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}]},expires:'2030-04-05',...patch})
test('transition context is separate from candidate identity and never displaces owner testimony',()=>{
 const rows=[prior(),prior({id:'b'.repeat(64),scope:'project',summary:'PRIVATE_PROJECT_SENTINEL'})]
 for(const bytes of [1024,2048,4096,24576]){
  const before=prepareValidationPrompt([message],[candidate],bytes),after=prepareValidationPrompt([message],[candidate],bytes,8,rows),data=JSON.parse(after.text)
  assert.deepEqual(after.messages,before.messages);assert.deepEqual(after.records,before.records);assert.ok(Buffer.byteLength(after.text)<=bytes)
  assert.equal(data.currentMemorySummary.provided,true);assert.doesNotMatch(after.text,/PRIVATE_PROJECT_SENTINEL/)
  assert.ok(data.currentMemory.length+data.currentMemorySummary.omittedContexts===after.records.length)
 }
 const data=JSON.parse(prepareValidationPrompt([message],[candidate],24576,8,rows).text)
 assert.equal(data.currentMemory[0].records[0].expires,'2030-04-05');assert.equal(data.currentMemory[0].records[0].recordId,rows[0].id)
})
test('unknown context, explicitly empty context and omitted context have different representations',()=>{
 const unknown=JSON.parse(prepared().text),empty=JSON.parse(prepareValidationPrompt([message],[candidate],24576,8,[]).text)
 assert.equal(unknown.currentMemorySummary.provided,false);assert.equal(unknown.currentMemory.length,0)
 assert.equal(empty.currentMemorySummary.provided,true);assert.equal(empty.currentMemory[0].omittedRecords,0);assert.equal(empty.currentMemory[0].records.length,0)
 assert.throws(()=>prepareValidationPrompt([message],[candidate],24576,8,{}),/context-invalid/)
})
test('shown old interpretation is not admissible as new owner evidence or a rewritten candidate',()=>{
 const row=prior(),p=prepareValidationPrompt([message],[candidate],24576,8,[row]),c=check()
 assert.throws(()=>new ValidationSubmission(p).batch(JSON.stringify({checks:[{...c,evidence:[{messageId:row.id,quote:row.summary}]}]})),/invalid-envelope/)
 assert.throws(()=>new ValidationSubmission(p).batch(JSON.stringify({checks:[{...c,currentMemory:[]}]})),/invalid-envelope/)
})
test('rejected dimensions are fixed field names and cannot carry rewritten instructions',()=>{
 const c=check();c.fields.transition='unsupported';c.fields.wording='uncertain'
 const v=parse({checks:[c]}).verdicts[0];assert.equal(v.status,'rejected');assert.deepEqual(v.unsupportedFields,['transition']);assert.deepEqual(v.uncertainFields,['wording'])
 assert.equal(parse({checks:[check()]}).verdicts[0].unsupportedFields,undefined)
 assert.throws(()=>parse({checks:[{...c,fields:{...c.fields,transition:'改写为另一条'}}]}),/invalid-envelope/)
})
test('a supported model vote cannot approve an explicitly unshown revision target',()=>{
 const c={...candidate,supersedes:prior().indexLine},p=prepareValidationPrompt([message],[c],24576,8,[])
 const v=new ValidationSubmission(p).batch(JSON.stringify({checks:[{...check(),candidateId:validationCandidateId(c)}]})).verdicts[0]
 assert.equal(v.status,'uncertain');assert.deepEqual(v.uncertainFields,['transition'])
 const shown=prepareValidationPrompt([message],[c],24576,8,[prior()])
 assert.equal(new ValidationSubmission(shown).batch(JSON.stringify({checks:[{...check(),candidateId:validationCandidateId(c)}]})).verdicts[0].status,'approved')
})
