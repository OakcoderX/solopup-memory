import {test} from 'node:test'
import assert from 'node:assert/strict'
import {CaptureSubmission,CAPTURE_SUBMISSION_NAME,CAPTURE_SUBMISSION_TOOL} from './capture-submission.mjs'
import {extractWithLlm,CAPTURE_REQUEST_CONTRACT} from './capture-llm.mjs'
import {TEXT_MEMORY_POLICY} from './memory-policy.mjs'
const candidate={type:'user',summary:'长期固定搭档负责声音，本人负责剪辑',scope:'global',basis:'explicit',meaning:{kind:'claim'},evidence:[{messageId:'synthetic-user',quote:'我的固定搭档负责声音，我本人负责剪辑'}]}
function chunks(entries=[candidate],options={}){
 const raw=options.raw??JSON.stringify({entries}),name=options.name??CAPTURE_SUBMISSION_NAME,id='synthetic-submit'
 return[{type:'block-start',index:0,blockType:'tool-call'},...options.noDeltas?[]:[{type:'tool-call-delta',index:0,id,...options.omitDeltaName?{}:{name},argumentsDelta:raw.slice(0,8)},{type:'tool-call-delta',index:0,id,argumentsDelta:raw.slice(8)}],{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:raw}},{type:'finish',reason:{kind:'tool-calls'}}]
}
function batch(events,text='',limit=3){const s=new CaptureSubmission();for(const event of events)s.observe(event,event.type==='text-delta'?event.text:'');return s.batch(text,limit)}
test('one complete native submission yields candidates with unchanged source and meaning metadata',()=>{
 const result=batch(chunks());assert.equal(result.responseItems,1);assert.equal(result.parsedItems,1);assert.deepEqual(result.candidates[0].meaning,candidate.meaning);assert.deepEqual(result.candidates[0].evidence,candidate.evidence);assert.equal(result.wrapped,false)
})
test('empty native submission is a model no-op, not an empty-response error',()=>assert.equal(batch(chunks([])).responseItems,0))
test('canonical final block can supply its complete name and arguments without deltas',()=>{
 for(const options of [{noDeltas:true},{omitDeltaName:true}])assert.equal(batch(chunks([candidate],options)).parsedItems,1)
})
for(const [name,events,text] of [
 ['unknown tool',chunks([candidate],{name:'write_files'}),''],
 ['extra envelope fields',chunks([candidate],{raw:'{"entries":[],"verified":true}'}),''],
 ['array in place of envelope',chunks([candidate],{raw:'[]'}),''],
 ['malformed arguments',chunks([candidate],{raw:'{"entries":['}),''],
 ['unfinished call',chunks().slice(0,3),''],
 ['multiple calls',[...chunks().slice(0,-1),...chunks()],''],
 ['mismatched final arguments',chunks().map(c=>c.type==='block-end'?{...c,block:{...c.block,arguments:'{"entries":[]}'}}:c),''],
 ['text plus call',chunks(),'说明文字'],
 ['final-only nonempty text block',[...chunks().slice(0,-1),{type:'block-end',index:2,block:{type:'text',text:'额外解释'}},chunks().at(-1)],''],
 ['non-tool finish',chunks().map(c=>c.type==='finish'?{type:'finish',reason:{kind:'stop'}}:c),''],
 ['duplicate terminal finish',[...chunks(),chunks().at(-1)],''],
])test('reject '+name,()=>assert.throws(()=>batch(events,text),/capture-invalid-(envelope|json)/))
test('bounded arguments reject oversized deltas and whole final blocks before retaining them',()=>{
 for(const options of [{},{noDeltas:true}])assert.throws(()=>batch(chunks([],{...options,raw:'x'.repeat(65537)})),/capture-response-too-large/)
})
test('native submission keeps truncation and item rejection visible',()=>{
 const result=batch(chunks([candidate,{type:'bad',summary:'invalid'},candidate]),'',1);assert.equal(result.parsedItems,1);assert.equal(result.parserRejected,1);assert.equal(result.deferred,1)
})
test('text-only fallback remains strict: trailing explanation is not repaired or mined',()=>{
 assert.equal(batch([],JSON.stringify([candidate])).parsedItems,1)
 assert.throws(()=>batch([],JSON.stringify([candidate])+'\n说明'),/capture-invalid-json/)
})
test('request declares one data-only tool, retains selected controls, and accepts canonical tool output',async()=>{
 let calls=0
 const llm={async prepareCall(config){return{config:{...config},async *stream(request){calls++;assert.equal(request.tools.length,1);assert.deepEqual(request.tools[0],CAPTURE_SUBMISSION_TOOL);assert.equal(request.toolChoice,undefined);assert.equal(request.responseFormat,undefined);assert.ok(request.system.includes(TEXT_MEMORY_POLICY));assert.match(CAPTURE_REQUEST_CONTRACT,/^[a-f0-9]{64}$/);yield*chunks()}}}}
 const result=await extractWithLlm({llm,route:{provider:'fixture',model:'fixture'},messages:[],indexLines:[]});assert.equal(calls,1);assert.equal(result.length,1)
 assert.ok(Object.isFrozen(CAPTURE_SUBMISSION_TOOL.parameters.properties.entries))
})
test('provider errors and truncated tool calls never publish apparently valid arguments',async()=>{
 for(const kind of ['error','aborted','max-tokens']){
  const llm={async prepareCall(config){return{config,async *stream(){yield*chunks().slice(0,-1);yield{type:'finish',reason:{kind}}}}}}
  await assert.rejects(extractWithLlm({llm,messages:[],indexLines:[]}),/capture-(provider-error|max-tokens)/)
 }
})

test('strictly identical dual-channel arrays represent one submission, including nonempty candidates and key reordering',()=>{
 for(const entries of [[],[candidate]])assert.equal(batch(chunks(entries),JSON.stringify(entries)).responseItems,entries.length)
 const reordered={...candidate,meaning:{kind:'claim'}};delete reordered.type;reordered.type=candidate.type
 assert.equal(batch(chunks([candidate]),JSON.stringify([reordered])).responseItems,1)
})
test('dual-channel contradiction, prose, fences and object wrappers stay rejected',()=>{
 for(const text of ['[{}]','[] explanation','```json\n[]\n```','{"entries":[]}'])assert.throws(()=>batch(chunks([]),text),/capture-invalid-envelope/)
 assert.throws(()=>batch(chunks([candidate]),'[]'),/capture-invalid-envelope/)
})
test('final-only text copies are also bounded and must exactly agree',()=>{
 const events=[...chunks([]).slice(0,-1),{type:'block-end',index:2,block:{type:'text',text:'[]'}},chunks().at(-1)]
 assert.equal(batch(events).responseItems,0)
 assert.throws(()=>batch([...chunks([]).slice(0,-1),{type:'block-end',index:2,block:{type:'text',text:'x'.repeat(65536)}},chunks().at(-1)]),/capture-response-too-large/)
})
