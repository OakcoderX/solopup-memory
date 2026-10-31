/** Local revision-bound hooks. Access is provided by the owning coordinator. */
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {entryId,readSafely} from './security.mjs'
import {createHash} from 'node:crypto'
import {buildWithdrawal,candidateDetail,normalizedLineHash,prepareRestoredWithdrawalCleanup,filterWithdrawn} from './withdrawal.mjs'
import {commitPublication} from './publication.mjs'
import {removeRetiredBlock} from './source-retirement.mjs'
import {discoverWithdrawalIdentity,withdrawalSelector} from './source-identity.mjs'
import {readManagedLogs} from './managed-logs.mjs'
import {controlStatus,storeReview} from './managed-policy.mjs'
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function productHooks(dataRoot,local,sourceIdentity){
 const {indexLine,storeRevision,withdrawManagedSourceKey,recoverMemoryPublication,sourceWithdrawalReviewKey,withdrawalPolicy,candidateSnapshot,SOURCE_LEDGER_BYTES}=local
 const source=null,scope=row=>row.scope??(row.role==='global'?'global':'project'),identities=new Map()
 const selectorFor=(expected,currentRow)=>{
  // Cache only a mathematically verified preimage, never rows, permissions or cleanup approval.
  if(sourceIdentity!==undefined){const hint=withdrawalSelector(expected,sourceIdentity);identities.set(expected,hint);return hint}
  if(identities.has(expected))return identities.get(expected)
  const proofs=[]
  for(const row of [...new Map([...(currentRow?[currentRow]:[]),...controlStatus(dataRoot).stores].map(row=>[row.name,row])).values()]){
   if(row.quarantined)continue
   const dir=row.name==='.'?dataRoot:join(dataRoot,row.name)
   storeReview(dataRoot,row.name) // Validate physical paths and bounded files before reading identity proof.
   proofs.push(...candidateSnapshot(dir,scope(row)).records)
   for(const log of readManagedLogs(dir))for(const line of (log.raw??'').split('\n').filter(line=>line.trim())){let record;try{record=JSON.parse(line)}catch{throw Error('withdrawal-corrupt-log')};if(record?.op==='write'&&record.outcome==='ok')proofs.push(record)}
  }
  const selector=discoverWithdrawalIdentity(expected,proofs)??withdrawalSelector(expected)
  if(selector.sessionId!==undefined)identities.set(expected,selector)
  return selector
 }
 const reviewStore=(dir,row,expected)=>{
  if(source!==null&&expected!==source)throw Error('prototype-source-mismatch')
  const view=sourceWithdrawalReviewKey(dir,expected,scope(row))
  if(view.source!==expected)throw Error('prototype-source-identity-not-canonical')
  for(const record of view.affected.filter(record=>record.status==='adopted')){
   const line=indexLine(record.type,record.summary,undefined,typeof record.detail==='string'&&record.detail.trim().length>0)
   if(entryId(line)!==record.adoption.memoryId)throw Error('managed-memory-legacy-adoption-identity-diverged')
  }
  const plan=view.alreadyWithdrawn?{lineHashes:[],memoryIds:[],candidateIds:[],blocks:[]}:buildWithdrawal(dir,view.affected,selectorFor(expected,row),(type,summary,expires,hasTopic)=>indexLine(type,summary,expires,hasTopic),view.independent)
  const local=withdrawalPolicy(dir),mask={}
  for(const key of ['lineHashes','memoryIds','candidateIds'])mask[key]=[...new Set([...local[key],...plan[key]])]
  mask.entries=(readSafely(join(dir,'MEMORY.md'))??'').split(/\r?\n/).map(line=>({lineHash:normalizedLineHash(line),memoryId:entryId(line)})).filter(row=>mask.lineHashes.includes(row.lineHash)&&mask.memoryIds.includes(row.memoryId))
  mask.blocks=[...new Map([...local.blocks,...plan.blocks].map(block=>[block.id,block])).values()]
  return{revision:digest([storeRevision(dir),view.candidateRevision,storeReview(dataRoot,row.name)]),mask}
 }
 const cleanupStore=(dir,row,expected,reviewed)=>{
  if(source!==null&&expected!==source)throw Error('prototype-source-mismatch')
  const recovery=recoverMemoryPublication(dir)
  if(recovery.pending)recoverMemoryPublication(dir,{apply:true})
  let view=withdrawManagedSourceKey(dir,expected,{scope:scope(row),sourceIdentity:selectorFor(expected,row).sessionId===undefined?undefined:selectorFor(expected,row)})
  // A crash after local commit but before coordinator checkpoint is already done.
  if(view.alreadyWithdrawn){const writes=prepareRestoredWithdrawalCleanup(dir,withdrawalPolicy(dir),expected);if(writes.length)commitPublication(dir,writes);local.clearCache?.();return{complete:true,alreadyCleaned:writes.length===0,restoredProjectionsCleaned:writes.length>0}}
  const current=reviewStore(dir,row,expected) // Same source grant, re-reviewed under the global owner.
  withdrawManagedSourceKey(dir,expected,{scope:scope(row),sourceIdentity:selectorFor(expected,row).sessionId===undefined?undefined:selectorFor(expected,row),apply:true,reviewedIndex:view.reviewedIndex,candidateRevision:view.candidateRevision})
  return{complete:true,reviewed:current.revision,mask:current.mask}
 }
 const proofReader=(dir,row)=>{
  const snapshot=candidateSnapshot(dir,scope(row)),index=new Set((readSafely(join(dir,'MEMORY.md'))??'').split(/\r?\n/)),topics=new Map()
  const topic=type=>{if(!topics.has(type))topics.set(type,readSafely(join(dir,type+'.md'))??'');return topics.get(type)}
  const proofFor=record=>{
   const line=indexLine(record.type,record.summary,undefined,typeof record.detail==='string'&&record.detail.trim().length>0),lineHash=normalizedLineHash(line),memoryId=entryId(line)
   if(memoryId!==record.adoption.memoryId||!index.has(line))throw Error('prototype-fresh-effective-diverged')
   let block=null
   if(record.detail!==undefined){const text=candidateDetail(record.id,record.detail),body=topic(record.type),offset=body.indexOf(text);if(offset<0||body.indexOf(text,offset+text.length)>=0)throw Error('prototype-fresh-detail-diverged');block={id:record.id,length:text.length,hash:createHash('sha256').update(text).digest('hex')}}
   return{candidateId:record.id,lineHash,memoryId,sources:record.sources,block}
  }
  const assertCurrent=()=>{if(digest(readSafely(join(dir,'.candidates.json'),{maxBytes:SOURCE_LEDGER_BYTES})??null)!==snapshot.fingerprint)throw Error('prototype-fresh-state-changed')}
  return{snapshot,index,topic,proofFor,assertCurrent}
 }
 const reviewCandidate=(dir,row,candidateId)=>{
  const reader=proofReader(dir,row),record=reader.snapshot.records.find(record=>record.id===candidateId)
  if(record?.status!=='adopted')throw Error('prototype-fresh-candidate-not-adopted')
  const proof=reader.proofFor(record);reader.assertCurrent();return proof
 }
 const readFreshProofs=(dir,row,ids,blocked,revoked=[])=>{
  const reader=proofReader(dir,row),proofs=[]
  for(const record of reader.snapshot.records.filter(value=>value.status==='adopted'&&!value.sources.some(source=>revoked.includes(source)))){const line=indexLine(record.type,record.summary,undefined,typeof record.detail==='string'&&record.detail.trim().length>0);if(blocked.includes(normalizedLineHash(line)))proofs.push(reader.proofFor(record))}
  reader.assertCurrent();return proofs
 }
 const reconcileStore=(dir,row,expected)=>{
  const reader=proofReader(dir,row),adopted=reader.snapshot.records.filter(record=>['adopted','recorded','superseded'].includes(record.status)),knownLines=new Set(adopted.map(record=>['tool-context','quoted-extraction'].includes(record.origin)?record.indexLine:indexLine(record.type,record.summary,undefined,typeof record.detail==='string'&&record.detail.trim().length>0)))
  let quarantined=[...reader.index].some(line=>line.trim()&&!['# 记忆索引','## user','## feedback','## project','## reference'].includes(line.trim())&&!knownLines.has(line)&&!reader.snapshot.records.some(record=>record.status==='retired'&&record.lineHash===normalizedLineHash(line)))
  for(const type of ['user','feedback','project','reference']){
   let residual=reader.topic(type)
   for(const record of adopted.filter(record=>record.type===type&&record.detail!==undefined)){
    const block=candidateDetail(record.id,record.detail),start=residual.indexOf(block),header=residual.lastIndexOf('\n- ',start)
    if(start<0){const line=['tool-context','quoted-extraction'].includes(record.origin)?record.indexLine:indexLine(record.type,record.summary,undefined,true);if((record.status==='superseded'||!reader.index.has(line))&&!residual.includes(record.detail)&&!residual.includes('[candidate:'+record.id+']'))continue;quarantined=true;continue}
    if(header<0||!/^\n- \d{4}-\d\d-\d\d｜$/.test(residual.slice(header,start))||residual.indexOf(block,start+block.length)>=0){quarantined=true;continue}
    residual=residual.slice(0,header)+residual.slice(start+block.length)
   }
   for(const record of reader.snapshot.records.filter(record=>record.status==='retired'&&record.type===type&&record.block))residual=removeRetiredBlock(residual,record)
   residual=filterWithdrawn(residual,withdrawalPolicy(dir))
   if(residual.replace('# '+type+'\n','').trim())quarantined=true
  }
  reader.assertCurrent()
  let local
  try{local=reviewStore(dir,row,expected)}catch(error){if(!['withdrawal-missing-source-lineage','withdrawal-untracked-detail','withdrawal-effective-line-diverged','withdrawal-shared-effective-memory'].includes(error.message))throw error;quarantined=true;local={revision:storeReview(dataRoot,row.name),mask:{lineHashes:[],memoryIds:[],candidateIds:[],blocks:[],entries:[]}}}
  return{...local,quarantined}
 }
 const verifyCleanup=(dir,row,expected)=>{const view=sourceWithdrawalReviewKey(dir,expected,scope(row));return view.alreadyWithdrawn&&prepareRestoredWithdrawalCleanup(dir,withdrawalPolicy(dir),expected).length===0}
 const readLegacyRoots=(dir,row)=>{const view=candidateSnapshot(dir,scope(row));return[...new Set([...view.revoked,...view.managedWithdrawnSources])]}
 const settleRevokedAdoptions=(dir,row,revoked)=>{
  const snapshot=candidateSnapshot(dir,scope(row)),sources=[...new Set(snapshot.records.filter(record=>record.status==='adopted').flatMap(record=>record.sources.filter(source=>revoked.includes(source))))]
  // The global source barrier is already committed. Before an unrelated writer
  // filters projections, finish these authorized local withdrawals as a unit.
  for(const expected of sources)cleanupStore(dir,row,expected)
 }
 return{source,reviewStore,cleanupStore,readFreshProofs,reviewCandidate,reconcileStore,verifyCleanup,readLegacyRoots,settleRevokedAdoptions}
}
