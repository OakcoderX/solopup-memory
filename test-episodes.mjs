import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,symlinkSync,linkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {apply,indexLine,searchStore,forgetMemory,forgetExpired,pruneStore,withdrawManagedSource,recoverMemoryPublication,adoptCandidate,storeRevision,storeDirFor} from './index.mjs'
import {candidateSnapshot,stageCandidate} from './candidates.mjs'
import {writeFixtureMemory} from './fixture-host.mjs'
import {episodeSnapshot,prepareEpisodes,historyRows,EPISODE_FILE,EPISODE_LIMIT} from './episodes.mjs'
import {toolProposal} from './source-record.mjs'

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
async function box(run){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-history-'))),home=join(base,'home'),cwd=join(base,'project'),previous=process.env.DSH_HOME
 mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 const captured={tools:[]},ctx={systemPrompt:{context(entry){captured.context=entry}},workingDirectory:{get(){return cwd}},tools:{register(tool){captured.tools.push(tool)}},on(){}}
 try{apply(ctx,{autoCapture:{enabled:false}});return await run({root:join(home,'memory'),home,cwd,captured})}
 finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
}
const seed=(root,summary,options={})=>writeFixtureMemory({type:'user',scope:'global',dir:root,line:indexLine('user',summary),summary,...options})
const history=(root,query,options={})=>searchStore(root,query,{view:'history',...options})
const pref={kind:'preference',conditions:[{dimension:'audience',value:'children'}]}
test('current lookup returns only new value; explicit history returns old/new states, source references and no adoption advice',()=>box(({root})=>{
 seed(root,'长期配色使用 violet4826',{meaning:pref,detail:'因为低龄听众喜欢清楚的轮廓'})
 const first=episodeSnapshot(root).state.latestSequence
 seed(root,'长期配色改用 silver5937',{meaning:pref,supersedes:'长期配色使用 violet4826'})
 assert.equal(searchStore(root,'violet4826').hits.length,0)
 const old=history(root,'violet4826');assert.equal(old.hits.length,1);assert.equal(old.hits[0].history.state,'superseded')
 assert.ok(old.hits[0].history.sourceMessageIds.length);assert.equal(old.hits[0].interpretation.advice.action,'continue')
 assert.equal(history(root,'配色',{atSequence:first}).hits[0].text.includes('violet4826'),true)
 assert.equal(history(root,'配色',{atSequence:episodeSnapshot(root).state.latestSequence}).hits[0].text.includes('silver5937'),true)
 assert.equal(old.historyCoverage[0].complete,true)
 const physical=readFileSync(join(root,EPISODE_FILE),'utf8').split('\n')[old.hits[0].line-1];assert.match(physical,/"id"/)
}))
test('record-time cutoff is not a claim about world effective time; unknown past and invalid future are explicit',()=>box(({root})=>{
 seed(root,'首个观察值 cobalt6048')
 const row=episodeSnapshot(root).state.entries[0]
 assert.equal(history(root,'cobalt6048',{asOf:row.recordedAt}).hits.length,1)
 const before=history(root,'cobalt6048',{asOf:'2000-01-01T00:00:00.000Z'});assert.equal(before.hits.length,0);assert.equal(before.historyCoverage[0].complete,false)
 assert.throws(()=>history(root,'cobalt6048',{atSequence:999}),/unknown-future-sequence/)
 assert.throws(()=>history(root,'cobalt6048',{atSequence:1,asOf:row.recordedAt}),/invalid-cutoff/)
 assert.throws(()=>searchStore(root,'cobalt6048',{atSequence:1}),/cutoff-needs-history/)
}))
test('index-only forget retires the current view but preserves explicitly labelled history and its source',()=>box(({root})=>{
 seed(root,'用户长期偏好简洁答复')
 forgetMemory(root,'用户长期偏好简洁答复')
 assert.equal(searchStore(root,'简洁答复').hits.length,0)
 const old=history(root,'简洁答复');assert.equal(old.hits[0].history.state,'forgotten')
}))
test('expiry removal and compaction close historical intervals in the same publication',()=>box(({root})=>{
 seed(root,'已到期的合成项目口径',{expires:'2001-01-01'})
 assert.equal(searchStore(root,'已到期').hits.length,0)
  assert.equal(history(root,'已到期').hits[0].history.state,'expired')
  assert.equal(history(root,'已到期',{asOf:episodeSnapshot(root).state.lastRecordedAt}).hits.length,0)
 assert.equal(forgetExpired(root).removed,1);assert.equal(history(root,'已到期').hits[0].history.state,'expired')
 seed(root,'第二条到期的合成项目口径',{expires:'2002-01-01'})
 assert.equal(pruneStore(root,{apply:true}).removed.expired,1)
 assert.equal(history(root,'第二条到期').hits[0].history.state,'compacted')
}))
test('source withdrawal purges historical payload; restoring old history cannot bypass the independent source barrier',()=>box(({root})=>{
 seed(root,'应撤回的历史颜色 amber7159',{detail:'私有历史理由 amber7159'})
 const record=candidateSnapshot(root,'global').records[0],before=readFileSync(join(root,EPISODE_FILE))
 seed(root,'另一独立颜色 jade8260')
 const preview=withdrawManagedSource(root,record.sessionId,record.evidence[0].messageId)
 withdrawManagedSource(root,record.sessionId,record.evidence[0].messageId,{apply:true,controlReview:preview.controlReview})
 assert.equal(history(root,'amber7159').hits.length,0);assert.equal(readFileSync(join(root,EPISODE_FILE),'utf8').includes('amber7159'),false)
 writeFileSync(join(root,EPISODE_FILE),before)
 assert.equal(history(root,'amber7159').hits.length,0)
 seed(root,'独立新写入可以继续 mint9371')
 assert.equal(readFileSync(join(root,EPISODE_FILE),'utf8').includes('amber7159'),false)
 assert.ok(history(root,'mint9371').hits.length)
}))
test('withdrawing only a former source leaves its independently sourced replacement usable',()=>box(({root})=>{
 seed(root,'旧配色使用 old_cyan1234')
 const old=candidateSnapshot(root,'global').records[0]
 seed(root,'新配色使用 new_teal2345',{supersedes:'旧配色使用 old_cyan1234'})
 const view=withdrawManagedSource(root,old.sessionId,old.evidence[0].messageId)
 withdrawManagedSource(root,old.sessionId,old.evidence[0].messageId,{apply:true,controlReview:view.controlReview})
 assert.equal(history(root,'old_cyan1234').hits.length,0);assert.equal(history(root,'new_teal2345').hits.length,1)
 assert.equal(searchStore(root,'new_teal2345').hits.length,1)
}))
test('legacy current data without history is not silently backfilled into a fabricated past',()=>box(({root})=>{
 seed(root,'升级前已存在的旧值 legacy_lime3456');rmSync(join(root,EPISODE_FILE))
 const before=history(root,'legacy_lime3456');assert.equal(before.hits.length,0);assert.equal(before.historyCoverage[0].exists,false)
 seed(root,'升级后确认的新值 modern_blue4567',{supersedes:'升级前已存在的旧值 legacy_lime3456'})
 const old=history(root,'legacy_lime3456');assert.equal(old.hits[0].history.observation,'observed-existing')
 const prior=history(root,'legacy_lime3456',{asOf:'2000-01-01T00:00:00.000Z'});assert.equal(prior.hits.length,0);assert.equal(prior.historyCoverage[0].complete,false)
}))
test('external edits expose an uncertain interval instead of inventing a deletion time or blocking unrelated new work',()=>box(({root})=>{
 seed(root,'被外部编辑移走的值 stone5678')
 writeFileSync(join(root,'MEMORY.md'),'# 记忆索引\n')
 const stale=history(root,'stone5678');assert.equal(stale.hits[0].history.state,'unreconciled');assert.equal(stale.historyCoverage[0].complete,false)
 seed(root,'不相关的新值 pearl6789')
 const observed=history(root,'stone5678');assert.equal(observed.hits[0].history.state,'uncertain-interval');assert.equal(observed.historyCoverage[0].untrackedTransitions,1)
 assert.equal(searchStore(root,'pearl6789').hits.length,1)
}))
test('a pending hypothesis has no historical publication; reviewed adoption preserves tentative epistemic type',()=>box(({root})=>{
 const item=stageCandidate(root,{type:'user',scope:'global',summary:'这是仍待检验的构图假设',meaning:{kind:'belief',alternatives:['可能是色温'],falsifiedBy:['控制色温后结果相反']},sessionId:'pending-historical',evidence:[{messageId:'m1',hash:'a'.repeat(64),quote:'这个构图假设仍然需要检验'}],indexRevision:storeRevision(root)})
 assert.equal(history(root,'构图假设').hits.length,0)
 const preview=adoptCandidate(root,item.id,{scope:'global'});adoptCandidate(root,item.id,{scope:'global',apply:true,candidateRevision:preview.candidateRevision,reviewedIndex:preview.reviewedIndex,controlRevision:preview.controlRevision})
 const hit=history(root,'构图假设').hits[0];assert.equal(hit.interpretation.epistemic,'tentative-belief');assert.equal(hit.interpretation.sourceOrigin,'reviewed-adoption')
}))
for(const phase of ['journal','history-file'])test('interrupted '+phase+' history publication refuses partial reads then recovers one logical record',()=>box(({root})=>{
 seed(root,'强退前旧值 crash_orange7890')
 assert.throws(()=>seed(root,'强退后新值 crash_purple8901',{supersedes:'强退前旧值 crash_orange7890',publicationFault:event=>{
  if(event.phase==='journal'&&phase==='journal')throw Error('injected interruption')
  if(event.phase==='file'&&phase==='history-file'){const plan=JSON.parse(readFileSync(join(root,'.publication.json')));if(plan.files[event.index].name===EPISODE_FILE)throw Error('injected interruption')}
 }}),/injected interruption/)
 assert.throws(()=>history(root,'强退'),/needs-recovery/)
 recoverMemoryPublication(root,{apply:true});const rows=episodeSnapshot(root).state.entries
 assert.equal(rows.length,2);assert.equal(rows.filter(r=>!r.closed).length,1)
 assert.equal(history(root,'crash_purple8901').hits.length,1);assert.equal(searchStore(root,'crash_orange7890').hits.length,0)
}))
test('tampered historical data fails closed rather than being shown as missing',()=>box(({root})=>{
 seed(root,'历史身份校验样本 quartz9012')
 const path=join(root,EPISODE_FILE),original=readFileSync(path,'utf8'),state=JSON.parse(original);state.entries[0].source.summary='篡改后的历史说法';writeFileSync(path,JSON.stringify(state))
 assert.throws(()=>history(root,'历史'),/corrupt-state-checksum/)
 writeFileSync(path,'invalid json');assert.throws(()=>history(root,'历史'),/corrupt-json/)
}))
test('history data symlinks and hardlinks are refused; read-only absence does not create history',()=>box(({root,home})=>{
 const missing=history(root,'没有历史');assert.equal(missing.historyCoverage[0].exists,false);assert.equal(existsSync(join(root,EPISODE_FILE)),false)
 seed(root,'链接测试的历史值 link_grey0124')
 const path=join(root,EPISODE_FILE),other=join(home,'outside-history.json');writeFileSync(other,readFileSync(path));rmSync(path);symlinkSync(other,path)
 assert.throws(()=>history(root,'link_grey0124'),/unsafe-file/);rmSync(path);linkSync(other,path)
 assert.throws(()=>history(root,'link_grey0124'),/unsafe-file/)
}))
test('history queries are project-scoped, and a cross-library sequence is rejected',()=>box(async({root,cwd,captured})=>{
 seed(root,'全局历史项目色 navy0123')
 const project=storeDirFor('project',cwd);writeFixtureMemory({type:'project',scope:'project',dir:project,line:indexLine('project','仅本项目使用 copper1235')})
 assert.equal(history(root,'copper1235').hits.length,0);assert.equal(history(project,'navy0123').hits.length,0)
 const tool=captured.tools.find(t=>t.name==='memory_search'),agent={session:{id:'scope-history'}}
 await assert.rejects(tool.execute({query:'历史',view:'history',atSequence:1},{agent}),/sequence-needs-one-scope/)
 const response=history(root,'navy0123');assert.deepEqual(response,JSON.parse(JSON.stringify(response)))
 assert.match(tool.output.render({},response)[0].text,/本地记录时间/)
}))
test('historical details support condition filtering and bounded excerpts without following former rules',()=>box(({root})=>{
 seed(root,'有条件的历史值 lavender2346',{meaning:pref,detail:'这是需要保留的历史解释 lavender2346。'.repeat(80)})
 seed(root,'另一有条件的历史值 rose3457',{meaning:pref,supersedes:'有条件的历史值 lavender2346'})
 assert.equal(history(root,'lavender2346',{context:{audience:'review'}}).hits.length,0)
 const hit=history(root,'历史解释',{context:{audience:'children'},task:{affectsDecision:true}}).hits[0]
 assert.ok(hit);assert.equal(hit.interpretation.advice.action,'continue');assert.ok(Buffer.byteLength(hit.text)<1400)
}))
test('bounded history drops closed entries with an explicit watermark; cutoff before the watermark is not complete',()=>box(({root})=>{
 const time='2026-10-29T00:00:00.000Z',entries=[]
 for(let i=1;i<=EPISODE_LIMIT;i++){
  const summary='合成保留窗口记录 '+i,line=indexLine('user',summary,undefined,false),source={...toolProposal({type:'user',scope:'global',summary,origin:'tool-context',sessionId:'synthetic-window',evidence:[{messageId:'m'+i,hash:'a'.repeat(64),quote:'Synthetic window source'}],indexRevision:'b'.repeat(64),callHash:digest(i),indexLine:line}),createdAt:time}
  const row={id:digest([source.id,i,'published']),sequence:i,recordedAt:time,observation:'published',scope:'global',line,source,...i<EPISODE_LIMIT?{closed:{sequence:EPISODE_LIMIT+i,at:time,reason:'superseded'}}:{}}
  entries.push({...row,checksum:digest(row)})
 }
 const state={schema:1,revision:1,latestSequence:2*EPISODE_LIMIT,startedAt:time,lastRecordedAt:time,droppedEntries:0,droppedThroughSequence:0,droppedThroughAt:null,untrackedTransitions:0,entries};writeFileSync(join(root,EPISODE_FILE),JSON.stringify({...state,checksum:digest(state)}))
 const summary='新写入推动窗口前进',line=indexLine('user',summary,undefined,false),source={...toolProposal({type:'user',scope:'global',summary,origin:'tool-context',sessionId:'synthetic-new',evidence:[{messageId:'new',hash:'c'.repeat(64),quote:'Synthetic new source'}],indexRevision:'d'.repeat(64),callHash:'e'.repeat(64),indexLine:line}),createdAt:time}
 const plan=prepareEpisodes(root,{before:entries.at(-1).line,after:line,published:{source,line},reason:'superseded',at:time});writeFileSync(join(root,EPISODE_FILE),plan.text)
 const after=episodeSnapshot(root).state;assert.equal(after.entries.length,EPISODE_LIMIT);assert.equal(after.droppedEntries,1)
 const view=historyRows(root,{index:line,atSequence:1});assert.equal(view.coverage.complete,false)
 assert.equal(historyRows(root,{index:line,atSequence:after.latestSequence}).coverage.complete,true)
}))
