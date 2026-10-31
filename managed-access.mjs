/** Cross-store ownership for ordinary product APIs; coordinator hooks use local views. */
import {existsSync,lstatSync,readFileSync,readdirSync} from 'node:fs'
import {resolve,join,dirname,basename,relative,isAbsolute,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {readSafely,writeSafely,normalizeText,escapeFraming,entryId} from './security.mjs'
import {controlRootFor,controlStatus,reviewRegistration,registerStores,policyForStore,withManagedRead,withManagedWriter,reviewWithdrawal,beginWithdrawal,resumeWithdrawal,reviewFreshCandidate,confirmFreshCandidate,reviewStoreReconciliation,reconcileRegisteredStore} from './managed-policy.mjs'
import {assertRestorationInactive} from './restoration-lock.mjs'
import {productHooks} from './managed-hooks.mjs'
import {installStoreLockGuard} from './store-lock-guard.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex'),digest=value=>hash(JSON.stringify(value)),fail=code=>{throw Error('managed-memory-'+code)}
const candidates={},memory={},rawDepth=new Map(),frames=new Map()
export function installManagedCandidateInternals(value){Object.assign(candidates,value)}
export function installManagedMemoryInternals(value){Object.assign(memory,value)}
const pinPath=root=>resolve(root)+'.control-binding.json'
function synchronous(value){if(value&&typeof value.then==='function')fail('async-access-forbidden');return value}
function local(root,run){const key=resolve(root);rawDepth.set(key,(rawDepth.get(key)??0)+1);try{return synchronous(run())}finally{const n=rawDepth.get(key)-1;if(n)rawDepth.set(key,n);else rawDepth.delete(key)}}
function internal(root,sourceIdentity){const h=productHooks(root,{...candidates,...memory},sourceIdentity);return Object.fromEntries(Object.entries(h).map(([key,value])=>[key,typeof value==='function'?(...args)=>local(root,()=>value(...args)):value]))}
function readPin(root){
 const file=pinPath(root);if(!existsSync(file))return undefined
 const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096||(stat.mode&0o077)!==0)fail('unsafe-control-pin')
 let pin;try{pin=JSON.parse(readSafely(file,{maxBytes:4096}))}catch{fail('corrupt-control-pin')}
 if(!pin||Object.keys(pin).sort().join('|')!=='installationId|rootId|schema'||pin.schema!==1||pin.rootId!==hash(resolve(root))||typeof pin.installationId!=='string')fail('control-pin-mismatch')
 return pin
}
function locate(dir){
 const path=resolve(dir),root=basename(dirname(path))==='projects'?dirname(dirname(path)):path
 assertRestorationInactive(root)
 if(rawDepth.get(root)||[...rawDepth].some(([key,n])=>n&&(relative(key,path)===''||!isAbsolute(relative(key,path))&&relative(key,path)!=='..'&&!relative(key,path).startsWith('..'+sep))))return{root,path,raw:true}
 if(!existsSync(pinPath(root))&&!existsSync(controlRootFor(root))&&!existsSync(join(root,'.managed-policy.json'))&&!existsSync(join(path,'.managed-policy.json')))return undefined
 const name=path===root?'.':relative(root,path);return{root,path,name,raw:false}
}
export function isManagedStore(dir){const info=locate(dir);return Boolean(info&&!info.raw)}
function stateFor(info){
 assertRestorationInactive(info.root)
 const pin=readPin(info.root),status=controlStatus(info.root)
 if(!status.registered)fail('control-missing')
 if(!pin)fail('control-pin-missing')
 if(pin.installationId!==status.installationId)fail('control-pin-mismatch')
 return status
}
function withFrame(info,policy,run){
 const prior=frames.get(info.path);frames.set(info.path,{policy,root:info.root});try{return synchronous(run())}finally{if(prior)frames.set(info.path,prior);else frames.delete(info.path)}
}
function translate(error){if(error?.errcode===5||error?.errcode===6){const busy=new Error('managed-memory-control-busy');busy.code='memory-lock-busy';throw busy}throw error}
export function managedRead(dir,run){
 const info=locate(dir);if(!info||info.raw)return run()
 if(frames.has(info.path))return synchronous(run())
 try{return withManagedRead(info.root,info.name,policy=>withFrame(info,policy,run),{validateIdentity:()=>stateFor(info),readFreshProofs:internal(info.root).readFreshProofs})}catch(error){return translate(error)}
}
export function managedWrite(dir,run,{sources=[],requireSource=false,maintenance=false}={}){
 const info=locate(dir);if(!info||info.raw)return run()
 if(requireSource&&!sources.length)fail('write-needs-source')
 try{
  stateFor(info)
  return withManagedWriter(info.root,info.name,()=>{
   const policy=policyForStore(info.root,info.name,{metadataOnly:true})
   if(maintenance)return withFrame(info,policy,run)
   if(policy.revoked.length){const row=stateFor(info).stores.find(store=>store.name===info.name);internal(info.root).settleRevokedAdoptions(info.path,row,policy.revoked)}
   return withManagedRead(info.root,info.name,policy=>withFrame(info,policy,()=>{if(sources.some(source=>policy.revoked.includes(source)))fail('write-source-revoked');return run()}),{readFreshProofs:internal(info.root).readFreshProofs})
  },{sources})
 }catch(error){return translate(error)}
}
installStoreLockGuard((dir,run)=>frames.has(resolve(dir))?run():managedWrite(dir,run))
export function rootsFor(sessionId,evidence){
 if(typeof sessionId!=='string'||!Array.isArray(evidence))return[]
 const text=value=>escapeFraming(normalizeText(String(value)).trim())
 return[...new Set(evidence.filter(e=>typeof e?.messageId==='string').map(e=>digest([text(sessionId),text(e.messageId)])))]
}
export function managedPolicy(dir,policy){
 const info=locate(dir);if(!info||info.raw)return policy
 const global=frames.get(info.path)?.policy;if(!global)fail('policy-outside-owned-read')
 const extra={lineHashes:[],memoryIds:[],candidateIds:[],blocks:[]},revoked=new Set(global.revoked)
 if(revoked.size){
  const row=stateFor(info).stores.find(store=>store.name===info.name),snapshot=local(info.root,()=>candidates.candidateSnapshot(info.path,row.scope))
  for(const record of snapshot.records){
   if(!['adopted','recorded','superseded','retired'].includes(record.status)||!record.sources.some(source=>revoked.has(source)))continue
   extra.candidateIds.push(record.id)
   if(record.status==='retired'){extra.lineHashes.push(record.lineHash);extra.memoryIds.push(record.memoryId);if(record.block)extra.blocks.push(record.block);continue}
   const sourced=['tool-context','quoted-extraction'].includes(record.origin)
   let lineHash=sourced?hash(normalizeText(record.indexLine).trim()):record.adoption?.lineHash
   if(!sourced&&!lineHash){
    // Old adoption records lack lineHash. Only the exact reviewed control mask
    // can bind them; an unreviewed restored variant must still fail closed.
    const line=memory.indexLine(record.type,record.summary,undefined,typeof record.detail==='string'&&record.detail.trim().length>0),expected=hash(normalizeText(line).trim())
    if(entryId(line)===record.adoption?.memoryId&&global.candidateIds.includes(record.id)&&global.lineHashes.includes(expected)&&global.memoryIds.includes(record.adoption.memoryId))lineHash=expected
   }
   if(!lineHash)fail('unbound-revoked-adoption')
   extra.lineHashes.push(lineHash);extra.memoryIds.push(sourced?entryId(record.indexLine):record.adoption.memoryId)
   if(record.detail!==undefined){const block=`[candidate:${record.id}]\n${record.detail}`;extra.blocks.push({id:record.id,length:block.length,hash:hash(block)})}
  }
 }
 const merged={...policy,strict:true}
 for(const key of ['lineHashes','memoryIds','candidateIds','revoked'])merged[key]=[...new Set([...(policy[key]??[]),...(global[key]??[]),...(extra[key]??[])])]
 const blocks=new Map()
 for(const block of [...(policy.blocks??[]),...(global.blocks??[]),...extra.blocks]){if(blocks.has(block.id)&&JSON.stringify(blocks.get(block.id))!==JSON.stringify(block))fail('conflicting-source-footprint');blocks.set(block.id,block)}
 merged.blocks=[...blocks.values()]
 return merged
}
export function managedRevision(dir,bodyRevision){const info=locate(dir);if(!info||info.raw)return bodyRevision;const current=frames.get(info.path)?.policy;if(!current)fail('revision-outside-owned-read');return digest([bodyRevision,current.revision])}
export function managedCandidateView(dir,value){
 const policy=frames.get(resolve(dir))?.policy;if(!policy||!value||typeof value!=='object')return value
 const hide=record=>record?.sources?.some(source=>policy.revoked.includes(source))?{id:record.id,status:'withdrawn',sources:record.sources}:record
 if(Array.isArray(value.records))return{...value,records:value.records.map(hide)}
 if(value.candidate)return{...value,candidate:hide(value.candidate)}
 return value
}
export function requireManagedRoots(dir,sources){const info=locate(dir);if(!info||info.raw)return;const policy=frames.get(info.path)?.policy;if(!policy)fail('source-check-outside-ownership');if(!sources?.length)fail('write-needs-source');if(sources.some(root=>policy.revoked.includes(root)))fail('write-source-revoked')}
export function controlRevisionOf(dir){return frames.get(resolve(dir))?.policy.revision}
export function confirmManagedAdoption(dir,id){
 const info=locate(dir);if(!info||info.raw)return
 const h=internal(info.root),policy=frames.get(info.path)?.policy,row=stateFor(info).stores.find(store=>store.name===info.name),proof=local(info.root,()=>h.reviewCandidate(info.path,row,id))
 if(!policy?.lineHashes.includes(proof.lineHash))return
 const plan=reviewFreshCandidate(info.root,info.name,id,h);confirmFreshCandidate(info.root,info.name,id,{...h,reviewed:plan.review})
}
export function managedMemoryStatus(root){const info={root:resolve(root)};assertRestorationInactive(info.root);if(!existsSync(pinPath(root))&&!existsSync(controlRootFor(root)))return{registered:false};return stateFor(info)}
export function initializeManagedMemory(root,stores=[{name:'.',role:'global'}],options={}){
 assertRestorationInactive(root)
 root=resolve(root);const pin=readPin(root),before=controlStatus(root)
 if(pin&&(!before.registered||before.installationId!==pin.installationId))fail('control-missing-or-mismatched')
 const h=internal(root)
 const hooks={...h,importLegacy:options.importLegacy??false}
 const plan=reviewRegistration(root,stores,hooks)
 if(options.apply!==true)return plan
 const result=registerStores(root,stores,{...hooks,apply:true,reviewed:options.reviewed,fault:options.registrationFault})
 writeSafely(pinPath(root),JSON.stringify({schema:1,rootId:hash(root),installationId:result.installationId})+'\n')
 return result
}

/** Reviewed restore owns the external guard and calls this under a local permit. */
export function reconcileRestoredMemory(root,{fault}={}){
 root=resolve(root);stateFor({root});const h=internal(root)
 for(const row of controlStatus(root).stores){
  const review=reviewStoreReconciliation(root,row.name,h)
  if(review.quarantined)fail('restored-store-needs-source-review')
  reconcileRegisteredStore(root,row.name,{...h,apply:true,reviewed:review.review})
 }
 for(const operation of controlStatus(root).operations){resumeWithdrawal(root,operation.id,{...h,fault});fault?.({phase:'restored-operation',id:operation.id})}
 const status=stateFor({root});if(status.stores.some(row=>row.quarantined)||status.operations.some(op=>op.pending))fail('restore-cleanup-incomplete')
 memory.clearCache?.()
 return{stores:status.stores.length,operations:status.operations.length,controlRevision:status.controlRevision}
}
export function managedSourceWithdrawal(dir,source,options={}){
 const info=locate(dir);if(!info||info.raw)fail('source-withdrawal-needs-managed-store');const status=stateFor(info);if([...frames.values()].some(frame=>frame.root===info.root))fail('nested-withdrawal-forbidden');if(!status.stores.some(store=>store.name===info.name))fail('store-not-registered')
 if(options.apply!==undefined&&typeof options.apply!=='boolean')fail('invalid-apply')
 const h=internal(info.root,options.sourceIdentity)
 if(options.operationId){const operation=status.operations.find(op=>op.id===options.operationId);if(!operation||operation.source!==source)fail('operation-source-mismatch');if(options.apply!==true)return{applied:false,...operation};return resumeWithdrawal(info.root,options.operationId,h)}
 const plan=reviewWithdrawal(info.root,source,h)
 if(options.apply!==true)return{...plan,scope:'all-managed-stores',controlReview:plan.review}
 if(options.controlReview!==plan.review)fail('stale-global-withdrawal-review')
 const started=beginWithdrawal(info.root,source,{...h,reviewed:options.controlReview,fault:options.controlFault})
 if(options.cleanup===false)return started
 return resumeWithdrawal(info.root,started.id,{...h,fault:options.cleanupFault})
}

export function managedReadMany(dirs,run){const unique=[...new Set(dirs.map(dir=>resolve(dir)))].sort();const next=index=>index===unique.length?run():managedRead(unique[index],()=>next(index+1));return next(0)}

/** Migration owns the global transaction before source/claim locks and destination copy. */
export function managedProjectOperation(root,run,{write=false}={}){
 const info=locate(root);if(!info||info.raw)return run()
 // Path/claim metadata lookup owns the coordinator but does not read global
 // memory bodies. A global publication must not block an independent known project.
 if(!write)return withManagedWriter(info.root,'.',()=>local(info.root,run),{validateIdentity:()=>stateFor(info)})
 return withManagedWriter(info.root,'.',()=>local(info.root,run),{validateIdentity:()=>stateFor(info)})
}
export function registerManagedDestination(root,dir){
 root=resolve(root);if(!rawDepth.get(root))return false
 const status=controlStatus(root),name=relative(root,resolve(dir));if(!status.registered)fail('control-missing')
 if(status.stores.some(row=>row.name===name))return true
 const stores=status.stores.map(({name,role,scope})=>({name,role,scope})).concat([{name,role:'project',scope:'project'}]),h=internal(root),plan=reviewRegistration(root,stores,h)
 registerStores(root,stores,{...h,apply:true,reviewed:plan.review});return true
}
/** A first-use project may join only while its canonical target is still empty. */
export function ensureManagedProject(root,dir){
 root=resolve(root);dir=resolve(dir);const info=locate(root);if(!info||info.raw)return dir
 const status=stateFor(info),name=relative(root,dir);if(status.stores.some(row=>row.name===name))return dir
 if(!/^projects\/v2-[a-f0-9]{64}$/.test(name))fail('project-needs-review')
 return managedProjectOperation(root,()=>{
  let stat;try{stat=lstatSync(dir)}catch(error){if(error.code!=='ENOENT')throw error}
  if(stat&&(!stat.isDirectory()||stat.isSymbolicLink()||readdirSync(dir).length))fail('project-needs-review')
  registerManagedDestination(root,dir);return dir
 },{write:true})
}
