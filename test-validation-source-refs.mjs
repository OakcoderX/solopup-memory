import test from 'node:test'
import assert from 'node:assert/strict'
import {prepareValidationPrompt,ValidationSubmission,validateCandidatesWithLlm} from './capture-validation.mjs'
import {VALIDATION_FIELDS} from './capture-validation-contract.mjs'
const messages=['跨所有项目的初稿反馈先列两处问题再给办法。','这一长期约定在正式稿上不适用。','请保留这项约定，以供之后的项目使用。'].map((text,i)=>({id:'synthetic-'+i,role:'user',text,hash:String(i).repeat(64)}))
const candidate={type:'user',scope:'global',basis:'explicit',summary:'跨项目的初稿反馈先列两处问题再给办法',meaning:{kind:'preference',conditions:[{dimension:'task',value:'review'},{dimension:'document_kind',value:'draft'}]},evidence:messages.slice(0,2).map(({id,text})=>({messageId:id,quote:text}))}
function setup(){const prepared=prepareValidationPrompt(messages,[candidate]),r=prepared.records[0],check={candidateId:r.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(k=>[k,'supported'])),taskRestriction:'none',sourceRefs:Object.keys(r.requiredSourceRefs),evidence:[]};return{prepared,check}}
const submit=f=>new ValidationSubmission(f.prepared).batch(JSON.stringify({checks:[f.check]})).verdicts[0]
test('short refs are code-bound to unchanged owner IDs and exact original quotes',()=>{const f=setup();assert.deepEqual(f.prepared.records[0].requiredSourceRefs,{r1e1:messages[0].id,r1e2:messages[1].id});const r=submit(f);assert.equal(r.status,'approved');assert.deepEqual(r.evidence,candidate.evidence)})
test('omitting one required source still refuses all-supported output',()=>{const f=setup();f.check.sourceRefs.pop();assert.throws(()=>submit(f),/invalid-envelope/)})
test('unknown, repeated or cross-candidate refs cannot acquire owner authority',()=>{for(const refs of [['r9e1'],['r1e1','r1e1'],['synthetic-0']]){const f=setup();f.check.sourceRefs=refs;assert.throws(()=>submit(f),/invalid-envelope/)}})
test('additional valid owner citations are retained alongside required original quotes',()=>{const f=setup();f.check.evidence=[{messageId:messages[2].id,quote:messages[2].text}];const r=submit(f);assert.equal(r.status,'approved');assert.equal(r.evidence.length,3);assert.deepEqual(r.evidence.slice(0,2),candidate.evidence)})
test('only an identical repeated bound quote is normalized; a conflicting duplicate is refused',()=>{const f=setup();f.check.evidence=[candidate.evidence[0]];assert.deepEqual(submit(f).evidence,candidate.evidence);const g=setup();g.check.evidence=[{...candidate.evidence[0],quote:'一段不相同且不存在的引文'}];assert.throws(()=>submit(g),/invalid-envelope/)})
test('a ref cannot launder a forged or unshown original quotation',()=>{for(const mutate of [c=>c.evidence[0].quote='未出现的原话也不能借短标签通过。',c=>c.evidence[0].messageId='unshown']){const value=structuredClone(candidate);mutate(value);const f=setup();f.prepared=prepareValidationPrompt(messages,[value]);f.check.candidateId=f.prepared.records[0].candidateId;assert.throws(()=>submit(f),/invalid-envelope/)}})
test('legacy array coverage and quote checks are retained',()=>{const f=setup();delete f.check.sourceRefs;delete f.check.taskRestriction;f.check.evidence=[candidate.evidence[0]];assert.throws(()=>submit(f),/invalid-envelope/);f.check.evidence=candidate.evidence;assert.equal(submit(f).status,'approved')})
test('public SDK stream sees aliases in the user envelope and returns source-complete verdicts',async()=>{
 const llm={async prepareCall(config){return{config,async*stream(req){const input=JSON.parse(req.messages[0].content[0].text);const r=input.candidates[0];assert.ok(req.tools[0].parameters.properties.checks.items.required.includes('sourceRefs'));yield{type:'text-delta',text:JSON.stringify({checks:[{candidateId:r.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(k=>[k,'supported'])),taskRestriction:'none',sourceRefs:Object.keys(r.requiredSourceRefs),evidence:[]}]})};yield{type:'finish',reason:{kind:'stop'}}}}}}
 const v=await validateCandidatesWithLlm({llm,route:{provider:'fixture',model:'fixture'},sessionId:'synthetic-ref',messages,candidates:[candidate]});assert.deepEqual(v.verdicts[0].evidence,candidate.evidence)
})

test('independent task audit blocks a stage-only preference even after seven supported votes',()=>{
 const value={...candidate,meaning:{kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}]}},f=setup();f.prepared=prepareValidationPrompt(messages,[value]);f.check.candidateId=f.prepared.records[0].candidateId;f.check.taskRestriction='review';const r=submit(f);assert.equal(r.status,'rejected');assert.deepEqual(r.unsupportedFields,['applicability'])
})
test('a task-scoped supported preference remains useful and task uncertainty never approves',()=>{
 const f=setup();f.check.taskRestriction='review';assert.equal(submit(f).status,'approved');const u=setup();u.check.taskRestriction='uncertain';assert.equal(submit(u).status,'uncertain')
})
test('a short-ref response cannot omit its independently requested task audit',()=>{const f=setup();delete f.check.taskRestriction;assert.throws(()=>submit(f),/invalid-envelope/)})
