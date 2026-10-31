import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {initializeManagedMemory,managedMemoryStatus,writeMemory,indexLine,withdrawManagedSource,withdrawManagedSourceKey,searchStore} from './index.mjs'
import {withdrawalSelector,discoverWithdrawalIdentity} from './source-identity.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex'),key=(sid,msg)=>hash(JSON.stringify([sid,msg]))
const sid='synthetic-current-owner',msg='synthetic-current-message',target=key(sid,msg)
function box(run,{legacySid='synthetic-different-legacy-owner',auditOnly=false}={}){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'legacy-source-identity-'))),data=join(root,'memory'),project=join(data,'projects/v2-synthetic')
 mkdirSync(project,{recursive:true})
 const legacy=indexLine('user','Synthetic legacy preference remains cobalt7654',undefined,false)+'\n'
 writeFileSync(join(data,'MEMORY.md'),legacy)
 writeFileSync(join(data,'.audit.jsonl'),JSON.stringify({op:'write',outcome:'ok',type:'user',sessionId:legacySid,line:legacy.trim(),withDetail:false})+'\n')
 const rows=[{name:'.',role:'global'},{name:'projects/v2-synthetic',role:'project'}]
 const plan=initializeManagedMemory(data,rows);initializeManagedMemory(data,rows,{apply:true,reviewed:plan.review})
 const summary='Synthetic current decision saffron3197',line=indexLine('user',summary,undefined,false),evidence=[{messageId:msg,hash:hash(summary),quote:summary}]
 if(auditOnly){
  writeFileSync(join(project,'MEMORY.md'),line+'\n')
  writeFileSync(join(project,'.audit.jsonl'),JSON.stringify({op:'write',outcome:'ok',type:'user',sessionId:sid,evidence,line,withDetail:false})+'\n')
 }else writeMemory({dir:project,type:'user',scope:'project',summary,line,provenance:{basis:'tool-context',sessionId:sid,callHash:hash('synthetic-call'),evidence}})
 try{return run({root,data,project,legacy})}finally{rmSync(root,{recursive:true,force:true})}
}
function finish(f,byKey=false){const call=byKey?(options=>withdrawManagedSourceKey(f.data,target,options)):(options=>withdrawManagedSource(f.data,sid,msg,options));const plan=call();return call({apply:true,controlReview:plan.controlReview})}
function preserved(f){assert.equal(readFileSync(join(f.data,'MEMORY.md'),'utf8'),f.legacy);assert.equal(searchStore(f.project,'saffron3197').hits.length,0);assert.ok(searchStore(f.data,'cobalt7654').hits.length);assert.equal(managedMemoryStatus(f.data).operations[0].pending,0)}
test('managed withdrawal identifies a different session without deleting or blocking unrelated old data',()=>box(f=>{assert.equal(finish(f).cleanupComplete,true);preserved(f);assert.doesNotMatch(readFileSync(f.data+'.control/state.sqlite').toString('utf8'),/synthetic-current-owner|synthetic-current-message/)}))
test('key-only withdrawal finds the exact source preimage in another registered store',()=>box(f=>{assert.equal(finish(f,true).cleanupComplete,true);preserved(f)}))
test('missing lineage in the same legacy session still blocks before any global barrier',()=>box(f=>{assert.throws(()=>finish(f),/withdrawal-missing-source-lineage/);assert.equal(managedMemoryStatus(f.data).operations.length,0);assert.ok(searchStore(f.project,'saffron3197').hits.length);assert.equal(readFileSync(join(f.data,'MEMORY.md'),'utf8'),f.legacy)},{legacySid:sid}))
test('an unknown source hash cannot bypass legacy lineage review',()=>box(f=>{assert.throws(()=>withdrawManagedSourceKey(f.data,key('unseen-owner','unseen-message')),/withdrawal-missing-source-lineage/);assert.equal(managedMemoryStatus(f.data).operations.length,0)}))
test('a forged identity cannot narrow the legacy safety check',()=>box(f=>{assert.throws(()=>withdrawManagedSourceKey(f.data,target,{sourceIdentity:{sessionId:'different-owner',messageId:msg}}),/withdrawal-source-identity-mismatch/);assert.equal(managedMemoryStatus(f.data).operations.length,0)}))
for(const phase of ['checkpoint','local-cleanup'])test('key-only recovery remains safe after '+phase+' interruption',()=>box(f=>{
 const plan=withdrawManagedSourceKey(f.data,target)
 assert.throws(()=>withdrawManagedSourceKey(f.data,target,{apply:true,controlReview:plan.controlReview,cleanupFault:point=>{if(point.phase===phase&&point.index===(phase==='checkpoint'?0:1))throw Error('synthetic-interruption')}}),/synthetic-interruption/)
 const operation=managedMemoryStatus(f.data).operations[0];assert.ok(operation.pending)
 assert.equal(searchStore(f.project,'saffron3197').hits.length,0)
 assert.equal(withdrawManagedSourceKey(f.data,target,{apply:true,operationId:operation.id}).cleanupComplete,true);preserved(f)
}))
test('traceable audit-only data can supply the exact preimage and is removed independently',()=>box(f=>{assert.equal(finish(f,true).cleanupComplete,true);preserved(f);assert.doesNotMatch(readFileSync(join(f.project,'.audit.jsonl'),'utf8'),/saffron3197/)},{auditOnly:true}))
test('source identity requires an exact hash preimage and never infers it from text',()=>{
 assert.deepEqual(withdrawalSelector(target,{sessionId:' '+sid+' ',messageId:msg}),{sourceKey:target,sessionId:sid,messageId:msg})
 assert.throws(()=>withdrawalSelector(target,{sessionId:sid,messageId:msg+'-wrong'}),/source-identity-mismatch/)
 assert.equal(discoverWithdrawalIdentity(target,[{text:sid+' '+msg,sessionId:sid,evidence:[{messageId:'unrelated'}]}]),undefined)
 assert.equal(discoverWithdrawalIdentity(target,[{sessionId:sid,evidence:[{messageId:msg}]}]).sessionId,sid)
})
