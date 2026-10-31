import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {writeMemory,indexLine,searchStore,withdrawManagedSource,storeRevision,recoverMemoryPublication,forgetMemory,adoptCandidate} from './index.mjs'
import {candidateSnapshot,stageCandidate,withdrawSource,withdrawalPolicy,sourceLedgerStatus} from './candidates.mjs'
import {prepareSourceRetirement,validateRetiredSource,SOURCE_LEDGER_BYTES} from './source-retirement.mjs'
import {commitPublication} from './publication.mjs'
const box=run=>{const root=mkdtempSync(join(tmpdir(),'source-retire-'));mkdirSync(join(root,'memory'));try{return run(join(root,'memory'))}finally{rmSync(root,{recursive:true,force:true})}}
const hash=value=>createHash('sha256').update(value).digest('hex')
function write(dir,n,{supersedes,publicationFault,unique=false}={}){const value='palette'+String(n).padStart(4,'0'),summary=unique?'Synthetic '+hash('entry-'+n).slice(0,48)+' '+value:'Synthetic retained source '+value,detail='Synthetic private detail '+value;return writeMemory({dir,scope:'global',type:'user',summary,detail,supersedes,line:indexLine('user',summary,undefined,true),provenance:{sessionId:'synthetic-retirement-owner',basis:'tool-context',via:'memory_write',callHash:hash('call-'+n),evidence:[{messageId:'owner-'+n,hash:hash('message-'+n),quote:'Synthetic owner chose '+value}]},publicationFault})}
function series(dir,count){let result;for(let n=1;n<=count;n++)result=write(dir,n,n===1?{}:{supersedes:'palette'+String(n-1).padStart(4,'0')});return result}
function withdraw(dir,n){const options={scope:'global'},plan=withdrawManagedSource(dir,'synthetic-retirement-owner','owner-'+n,options);return withdrawManagedSource(dir,'synthetic-retirement-owner','owner-'+n,{...options,apply:true,reviewedIndex:plan.reviewedIndex,candidateRevision:plan.candidateRevision})}
test('210 currently effective source writes do not share the 200 pending-inference limit',()=>box(dir=>{for(let n=1;n<=210;n++)write(dir,n,{unique:true});const snapshot=candidateSnapshot(dir,'global');assert.equal(snapshot.records.filter(r=>r.status==='recorded').length,210);assert.equal(snapshot.retiredCount,0);assert.ok(searchStore(dir,'palette0210').hits.length>0);assert.ok(searchStore(dir,'palette0001').hits.length>0)}))
test('source retirement keeps revocation roots, removes raw provenance and prevents restored projections',()=>box(dir=>{
 write(dir,1);const oldIndex=readFileSync(join(dir,'MEMORY.md')),oldTopic=readFileSync(join(dir,'user.md'))
 for(let n=2;n<=240;n++)write(dir,n,{supersedes:'palette'+String(n-1).padStart(4,'0')})
 let snapshot=candidateSnapshot(dir,'global'),receipt=snapshot.records.find(r=>r.status==='retired'&&r.sources.includes(hash(JSON.stringify(['synthetic-retirement-owner','owner-1']))))
 assert.ok(receipt);assert.ok(snapshot.retiredCount>0);assert.equal(receipt.origin,'tool-context');assert.equal(receipt.summary,undefined);assert.equal(receipt.evidence,undefined);assert.equal(receipt.detail,undefined);assert.equal(JSON.stringify(receipt).includes('palette0001'),false)
 assert.doesNotMatch(readFileSync(join(dir,'user.md'),'utf8'),/palette0001/)
 assert.throws(()=>withdrawSource(dir,'synthetic-retirement-owner','owner-1'),/effective-withdrawal/)
 writeFileSync(join(dir,'MEMORY.md'),oldIndex);writeFileSync(join(dir,'user.md'),oldTopic)
 assert.equal(searchStore(dir,'palette0001').hits.length,0)
 const result=withdraw(dir,1);assert.equal(result.effectiveRemoved,1);assert.doesNotMatch(readFileSync(join(dir,'MEMORY.md'),'utf8'),/palette0001/);assert.doesNotMatch(readFileSync(join(dir,'user.md'),'utf8'),/palette0001/)
 snapshot=candidateSnapshot(dir,'global');assert.equal(snapshot.records.some(r=>r.id===receipt.id),false);assert.ok(withdrawalPolicy(dir).candidateIds.includes(receipt.id))
}))
test('retirement and a new effective write recover together after a partial publication',()=>box(dir=>{
 series(dir,159)
 assert.throws(()=>write(dir,160,{supersedes:'palette0159',publicationFault:({phase,index})=>{if(phase==='file'&&index===1)throw Error('synthetic-retirement-interruption')}}),/synthetic-retirement-interruption/)
 assert.throws(()=>searchStore(dir,'palette0160'),/publication-needs-recovery/);assert.throws(()=>candidateSnapshot(dir,'global'),/publication-needs-recovery/)
 recoverMemoryPublication(dir,{apply:true});assert.ok(candidateSnapshot(dir,'global').retiredCount>0);assert.ok(searchStore(dir,'palette0160').hits.length>0);assert.equal(withdraw(dir,1).effectiveRemoved,1)
}))
test('current memory and pending inferences are never selected as retired provenance',()=>box(dir=>{
 const current=write(dir,1),id=stageCandidate(dir,{scope:'global',type:'user',summary:'Synthetic pending separate belief',sessionId:'pending-owner',indexRevision:storeRevision(dir),evidence:[{messageId:'proposal',hash:hash('proposal'),quote:'Synthetic pending observation'}]}).id
 const raw=JSON.parse(readFileSync(join(dir,'.candidates.json')));prepareSourceRetirement(dir,raw,{force:true});assert.equal(raw.retired.length,0);assert.ok(raw.records.some(r=>r.id===id));assert.ok(raw.records.some(r=>r.indexLine===current.indexLine))
}))
test('a legacy adopted record without an exact original line hash is retained for explicit migration',()=>box(dir=>{
 const id=stageCandidate(dir,{scope:'global',type:'user',summary:'Synthetic old reviewed fact',detail:'Synthetic old reviewed detail',sessionId:'legacy-owner',indexRevision:storeRevision(dir),evidence:[{messageId:'legacy-source',hash:hash('legacy'),quote:'Synthetic independent old source'}]}).id
 const plan=adoptCandidate(dir,id,{scope:'global'});adoptCandidate(dir,id,{scope:'global',apply:true,reviewedIndex:plan.reviewedIndex,candidateRevision:plan.candidateRevision});forgetMemory(dir,'old reviewed fact')
 const raw=JSON.parse(readFileSync(join(dir,'.candidates.json')));delete raw.records[0].adoption.lineHash;prepareSourceRetirement(dir,raw,{force:true});assert.equal(raw.retired.length,0);assert.equal(raw.records[0].status,'adopted')
}))
test('an inactive reviewed adoption retains proof footprints without remaining independently effective',()=>box(dir=>{
 const id=stageCandidate(dir,{scope:'global',type:'user',summary:'Synthetic reviewed fact for retirement',detail:'Synthetic reviewed detail for retirement',sessionId:'review-owner',indexRevision:storeRevision(dir),evidence:[{messageId:'review-source',hash:hash('review'),quote:'Synthetic independent reviewed observation'}]}).id
 const plan=adoptCandidate(dir,id,{scope:'global'});adoptCandidate(dir,id,{scope:'global',apply:true,reviewedIndex:plan.reviewedIndex,candidateRevision:plan.candidateRevision});forgetMemory(dir,'reviewed fact for retirement')
 const raw=JSON.parse(readFileSync(join(dir,'.candidates.json'))),writes=prepareSourceRetirement(dir,raw,{force:true});assert.equal(raw.records.length,0);assert.equal(raw.retired[0].origin,'reviewed-adoption');assert.equal(raw.retired[0].adoption,undefined);assert.ok(writes.some(file=>file.name==='user.md'&&!file.text.includes('reviewed detail for retirement')))
}))
test('unreviewed topic archives keep full source records instead of discarding their text',()=>box(dir=>{
 write(dir,1);forgetMemory(dir,'palette0001');writeFileSync(join(dir,'user.archive-20261029.md'),'Synthetic unknown archive')
 const raw=JSON.parse(readFileSync(join(dir,'.candidates.json')));assert.deepEqual(prepareSourceRetirement(dir,raw,{force:true}),[]);assert.equal(raw.retired.length,0);assert.equal(raw.records[0].status,'recorded')
}))
test('changed detail markers cannot be retired under an outdated content footprint',()=>box(dir=>{
 write(dir,1);forgetMemory(dir,'palette0001');const file=join(dir,'user.md');writeFileSync(file,readFileSync(file,'utf8').replace('private detail','changed detail'));const raw=JSON.parse(readFileSync(join(dir,'.candidates.json')))
 assert.throws(()=>prepareSourceRetirement(dir,raw,{force:true}),/detail-diverged/);assert.equal(raw.retired.length,0);assert.equal(raw.records.length,1)
}))
test('receipt tampering and unknown keys are rejected; no raw-body fallback is accepted',()=>box(dir=>{
 write(dir,1);forgetMemory(dir,'palette0001');const raw=JSON.parse(readFileSync(join(dir,'.candidates.json')));prepareSourceRetirement(dir,raw,{force:true});const receipt=raw.retired[0];assert.deepEqual(validateRetiredSource(receipt),receipt)
 assert.throws(()=>validateRetiredSource({...receipt,lineHash:'f'.repeat(64)}),/corrupt-retired/);assert.throws(()=>validateRetiredSource({...receipt,detail:'Synthetic injected body'}),/corrupt-retired/)
}))
test('the new source ledger has a separate bounded byte envelope',()=>{assert.equal(SOURCE_LEDGER_BYTES,2*1024*1024)})
test('capacity status exposes counts, explicitly reports corruption, and never returns source bodies',()=>box(dir=>{
 write(dir,1);const good=sourceLedgerStatus(dir);assert.equal(good.available,true);assert.equal(good.fullRecords,1);assert.equal(good.pendingLimit,200);assert.equal(JSON.stringify(good).includes('palette0001'),false)
 const file=join(dir,'.candidates.json');writeFileSync(file,'{malformed');const bad=sourceLedgerStatus(dir);assert.equal(bad.available,false);assert.equal(bad.fullRecords,undefined);assert.equal(bad.reason,'source-ledger-unavailable');assert.equal(readFileSync(file,'utf8'),'{malformed')
}))
test('withdrawing a retired root keeps its source revoked after the compact receipt is removed',()=>box(dir=>{
 write(dir,1);forgetMemory(dir,'palette0001');const state=JSON.parse(readFileSync(join(dir,'.candidates.json'))),topics=prepareSourceRetirement(dir,state,{force:true});commitPublication(dir,[...topics,{name:'.candidates.json',text:JSON.stringify(state)}]);withdraw(dir,1)
 assert.throws(()=>write(dir,1),/source-withdrawn|withdrawn-content/);assert.equal(candidateSnapshot(dir,'global').retiredCount,0)
}))
test('fresh independent review can reaffirm retired text while old detail footprints stay suppressed',()=>box(dir=>{
 write(dir,1);const oldTopic=readFileSync(join(dir,'user.md'));forgetMemory(dir,'palette0001');const state=JSON.parse(readFileSync(join(dir,'.candidates.json'))),topics=prepareSourceRetirement(dir,state,{force:true});commitPublication(dir,[...topics,{name:'.candidates.json',text:JSON.stringify(state)}])
 const id=stageCandidate(dir,{scope:'global',type:'user',summary:'Synthetic retained source palette0001',detail:'Synthetic newly reviewed current detail',sessionId:'new-independent-owner',indexRevision:storeRevision(dir),evidence:[{messageId:'new-confirmation',hash:hash('new-proof'),quote:'Synthetic new independent palette0001 confirmation'}]}).id
 const preview=adoptCandidate(dir,id,{scope:'global'});adoptCandidate(dir,id,{scope:'global',apply:true,reviewedIndex:preview.reviewedIndex,candidateRevision:preview.candidateRevision})
 assert.ok(searchStore(dir,'palette0001').hits.length>0)
 writeFileSync(join(dir,'user.md'),oldTopic);assert.equal(searchStore(dir,'private detail').hits.length,0)
 assert.equal(candidateSnapshot(dir,'global').records.filter(r=>r.status==='adopted').length,1)
}))
test('retired receipt capacity refuses a new publication without deleting old evidence or current memory',()=>box(dir=>{
 series(dir,14);const file=join(dir,'.candidates.json'),state=JSON.parse(readFileSync(file));state.schema=3
 state.retired=Array.from({length:4096},(_,n)=>{const value={id:hash('retired-id-'+n),status:'retired',origin:'tool-context',type:'user',scope:'global',sources:[hash('retired-source-'+n)],lineHash:hash('retired-line-'+n),memoryId:hash('retired-memory-'+n).slice(0,8),retiredAt:'2026-10-29T00:00:00.000Z'};return{...value,receiptHash:hash(JSON.stringify(value))}})
 const raw=JSON.stringify(state);assert.ok(Buffer.byteLength(raw)<SOURCE_LEDGER_BYTES);writeFileSync(file,raw);const index=readFileSync(join(dir,'MEMORY.md')),topic=readFileSync(join(dir,'user.md'))
 assert.throws(()=>write(dir,15,{supersedes:'palette0014'}),/retirement-capacity/);assert.equal(readFileSync(file,'utf8'),raw);assert.deepEqual(readFileSync(join(dir,'MEMORY.md')),index);assert.deepEqual(readFileSync(join(dir,'user.md')),topic)
}))
