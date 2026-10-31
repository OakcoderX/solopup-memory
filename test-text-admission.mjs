import {applyWithValidationFixture as apply} from './fixture-host.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {indexLine, searchStore} from './index.mjs'
import {prepareMountedFixture,writeFixtureMemory} from './fixture-host.mjs'
import {candidateSnapshot,listCandidates} from './candidates.mjs'
import {assessCandidate} from './capture-evidence.mjs'
import {normalizeCaptureDiagnostic} from './capture-diagnostics.mjs'

async function box(run){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'dsh-text-admission-'))),home=join(dir,'home'),cwd=join(dir,'project'),previous=process.env.DSH_HOME
 mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 try{return await run({home,cwd,root:join(home,'memory')})}
 finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(dir,{recursive:true,force:true})}
}
test('replacement colliding with another existing summary must not report duplicate while leaving the old target active',()=>box(async({root})=>{
 const meaning={kind:'preference'},good='跨项目评审先列最重要的两处问题再给办法',bad='跨项目评审先列问题并说明未约定的全部后果'
 writeFixtureMemory({dir:root,type:'user',scope:'global',summary:good,meaning})
 const old=writeFixtureMemory({dir:root,type:'user',scope:'global',summary:bad,meaning})
 const before=readFileSync(join(root,'MEMORY.md'),'utf8'),ledger=readFileSync(join(root,'.candidates.json'),'utf8')
 assert.throws(()=>writeFixtureMemory({dir:root,type:'user',scope:'global',summary:good,meaning,supersedes:old.indexLine}),e=>e.code==='memory-meaning-duplicate-needs-distinct-summary')
 assert.equal(readFileSync(join(root,'MEMORY.md'),'utf8'),before);assert.equal(readFileSync(join(root,'.candidates.json'),'utf8'),ledger)
}))
test('an explicitly different typed detail cannot silently return duplicate and discard the proposed correction',()=>box(async({root})=>{
 const meaning={kind:'preference'},summary='评审先列两处问题再给修改办法'
 const old=writeFixtureMemory({dir:root,type:'user',scope:'global',summary,meaning,detail:'Synthetic original detail with an extra requirement.'})
 const before=readFileSync(join(root,'user.md'),'utf8')
 assert.throws(()=>writeFixtureMemory({dir:root,type:'user',scope:'global',summary,meaning,detail:'Synthetic source-faithful corrected detail.',supersedes:old.indexLine}),e=>e.code==='memory-meaning-duplicate-needs-distinct-summary')
 assert.equal(readFileSync(join(root,'user.md'),'utf8'),before)
 const duplicate=writeFixtureMemory({dir:root,type:'user',scope:'global',summary,meaning,detail:'Synthetic original detail with an extra requirement.'})
 assert.equal(duplicate.duplicate,true)
}))
test('native write advertises mandatory meaning and rejects missing meaning before persistence',()=>box(async({home,cwd,root})=>{
 const tools=[],handlers=[]
 apply({systemPrompt:{context(){}},workingDirectory:{get(){return cwd}},tools:{register(tool){tools.push(tool)}},on(name,handler){handlers.push([name,handler])}},{autoCapture:{enabled:false}})
 const tool=tools.find(tool=>tool.name==='memory_write')
 assert.ok(tool.parameters.required.includes('meaning'))
 // A missing owner is still rejected by the source guard; a schema declaration is not permission to write.
 await assert.rejects(tool.execute({type:'user',scope:'global',summary:'没有归属来源的长期身份'}),/source-unavailable/)
 assert.equal(existsSync(join(root,'MEMORY.md')),false)
}))
for(const mode of ['changed-conditions','same-conditions','invalid-relations'])test('automatic duplicate interpretation: '+mode,()=>box(async({cwd,root})=>{
 const summary='跨所有项目的初稿统一使用默认标记 olive-synthetic24'
 const meaning={kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}]}
 writeFixtureMemory({dir:root,type:'user',scope:'global',summary,line:indexLine('user',summary),detail:'Synthetic source fixes this choice to drafts, not finished documents.',meaning})
 prepareMountedFixture()
 const beforeIndex=readFileSync(join(root,'MEMORY.md'),'utf8'),beforeDetail=readFileSync(join(root,'user.md'),'utf8')
 const tools=[],handlers=[],session={id:'text-duplicate-'+mode}
 const ctx={systemPrompt:{context(){}},workingDirectory:{get(){return cwd}},tools:{register(tool){tools.push(tool)}},on(name,handler){handlers.push([name,handler])},llm:{async listProviders(){return[{provider:'fixture',model:'fixture'}]},async prepareCall(){return{config:{},async *stream(request){
  const prompt=request.messages[0].content[0].text,message=prompt.split('\n').flatMap(line=>{try{const item=JSON.parse(line);return item.role==='user'?[item]:[]}catch{return[]}}).at(-1)
  const proposed=mode==='same-conditions'?meaning:mode==='invalid-relations'?{kind:'belief',relations:[{target:'b'.repeat(64),stance:'supports'}]}:{kind:'preference'}
  yield{type:'text-delta',text:JSON.stringify([{type:'user',scope:'global',basis:'explicit',summary,meaning:proposed,evidence:[{messageId:message.id,quote:message.text}]}])};yield{type:'finish',reason:{kind:'stop'}}
 }}}}}
 apply(ctx,{autoCapture:{everyTurns:1}})
 const emit=event=>{for(const [name,handler] of handlers)if(name==='session/event')handler(session,event)}
 emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text:'我的初稿长期使用默认标记 olive-synthetic24，跨所有项目适用。'}]}}})
 emit({type:'step/end',data:{}})
 let state;const until=Date.now()+4000
 while(Date.now()<until){try{state=JSON.parse(readFileSync(join(root,'.capture-state.json')))}catch{}if(state?.lastCaptureAt&&!state.running)break;await new Promise(resolve=>setTimeout(resolve,20))}
 assert.equal(state?.running,false);const diagnostic=normalizeCaptureDiagnostic(state.diagnostic)
 assert.equal(readFileSync(join(root,'MEMORY.md'),'utf8'),beforeIndex)
 assert.equal(readFileSync(join(root,'user.md'),'utf8'),beforeDetail)
 const records=candidateSnapshot(root,'global').records
 assert.equal(records.filter(record=>['recorded','adopted'].includes(record.status)).length,1)
 assert.deepEqual(records.find(record=>record.status==='recorded').meaning.conditions,meaning.conditions)
 const hit=searchStore(root,'olive-synthetic24',{context:{document_kind:'final'}})
 assert.equal(hit.hits.length,0,'A staged broader interpretation must not become effective')
 if(mode==='changed-conditions'){
  assert.equal(diagnostic.classification,'pending-review');assert.equal(diagnostic.staged,1);assert.equal(diagnostic.writeFailures,0)
  assert.equal(listCandidates(root).total,1)
  assert.ok(readFileSync(join(root,'.audit.jsonl'),'utf8').includes('duplicate-meaning-needs-review'))
 }else if(mode==='same-conditions'){
  assert.equal(diagnostic.classification,'already-known');assert.equal(diagnostic.duplicates,1);assert.equal(listCandidates(root).total,0)
 }else{
  assert.equal(diagnostic.classification,'admission-rejected');assert.equal(diagnostic.admissionRejected,1);assert.equal(listCandidates(root).total,0)
 }
}))

test('automatic source-grounded text cannot become effective without explicit meaning',()=>{const message={id:'synthetic-owner',role:'user',text:'我的长期署名是合成玉叶',hash:'a'.repeat(64)},candidate={type:'user',scope:'global',basis:'explicit',summary:'长期署名合成玉叶',evidence:[{messageId:message.id,quote:message.text}]};assert.equal(assessCandidate(candidate,[message],false).reason,'invalid-meaning');assert.equal(assessCandidate({...candidate,meaning:{kind:'claim'}},[message],false).status,'eligible');assert.equal(assessCandidate({...candidate,basis:'inferred'},[message],false).reason,'invalid-meaning')})
