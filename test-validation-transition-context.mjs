import test from 'node:test'
import assert from 'node:assert/strict'
import {validationTransitionContext as build} from './validation-transition-context.mjs'
const record=(n,patch={})=>({id:String(n).padStart(64,'a'),status:'recorded',scope:'global',type:'user',summary:'Synthetic default palette '+n,indexLine:'- [user] Synthetic default palette '+n+' — 索引摘要',meaning:{kind:'preference',conditions:[],except:[]},...patch});
const target={summary:'Synthetic default palette new',scope:'global'};
test('current same-scope interpretations are data and cannot expose old quotes, bodies or other projects',()=>{
 const r=build(target,[record(1,{detail:'BODY_SENTINEL',evidence:[{quote:'QUOTE_SENTINEL'}]}),record(2,{scope:'project',summary:'OTHER_PROJECT'}),record(3,{status:'pending',summary:'PENDING'})]);
 assert.equal(r.records.length,1);assert.equal(r.scope,'global');assert.doesNotMatch(JSON.stringify(r),/BODY_SENTINEL|QUOTE_SENTINEL|OTHER_PROJECT|PENDING/);
});
test('explicit target is first even when it is older than the recent and lexical matches',()=>{
 const rows=Array.from({length:12},(_,i)=>record(i));rows[0].summary='Old unrelated wording';
 const r=build({...target,supersedes:'[global] '+rows[0].indexLine},rows);assert.equal(r.records[0].recordId,rows[0].id);assert.equal(r.targetShown,true);assert.equal(r.omittedRecords,8);
});
test('all entries fit atomically and an omitted explicit target remains explicitly unshown',()=>{
 const rows=[record(1,{summary:'長'.repeat(200),meaning:{kind:'belief',alternatives:['長'.repeat(160)]}}),record(2)];
 const r=build({...target,supersedes:rows[0].indexLine},rows,{maxBytes:600});assert.ok(Buffer.byteLength(JSON.stringify(r))<=600);assert.equal(r.targetShown,false);assert.equal(r.records.some(x=>x.recordId===rows[0].id),false);
});
test('projections retain conditions and expiry without mutating the stored record',()=>{
 const row=record(1,{expires:'2030-04-05',meaning:{kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}],except:[]}}),r=build(target,[row]);
 assert.equal(r.records[0].expires,row.expires);r.records[0].meaning.conditions[0].value='final';assert.equal(row.meaning.conditions[0].value,'draft');
});
test('duplicate target identity and ambiguous target fragments are not silently resolved',()=>{
 assert.throws(()=>build(target,[record(1),record(1)]),/invalid/);
 assert.throws(()=>build({...target,supersedes:'Synthetic default palette'},[record(1),record(2)]),/invalid/);
});
test('invalid or insufficient context budgets cannot create a misleading empty view',()=>{
 assert.throws(()=>build(target,[],{maxBytes:128}),/budget/);assert.throws(()=>build({...target,scope:'both'},[]),/invalid/);assert.throws(()=>build(target,[],{maxRecords:0}),/invalid/);
});
test('an index-only legacy target is shown as unclassified data without inherited source metadata',()=>{
 const old=record(1,{legacyIndexOnly:true,meaning:undefined}),r=build({...target,supersedes:old.indexLine},[old])
 assert.equal(r.targetShown,true);assert.equal(r.records[0].identityKind,'index-line');assert.equal(r.records[0].sourceLinked,false);assert.equal(r.records[0].meaning,null)
 assert.match(r.boundary,/no verified source metadata/);assert.equal(build(target,[record(2)]).records[0].sourceLinked,true)
});

test('proposed effect exposes append versus replacement; metadata equality does not claim content equality',()=>{
 const old=record(1),same={...target,type:'user',meaning:old.meaning};const appended=build(same,[old]);
 assert.deepEqual(appended.operation,{proposed:'append',existingRowsRemain:'all',sameMetadataRecordIds:[old.id]});
 const replaced=build({...same,supersedes:old.indexLine},[old]);assert.equal(replaced.operation.proposed,'replace');assert.equal(replaced.operation.existingRowsRemain,'all-except-designated-target');
 assert.equal(build({...same,meaning:{kind:'claim'}},[old]).operation.sameMetadataRecordIds.length,0);
 assert.ok(Buffer.byteLength(JSON.stringify(appended))<=4096)
});
