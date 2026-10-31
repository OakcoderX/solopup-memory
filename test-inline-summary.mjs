import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from './fixture-host.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {writeMemory,storeDirFor,indexLine,summaryOf,isExpired,lookupLinks,storeRevision,adoptCandidate,withdrawManagedSource,searchStore} from './index.mjs'
import {stageCandidate} from './candidates.mjs'
import {entryId} from './security.mjs'
const legacy=JSON.parse(readFileSync(new URL('./corpus/legacy-summary-v15.json',import.meta.url)))
function box(scope='global'){const root=realpathSync(mkdtempSync(join(tmpdir(),'dsh-inline-summary-'))),home=join(root,'home');mkdirSync(home,{recursive:true});const previous=process.env.DSH_HOME;process.env.DSH_HOME=home;const dir=storeDirFor(scope,root);mkdirSync(dir,{recursive:true});let mounted
 function mount(){if(mounted)return mounted;const tools=[],captured={};apply({systemPrompt:{context:provider=>captured.provider=provider},tools:{register:tool=>tools.push(tool)},workingDirectory:{get:()=>root},on(){}},{autoCapture:{enabled:false}});return mounted={tools,provider:captured.provider}}
 return{root,dir,get tools(){return mount().tools},get provider(){return mount().provider},close(){if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(root,{recursive:true,force:true})}}
}
const write=box=>box.tools.find(tool=>tool.name==='memory_write')
function payload(dir){return{type:'user',scope:'project',summary:'合成摘要：回复必须先给结论',sessionId:'inline-source',indexRevision:storeRevision(dir),evidence:[{messageId:'inline-message',hash:'a'.repeat(64),quote:'这个合成测试要求回复先给结论'}]}}
function restore(dir){for(const [name,text] of Object.entries(legacy.files))writeFileSync(join(dir,name),text,{mode:0o600})}
function withdraw(dir,source='inline-source',message='inline-message'){const view=withdrawManagedSource(dir,source,message);return withdrawManagedSource(dir,source,message,{apply:true,reviewedIndex:view.reviewedIndex,candidateRevision:view.candidateRevision})}
test('native summary-only writes state that content is inline and create no fictitious topic file',async()=>{
 const b=box();try{const value=await write(b).execute({type:'user',scope:'global',summary:'合成偏好只使用银灰色'},{});assert.match(value.indexLine,/ — 索引摘要$/);assert.equal(existsSync(join(b.dir,'user.md')),false);assert.equal(Object.hasOwn(value,'detailPath'),false);assert.equal(value.id,entryId(value.indexLine));assert.deepEqual(value,JSON.parse(JSON.stringify(value)))}finally{b.close()}
})
test('whitespace-only detail is inline; actual detail retains a real topic reference',async()=>{
 const b=box();try{const blank=await write(b).execute({type:'user',scope:'global',summary:'合成偏好使用冷色画面',detail:' \n\t '},{});assert.match(blank.indexLine,/索引摘要$/);const detailed=await write(b).execute({type:'feedback',scope:'global',summary:'合成镜头避免过度锐化',detail:'本合成测试的近景应保留柔和边缘。'},{});assert.match(detailed.indexLine,/ — feedback.md$/);assert.ok(existsSync(detailed.detailPath));assert.match(readFileSync(detailed.detailPath,'utf8'),/柔和边缘/)}finally{b.close()}
})
test('a native repeat cannot silently assign meaning to a legacy unclassified row; line identity and history survive',async()=>{
 const b=box();try{const old=writeMemory({type:'user',dir:b.dir,line:indexLine('user','合成旧偏好继续先给结论')});const before=readFileSync(join(b.dir,'MEMORY.md'),'utf8'),history=readFileSync(join(b.dir,'.history.jsonl'),'utf8');await assert.rejects(write(b).execute({type:'user',scope:'global',summary:'合成旧偏好继续先给结论',meaning:{kind:'preference'}},{}),/duplicate-needs-distinct-summary/);assert.equal(readFileSync(join(b.dir,'MEMORY.md'),'utf8'),before);assert.equal(entryId(old.indexLine),old.id);assert.equal(readFileSync(join(b.dir,'.history.jsonl'),'utf8'),history)}finally{b.close()}
})
test('an older explicit routing format cannot duplicate a newer inline-only fact',async()=>{
 const b=box();try{const first=writeMemory({type:'user',dir:b.dir,line:indexLine('user','合成画板采用柔和绿色',undefined,false)});const repeat=writeMemory({type:'user',dir:b.dir,line:indexLine('user','合成画板采用柔和绿色')});assert.equal(repeat.duplicate,true);assert.equal(repeat.indexLine,first.indexLine);assert.equal(readFileSync(join(b.dir,'.history.jsonl'),'utf8').trim().split('\n').length,1)}finally{b.close()}
})
test('superseding a legacy summary keeps bidirectional version IDs across routing formats',async()=>{
 const b=box();try{const old=writeMemory({type:'user',dir:b.dir,line:indexLine('user','合成当前代码是 violet-legacy')});const current=await write(b).execute({type:'user',scope:'global',summary:'合成当前代码是 silver-current',supersedes:'violet-legacy',revisionMode:'replace'},{});assert.equal(lookupLinks(b.dir,{id:old.id}).supersededById,current.id);assert.equal(lookupLinks(b.dir,{id:current.id}).supersedesLine,old.indexLine);assert.equal(searchStore(b.dir,'violet-legacy').hits.length,0)}finally{b.close()}
})
test('inline summary parsing and expiry retain literal expiry-looking words inside the summary',()=>{
 const line=indexLine('project','合成正文包含 (exp:2029-01-01)', '2030-02-03',false)
 assert.equal(summaryOf(line),'合成正文包含 (exp:2029-01-01)')
 const plain=indexLine('project','合成限期项目决定','2030-02-03',false)
 assert.equal(isExpired(plain,new Date('2030-02-03T10:00:00').getTime()),false);assert.equal(isExpired(plain,new Date('2030-02-04T10:00:00').getTime()),true)
})
test('adopting and withdrawing a new summary-only candidate uses its actual inline identity',()=>{
 const b=box();try{const data=payload(b.dir),item=stageCandidate(b.dir,data),view=adoptCandidate(b.dir,item.id);const result=adoptCandidate(b.dir,item.id,{apply:true,reviewedIndex:view.reviewedIndex,candidateRevision:view.candidateRevision});const line=indexLine(data.type,data.summary,undefined,false);assert.equal(result.memoryId,entryId(line));assert.match(readFileSync(join(b.dir,'MEMORY.md'),'utf8'),/索引摘要/);assert.equal(withdraw(b.dir).effectiveRemoved,1);assert.equal(searchStore(b.dir,'回复必须先给结论').hits.length,0)}finally{b.close()}
})
test('an actual v0.15 adopted summary fixture can be re-reviewed, repeated and withdrawn without migration',()=>{
 const b=box('project');try{restore(b.dir);const before=readFileSync(join(b.dir,'MEMORY.md'),'utf8'),view=adoptCandidate(b.dir,legacy.candidateId);const repeated=adoptCandidate(b.dir,legacy.candidateId,{apply:true,reviewedIndex:view.reviewedIndex,candidateRevision:view.candidateRevision});assert.equal(repeated.duplicate,true);assert.equal(repeated.memoryId,legacy.memoryId);assert.equal(readFileSync(join(b.dir,'MEMORY.md'),'utf8'),before);assert.equal(withdraw(b.dir,'legacy-summary-source','legacy-summary-message').effectiveRemoved,1);assert.equal(searchStore(b.dir,'合成旧摘要').hits.length,0)}finally{b.close()}
})
test('ambiguous old/new effective lines are rejected before candidate or source-withdrawal mutation',()=>{
 const b=box('project');try{restore(b.dir);const record=JSON.parse(legacy.files['.candidates.json']).records[0];writeFileSync(join(b.dir,'MEMORY.md'),legacy.files['MEMORY.md']+'\n'+indexLine(record.type,record.summary,undefined,false)+'\n');const before=readFileSync(join(b.dir,'.candidates.json'),'utf8');assert.throws(()=>adoptCandidate(b.dir,legacy.candidateId),/ambiguous-effective/);assert.throws(()=>withdrawManagedSource(b.dir,'legacy-summary-source','legacy-summary-message'),/ambiguous-effective/);assert.equal(readFileSync(join(b.dir,'.candidates.json'),'utf8'),before)}finally{b.close()}
})
test('legacy missing-topic references are diagnosed at render time without rewriting original index or ID',()=>{
 const b=box('project');try{restore(b.dir);const before=readFileSync(join(b.dir,'MEMORY.md'),'utf8');const rendered=b.provider.text({agent:{session:{}}});assert.match(rendered,/旧索引引用尚无可读主题文件：user.md/);assert.match(rendered,/不要假定存在额外细节/);assert.equal(readFileSync(join(b.dir,'MEMORY.md'),'utf8'),before);assert.equal(lookupLinks(b.dir,{id:legacy.memoryId}).found,true);writeFileSync(join(b.dir,'user.md'),'# 合成可读主题\n');assert.doesNotMatch(b.provider.text({agent:{session:{}}}),/旧索引引用尚无可读主题文件/)}finally{b.close()}
})
