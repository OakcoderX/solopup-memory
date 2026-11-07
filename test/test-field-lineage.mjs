/** Synthetic local provenance checks. No model or semantic-quality claim. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {compileValueRevision,normalizeFieldLineage} from '../field-lineage.mjs'
import {writeMemory,indexLine,searchStore,withdrawManagedSource,forgetMemory,recoverMemoryPublication,storeRevision} from '../index.mjs'
import {candidateSnapshot,stageCandidate,rejectCandidate,pruneCandidates} from '../candidates.mjs'
import {episodeSnapshot} from '../episodes.mjs'
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const meaning={kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}],except:[{dimension:'audience',value:'experts'}]}
const proof=n=>({sessionId:'owner-session-'+n,basis:'tool-context',via:'memory_write',callHash:hash(['call',n]),evidence:[{messageId:'message-'+n,hash:hash(['message',n]),quote:'Synthetic source '+n+' for lasting draft palette.'}]})
const rootOf=n=>hash([proof(n).sessionId,proof(n).evidence[0].messageId])
const box=run=>{const root=mkdtempSync(join(tmpdir(),'field-lineage-')),dir=join(root,'memory');mkdirSync(dir);try{return run(dir,root)}finally{rmSync(root,{recursive:true,force:true})}}
function record(dir,n,{parent,proposed={kind:'preference'},...options}={}){
 const compiled=parent?compileValueRevision(parent,proposed,'global'):undefined,summary='Synthetic draft palette colour-'+n;
 const expires=compiled?.expires??options.expires;
 const result=writeMemory({dir,type:'user',scope:'global',summary,expires,line:indexLine('user',summary,expires,false),meaning:compiled?.meaning??meaning,
  provenance:{...proof(n),...compiled?{fieldLineage:compiled.fieldLineage}:{}},...parent?{supersedes:parent.indexLine}:{},...options});
 const saved=candidateSnapshot(dir,'global').records.find(r=>r.status==='recorded'&&r.summary===summary);
 assert.ok(saved,'missing current source at revision '+n+': '+JSON.stringify(result));
 return{result,record:saved}
}
function withdraw(dir,n){const p=proof(n),plan=withdrawManagedSource(dir,p.sessionId,p.evidence[0].messageId,{scope:'global'});return withdrawManagedSource(dir,p.sessionId,p.evidence[0].messageId,{scope:'global',apply:true,controlReview:plan.controlReview,reviewedIndex:plan.reviewedIndex,candidateRevision:plan.candidateRevision})}

test('cross-session value revision keeps metadata roots separate from its own exact owner evidence',()=>box(dir=>{
 const a=record(dir,1).record,b=record(dir,2,{parent:a}).record;
 assert.deepEqual(b.meaning,a.meaning);assert.deepEqual(b.sources,[rootOf(1),rootOf(2)].sort());
 assert.equal(b.sessionId,proof(2).sessionId);assert.deepEqual(b.evidence,proof(2).evidence);
 assert.equal(b.fieldLineage.parentId,a.id);for(const f of Object.values(b.fieldLineage.fields))assert.deepEqual(f.roots,[rootOf(1)]);
 assert.equal(JSON.parse(readFileSync(join(dir,'.candidates.json'))).schema,4);
 assert.equal(episodeSnapshot(dir).state.entries.at(-1).source.fieldLineage.parentId,a.id);
}))
test('many value changes do not accumulate superseded intermediate-value sources',()=>box(dir=>{
 let latest=record(dir,1).record;
 for(let n=2;n<=18;n++){latest=record(dir,n,{parent:latest}).record;assert.deepEqual(latest.sources,[rootOf(1),rootOf(n)].sort())}
 assert.equal(latest.fieldLineage.fields.conditions.valueHash,hash(meaning.conditions));
 assert.equal(searchStore(dir,'colour-18',{context:{document_kind:'final',audience:'children'}}).hits.length,0);
}))
test('withdrawing an obsolete intermediate value preserves latest value while removing its old history',()=>box(dir=>{
 const a=record(dir,1).record,b=record(dir,2,{parent:a}).record;record(dir,3,{parent:b});withdraw(dir,2);
 assert.ok(searchStore(dir,'colour-3',{context:{document_kind:'draft',audience:'children'}}).hits.length);
 assert.equal(episodeSnapshot(dir).state.entries.some(r=>r.source.sources.includes(rootOf(2))),false);
 assert.deepEqual(candidateSnapshot(dir,'global').records.find(r=>r.status==='recorded').sources,[rootOf(1),rootOf(3)].sort());
}))
for(const n of [1,3])test('withdrawing required '+(n===1?'condition':'current value')+' root blocks the latest projection',()=>box(dir=>{
 const a=record(dir,1).record,b=record(dir,2,{parent:a}).record;record(dir,3,{parent:b});withdraw(dir,n);
 assert.equal(searchStore(dir,'colour-3').hits.length,0);
 assert.equal(episodeSnapshot(dir).state.entries.some(r=>r.source.sources.includes(rootOf(n))),false);
}))
test('an explicit complete replacement obtains new roots and can clear prior conditions',()=>box(dir=>{
 const a=record(dir,1).record,summary='Synthetic unconditional complete colour-2';
 writeMemory({dir,type:'user',scope:'global',summary,line:indexLine('user',summary,undefined,false),meaning:{kind:'preference'},supersedes:a.indexLine,provenance:proof(2)});
 withdraw(dir,1);const b=candidateSnapshot(dir,'global').records.find(r=>r.status==='recorded');assert.deepEqual(b.sources,[rootOf(2)]);assert.deepEqual(b.meaning.conditions,[]);assert.equal(b.fieldLineage,undefined);
 assert.ok(searchStore(dir,'complete colour-2').hits.length);
}))
test('nonempty changed conditions or exceptions require a complete replacement rather than silent inheritance',()=>box(dir=>{
 const a=record(dir,1).record;
 assert.throws(()=>compileValueRevision(a,{...meaning,conditions:[{dimension:'document_kind',value:'final'}]},'global'),/meaning-change-needs-complete-replacement/);
 assert.throws(()=>compileValueRevision(a,{...meaning,except:[{dimension:'audience',value:'children'}]},'global'),/meaning-change-needs-complete-replacement/);
 assert.throws(()=>compileValueRevision(a,{kind:'claim'},'global'),/kind-change-needs-complete-replacement/);
 assert.throws(()=>compileValueRevision(a,{kind:'preference'},'project'),/target-needs-complete-replacement/);
}))
test('a value revision does not invent a missing original condition',()=>box(dir=>{
 const a=record(dir,1,{meaning:{kind:'preference'}}).record,b=record(dir,2,{parent:a}).record;assert.deepEqual(b.meaning.conditions,[]);
}))
test('value changes retain the old expiry and cannot silently extend or clear its provenance',()=>box(dir=>{
 const a=record(dir,1,{expires:'2030-04-05'}).record,b=record(dir,2,{parent:a}).record;
 assert.equal(b.expires,a.expires);assert.match(b.indexLine,/exp:2030-04-05/);assert.equal(b.fieldLineage.fields.expires.valueHash,hash(a.expires));
 assert.throws(()=>compileValueRevision(b,{kind:'preference'},'global','2031-04-05'),/retention-change-needs-complete-replacement/);
}))
test('extra roots cannot be silently truncated to fit a field-lineage record',()=>box(dir=>{
 const a=record(dir,1).record,parent={...a,sources:[rootOf(1),rootOf(10),rootOf(11)].sort()},c=compileValueRevision(parent,{kind:'preference'},'global');
 assert.throws(()=>normalizeFieldLineage(c.fieldLineage,{scope:'global',meaning:c.meaning,ownSources:[rootOf(2)]}),/source-overflow/);
}))
test('forged parent, copied field digest and missing lineage schema are rejected before publication',()=>box(dir=>{
 const a=record(dir,1).record,c=compileValueRevision(a,{kind:'preference'},'global'),before=readFileSync(join(dir,'MEMORY.md'),'utf8');
 for(const mutate of [x=>x.parentId=hash('wrong parent'),x=>x.fields.conditions.valueHash=hash([]),x=>x.fields.kind.roots=[rootOf(2)]]){
  const forged=structuredClone(c.fieldLineage);mutate(forged);
  assert.throws(()=>record(dir,2,{parent:a,provenance:{...proof(2),fieldLineage:forged}}),/parent-|field-value-mismatch/);
  assert.equal(readFileSync(join(dir,'MEMORY.md'),'utf8'),before);
 }
 record(dir,2,{parent:a});const file=join(dir,'.candidates.json'),state=JSON.parse(readFileSync(file));state.schema=3;writeFileSync(file,JSON.stringify(state));assert.throws(()=>candidateSnapshot(dir,'global'),/field-format-needs-schema4/);
}))
test('a parent already replaced or removed cannot publish a stale child',()=>box(dir=>{
 const a=record(dir,1).record;record(dir,2,{parent:a});assert.throws(()=>record(dir,3,{parent:a}),/supersedes|target-needs-complete-replacement/);
 const b=candidateSnapshot(dir,'global').records.find(r=>r.status==='recorded');forgetMemory(dir,'colour-2');assert.throws(()=>record(dir,4,{parent:b}),/supersedes/);
}))
test('source retirement keeps schema4 and independent field roots after parent bodies are compressed',()=>box(dir=>{
 let b=record(dir,1).record;for(let n=2;n<=165;n++)b=record(dir,n,{parent:b}).record;
 const state=JSON.parse(readFileSync(join(dir,'.candidates.json')));assert.equal(state.schema,4);assert.ok(state.retired.length>0);
 assert.deepEqual(b.sources,[rootOf(1),rootOf(165)].sort());withdraw(dir,1);assert.equal(searchStore(dir,'colour-165').hits.length,0);
}))
test('ordinary pending rejection/pruning never downgrades a schema4 ledger',()=>box(dir=>{
 const a=record(dir,1).record;record(dir,2,{parent:a});const c=stageCandidate(dir,{type:'user',scope:'global',summary:'Synthetic unrelated pending',sessionId:'pending',evidence:[{messageId:'pending-message',hash:hash('pending'),quote:'Synthetic unrelated pending original words'}],indexRevision:storeRevision(dir)});
 rejectCandidate(dir,c.id);pruneCandidates(dir,{apply:true});assert.equal(JSON.parse(readFileSync(join(dir,'.candidates.json'))).schema,4);
}))
test('interrupted field-lineage publication is unreadable until recovery and retains revocation dependencies',()=>box(dir=>{
 const a=record(dir,1).record;
 assert.throws(()=>record(dir,2,{parent:a,publicationFault:({phase,index})=>{if(phase==='file'&&index===0)throw Error('synthetic interruption')}}),/synthetic interruption/);
 assert.throws(()=>searchStore(dir,'colour-2'),/publication-needs-recovery/);recoverMemoryPublication(dir,{apply:true});
 assert.deepEqual(candidateSnapshot(dir,'global').records.find(r=>r.status==='recorded').sources,[rootOf(1),rootOf(2)].sort());withdraw(dir,1);assert.equal(searchStore(dir,'colour-2').hits.length,0);
}))
