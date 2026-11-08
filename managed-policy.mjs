/** Transactional cross-library metadata, separate from the restorable data tree.
 * A transactional metadata control ledger outside the restorable data tree.
 * Callers supply revision-bound local review/cleanup functions; no models run here.
 */
import {DatabaseSync} from 'node:sqlite'
import {createHash,randomUUID} from 'node:crypto'
import {join,resolve,relative,dirname} from 'node:path'
import {lstatSync,readdirSync,readFileSync,openSync,fstatSync,closeSync,constants,existsSync,chmodSync} from 'node:fs'
import {writeSafely,ensureStoreDir} from './security.mjs'
const FILE='state.sqlite',BINDING='.managed-policy.json',MAX_STORES=128,MAX_OPS=1000,MAX_BYTES=2*1048576
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const id=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const hash=value=>createHash('sha256').update(value).digest('hex')
const digest=value=>hash(JSON.stringify(value)),fail=code=>{throw Error('managed-policy-'+code)}
const stable=value=>JSON.stringify(value)
export const controlRootFor=dataRoot=>resolve(dataRoot)+'.control'
export const sourceKey=(session,message)=>digest([session,message])
function locations(dataRoot){const data=resolve(dataRoot),control=controlRootFor(data);return{data,control,rootId:hash(data)}}
function relName(name){if(name==='.')return name;if(typeof name!=='string'||!/^projects\/[^/\\\u0000-\u001f]{1,255}$/.test(name)||name.startsWith('projects/.')||Buffer.byteLength(name.slice(9))>255)fail('invalid-store');return name}
function storePath(data,name){relName(name);const path=name==='.'?data:join(data,name);if(name!=='.'&&relative(data,path)!==name)fail('store-escape');return path}
function absent(path){try{lstatSync(path);return false}catch(error){if(error.code==='ENOENT')return true;throw error}}
function safeDirectory(path){const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())fail('unsafe-directory')}
function ancestors(path){for(let current=resolve(path);;current=dirname(current)){if(!absent(current))safeDirectory(current);const parent=dirname(current);if(parent===current)break}}
function safeFile(path,maxBytes=MAX_BYTES){
 let before;try{before=lstatSync(path)}catch(error){if(error.code==='ENOENT')return undefined;throw error}
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maxBytes)fail('unsafe-file')
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes||stat.ino!==before.ino||stat.dev!==before.dev)fail('changed-file');const bytes=readFileSync(fd),after=fstatSync(fd),now=lstatSync(path);if(bytes.length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||now.ino!==stat.ino||now.dev!==stat.dev||now.isSymbolicLink())fail('changed-file');return bytes.toString('utf8')}finally{closeSync(fd)}
}
function validateMask(mask){
 if(!mask||Object.keys(mask).sort().join('|')!=='blocks|candidateIds|entries|lineHashes|memoryIds'||!['lineHashes','candidateIds'].every(key=>Array.isArray(mask[key])&&mask[key].length<=4000&&mask[key].every(hex))||!Array.isArray(mask.memoryIds)||mask.memoryIds.length>4000||!mask.memoryIds.every(value=>typeof value==='string'&&/^[a-f0-9]{8}$/.test(value))||!Array.isArray(mask.blocks)||mask.blocks.length>4000||!mask.blocks.every(row=>row&&Object.keys(row).sort().join('|')==='hash|id|length'&&hex(row.id)&&hex(row.hash)&&Number.isSafeInteger(row.length)&&row.length>0&&row.length<6000))fail('invalid-mask')
 if(!Array.isArray(mask.entries)||mask.entries.length>4000||!mask.entries.every(row=>row&&Object.keys(row).sort().join('|')==='lineHash|memoryId'&&hex(row.lineHash)&&/^[a-f0-9]{8}$/.test(row.memoryId)&&mask.lineHashes.includes(row.lineHash)&&mask.memoryIds.includes(row.memoryId)))fail('invalid-entry-binding')
 return mask
}
const emptyMask=()=>({lineHashes:[],memoryIds:[],candidateIds:[],blocks:[],entries:[]})
function parse(raw,rootId){
 let state;try{state=JSON.parse(raw)}catch{fail('corrupt-json')}
 if(!state||Object.keys(state).sort().join('|')!=='confirmations|installationId|operations|revision|rootId|schema|stores'||state.schema!==3||state.rootId!==rootId||!id(state.installationId)||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.stores)||state.stores.length>MAX_STORES||!Array.isArray(state.operations)||state.operations.length>MAX_OPS)fail('corrupt-state')
 const stores=new Set(),sources=new Set()
 for(const row of state.stores){if(!row||Object.keys(row).sort().join('|')!=='name|quarantined|role|scope'||!['global','project','legacy-copy'].includes(row.role)||!['global','project'].includes(row.scope)||typeof row.quarantined!=='boolean'||row.role==='global'&&row.scope!=='global'||row.role==='project'&&row.scope!=='project'||(row.name==='.')!==(row.role==='global')||stores.has(relName(row.name)))fail('corrupt-store');stores.add(row.name)}
 for(const op of state.operations){
  if(!op||Object.keys(op).sort().join('|')!=='id|source|stores'||!id(op.id)||!hex(op.source)||sources.has(op.source)||!Array.isArray(op.stores)||op.stores.length>MAX_STORES)fail('corrupt-operation')
  sources.add(op.source);const seen=new Set()
  for(const row of op.stores){if(!row||Object.keys(row).sort().join('|')!=='mask|name|review|status'||!stores.has(row.name)||seen.has(row.name)||!hex(row.review)||!['pending','cleaned'].includes(row.status))fail('corrupt-cleanup');seen.add(row.name);validateMask(row.mask)}
  if(seen.size!==stores.size)fail('operation-coverage-mismatch')
 }
 if(!Array.isArray(state.confirmations)||state.confirmations.length>MAX_OPS)fail('corrupt-confirmations')
 for(const row of state.confirmations){if(!row||Object.keys(row).sort().join('|')!=='acceptedAfterOperation|name|proof'||!stores.has(row.name)||!state.operations.some(op=>op.id===row.acceptedAfterOperation))fail('corrupt-confirmation');validateProof(row.proof)}
 return state
}
import {CONTROL_APPLICATION_ID as APPLICATION_ID,CONTROL_SCHEMA_SQL as SCHEMA,assertControlSchema as schema,readControlStateRows} from './control-schema.mjs'
const held=new Map()
function inspectDbFiles(control,{required=false}={}){
 ancestors(control)
 for(const [name,max] of [[FILE,8*1048576],[FILE+'-wal',16*1048576],[FILE+'-shm',1024*1024]]){
  const path=join(control,name);if(absent(path)){if(required&&name===FILE)fail('control-missing');continue}
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>max||(stat.mode&0o077)!==0)fail('unsafe-database-file')
 }
 if(!absent(join(control,'state.json')))fail('legacy-control-needs-reviewed-migration')
}
function openDb(paths,{write=false,requireExisting=false}={}){
 inspectDbFiles(paths.control)
 const path=join(paths.control,FILE);let created=false
 if(absent(path)){
  if(requireExisting)fail('control-missing')
  if(!write)return undefined
  ensureStoreDir(paths.control);const fd=openSync(path,'wx',0o600);closeSync(fd);created=true
 }
 const before=lstatSync(path);let db
 try{
  // Managed reads share the writer lock. Let brief contention clear without
  // releasing transaction ownership or waiting indefinitely.
  db=new DatabaseSync(path,{readOnly:!write});db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=750;')
  const now=lstatSync(path);if(now.isSymbolicLink()||now.ino!==before.ino||now.dev!==before.dev)fail('changed-database-file')
  if(created){db.exec('BEGIN IMMEDIATE; '+SCHEMA+'; PRAGMA application_id='+APPLICATION_ID+'; PRAGMA user_version=1; COMMIT;')}
  schema(db)
  if(write){db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=2048; PRAGMA journal_size_limit=8388608; PRAGMA wal_autocheckpoint=256;')}
  inspectDbFiles(paths.control,{required:true});return db
 }catch(error){db?.close();throw error}
}
function load(dataRoot){
 const paths=locations(dataRoot),own=held.get(paths.control);let db=own?.db,close=false
 if(!db){db=openDb(paths);close=!!db}
 let raw
 try{if(db){schema(db);const rows=readControlStateRows(db);if(rows.length>1||rows.some(row=>row.singleton!==1||typeof row.payload!=='string'||Buffer.byteLength(row.payload)>MAX_BYTES))fail('corrupt-database-state');raw=rows[0]?.payload}}
 finally{if(close)db.close()}
 return{...paths,raw,revision:hash(raw??'null'),state:raw===undefined?undefined:parse(raw,paths.rootId)}
}
function save(view,state){
 const own=held.get(view.control);if(!own)fail('transaction-required')
 parse(stable(state),view.rootId);const bytes=stable(state)+'\n';if(Buffer.byteLength(bytes)>MAX_BYTES)fail('capacity')
 own.db.prepare('INSERT INTO control_state(singleton,payload) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload').run(bytes)
}
function controlLock(dataRoot,fn,{requireExisting=false}={}){
 const paths=locations(dataRoot)
 if(held.has(paths.control))return fn()
 const db=openDb(paths,{write:true,requireExisting});let began=false
 try{db.exec('BEGIN IMMEDIATE');began=true;held.set(paths.control,{db});const result=fn();if(result&&typeof result.then==='function')fail('async-transaction-hook');db.exec('COMMIT');began=false;return result}
 catch(error){if(began)try{db.exec('ROLLBACK')}catch{};throw error}
 finally{held.delete(paths.control);db.close()}
}
function binding(data,name,installationId,rootId){
 const path=storePath(data,name);ancestors(path);const raw=safeFile(join(path,BINDING),4096)
 if(raw===undefined)return
 let value;try{value=JSON.parse(raw)}catch{fail('corrupt-binding')}
 if(Object.keys(value).sort().join('|')!=='installationId|rootId|schema'||value.schema!==1||value.installationId!==installationId||value.rootId!==rootId)fail('binding-mismatch')
}
/** Bounded review of one store, excluding child project stores and volatile runtime metadata. */
export function storeReview(dataRoot,name){
 const{data}=locations(dataRoot),path=storePath(data,name);ancestors(path)
 const rows=[];let bytes=0
 if(absent(path))return digest(rows)
 for(const entry of readdirSync(path).sort()){
  if(entry==='projects'&&name==='.')continue
  if(['.write.lock','.loaded.json','.diag.json','.capture-state.json','.capture-jobs.json','.capture-inputs.json',BINDING].includes(entry))continue
  const raw=safeFile(join(path,entry),2*1048576);if(raw===undefined)fail('changed-file');bytes+=Buffer.byteLength(raw);rows.push({name:entry,hash:hash(raw)})
  if(rows.length>512||bytes>32*1048576)fail('store-capacity')
 }
 return digest(rows)
}
/** Registration is explicit and revision-bound. Reads do not mkdir or write. */
function mergeMasks(...masks){
 const out=emptyMask()
 for(const key of ['lineHashes','memoryIds','candidateIds'])out[key]=[...new Set(masks.flatMap(mask=>mask[key]))]
 for(const key of ['blocks','entries']){
  const rows=new Map()
  for(const item of masks.flatMap(mask=>mask[key])){const identity=key==='blocks'?item.id:item.lineHash+'|'+item.memoryId;if(rows.has(identity)&&stable(rows.get(identity))!==stable(item))fail('conflicting-mask');rows.set(identity,item)}
  out[key]=[...rows.values()]
 }
 return validateMask(out)
}
function reconciliation(view,row,reconcileStore){
 if(typeof reconcileStore!=='function')fail('new-store-needs-source-reconciliation')
 return view.state.operations.map(op=>{
  const local=reconcileStore(storePath(view.data,row.name),row,op.source)
  if(!local||Object.keys(local).sort().join('|')!=='mask|quarantined|revision'||!hex(local.revision)||typeof local.quarantined!=='boolean')fail('invalid-reconciliation-hook')
  validateMask(local.mask)
  return{operationId:op.id,source:op.source,review:local.revision,mask:mergeMasks(...op.stores.map(store=>store.mask),local.mask),quarantined:local.quarantined}
 })
}
export function reviewRegistration(dataRoot,stores,{reconcileStore,readLegacyRoots,reviewStore,importLegacy=false}={}){
 if(typeof importLegacy!=='boolean')fail('invalid-legacy-import')
 if(!Array.isArray(stores)||!stores.length||stores.length>MAX_STORES)fail('invalid-stores')
 const view=load(dataRoot),seen=new Set(),rows=stores.map(row=>{
  const scope=row?.scope??(row?.role==='global'?'global':'project')
  if(!row||!['name|role','name|role|scope'].includes(Object.keys(row).sort().join('|'))||!['global','project','legacy-copy'].includes(row.role)||!['global','project'].includes(scope)||row.role==='global'&&scope!=='global'||row.role==='project'&&scope!=='project'||(row.name==='.')!==(row.role==='global')||seen.has(relName(row.name)))fail('invalid-stores')
  seen.add(row.name);if(view.state)binding(view.data,row.name,view.state.installationId,view.rootId);else if(!absent(join(storePath(view.data,row.name),BINDING)))fail('control-missing')
  const known=view.state?.stores.find(store=>store.name===row.name)
  const reconciliations=view.state?.operations.length&&!known?reconciliation(view,{...row,scope},reconcileStore):[]
  return{name:row.name,role:row.role,scope,quarantined:known?.quarantined??reconciliations.some(item=>item.quarantined),review:storeReview(dataRoot,row.name),reconciliations}
 })
 if(!seen.has('.'))fail('global-required')
 if(view.state?.stores.some(known=>!rows.some(row=>row.name===known.name&&row.role===known.role&&row.scope===known.scope)))fail('cannot-remove-store')
 const roots=new Set()
 if(readLegacyRoots!==undefined){
  if(typeof readLegacyRoots!=='function')fail('invalid-legacy-root-hook')
  for(const row of rows){const values=readLegacyRoots(storePath(view.data,row.name),row);if(!Array.isArray(values)||values.length>MAX_OPS||!values.every(hex))fail('invalid-legacy-roots');for(const source of values)if(!view.state?.operations.some(op=>op.source===source))roots.add(source)}
 }
 if(roots.size&&!importLegacy)fail('legacy-source-import-required')
 if(roots.size+(view.state?.operations.length??0)>MAX_OPS)fail('capacity')
 const legacyImports=[...roots].sort().map(source=>({source,stores:rows.map(row=>{
  if(typeof reviewStore!=='function')fail('legacy-import-review-required')
  const current=reviewStore(storePath(view.data,row.name),row,source)
  if(!current||Object.keys(current).sort().join('|')!=='mask|revision'||!hex(current.revision))fail('invalid-review-hook')
  return{name:row.name,review:current.revision,mask:validateMask(current.mask),status:'pending'}
 })}))
 const reviewed={controlRevision:view.revision,stores:rows,importLegacy,legacyImports}
 return{applied:false,...reviewed,review:digest(reviewed)}
}
function repairBindings(dataRoot){
 const view=load(dataRoot)
 for(const row of view.state.stores){const path=storePath(view.data,row.name);ensureStoreDir(path);writeSafely(join(path,BINDING),stable({schema:1,rootId:view.rootId,installationId:view.state.installationId})+'\n')}
}
export function registerStores(dataRoot,stores,{apply=false,reviewed,reconcileStore,readLegacyRoots,reviewStore,importLegacy=false,fault}={}){
 if(typeof apply!=='boolean')fail('invalid-apply')
 const hooks={reconcileStore,readLegacyRoots,reviewStore,importLegacy}
 const preflight=reviewRegistration(dataRoot,stores,hooks)
 if(!apply)return preflight
 if(!hex(reviewed)||preflight.review!==reviewed)fail('stale-registration')
 const result=controlLock(dataRoot,()=>{
  const plan=reviewRegistration(dataRoot,stores,hooks);if(!hex(reviewed)||plan.review!==reviewed)fail('stale-registration')
  const view=load(dataRoot),state=view.state??{schema:3,rootId:view.rootId,installationId:randomUUID(),revision:0,stores:[],operations:[],confirmations:[]}
  const added=plan.stores.filter(row=>!state.stores.some(known=>known.name===row.name))
  for(const row of added)for(const reviewed of row.reconciliations){const op=state.operations.find(op=>op.id===reviewed.operationId);op.stores.push({name:row.name,mask:reviewed.mask,review:reviewed.review,status:'pending'})}
  for(const imported of plan.legacyImports)state.operations.push({id:randomUUID(),source:imported.source,stores:imported.stores})
  state.stores=plan.stores.map(({name,role,scope,quarantined})=>({name,role,scope,quarantined}));state.revision++;save(view,state)
  return{applied:true,stores:state.stores.length,quarantined:state.stores.filter(row=>row.quarantined).map(row=>row.name),installationId:state.installationId,controlRevision:load(dataRoot).revision,legacySourcesImported:plan.legacyImports.length}
 })
 fault?.({phase:'registration-committed'});repairBindings(dataRoot);return result
}
export function reviewStoreReconciliation(dataRoot,name,{reconcileStore}={}){
 const view=load(dataRoot),row=view.state?.stores.find(row=>row.name===name);if(!row)fail('store-not-registered');binding(view.data,name,view.state.installationId,view.rootId)
 const rows=reconciliation(view,row,reconcileStore),quarantined=rows.some(row=>row.quarantined)
 return{applied:false,quarantined,rows,review:digest({controlRevision:view.revision,name,storeReview:storeReview(dataRoot,name),rows})}
}
export function reconcileRegisteredStore(dataRoot,name,{reconcileStore,apply=false,reviewed}={}){
 if(typeof apply!=='boolean')fail('invalid-apply')
 if(!apply)return reviewStoreReconciliation(dataRoot,name,{reconcileStore})
 return controlLock(dataRoot,()=>{
  const plan=reviewStoreReconciliation(dataRoot,name,{reconcileStore});if(!hex(reviewed)||plan.review!==reviewed)fail('stale-reconciliation')
  if(plan.quarantined)fail('store-pending-source-review')
  const view=load(dataRoot);view.state.stores.find(row=>row.name===name).quarantined=false
  for(const row of plan.rows){const op=view.state.operations.find(op=>op.id===row.operationId),local=op.stores.find(store=>store.name===name);local.mask=mergeMasks(local.mask,row.mask);local.review=row.review;local.status='pending'}
  view.state.revision++;save(view,view.state);return{applied:true,quarantined:false,name}
 })
}
export function controlStatus(dataRoot){const view=load(dataRoot);if(!view.state)return{registered:false,controlRevision:view.revision,stores:[],operations:[]};return{registered:true,controlRevision:view.revision,installationId:view.state.installationId,stores:view.state.stores.map(row=>({...row})),operations:view.state.operations.map(op=>({id:op.id,source:op.source,pending:op.stores.filter(row=>row.status==='pending').length,cleaned:op.stores.filter(row=>row.status==='cleaned').length}))}}
/** Every read checks the independent ledger and binding, even when bodies were restored. */
function validateProof(proof){
 if(!proof||Object.keys(proof).sort().join('|')!=='block|candidateId|lineHash|memoryId|sources'||!hex(proof.candidateId)||!hex(proof.lineHash)||typeof proof.memoryId!=='string'||!/^[a-f0-9]{8}$/.test(proof.memoryId)||!Array.isArray(proof.sources)||!proof.sources.length||proof.sources.length>3||!proof.sources.every(hex)||new Set(proof.sources).size!==proof.sources.length)fail('invalid-fresh-proof')
 if(proof.block!==null&&(!proof.block||Object.keys(proof.block).sort().join('|')!=='hash|id|length'||proof.block.id!==proof.candidateId||!hex(proof.block.hash)||!Number.isSafeInteger(proof.block.length)||proof.block.length<1||proof.block.length>=6000))fail('invalid-fresh-block')
 return proof
}
export function policyForStore(dataRoot,name,{readFreshProofs,metadataOnly=false}={}){
 const view=load(dataRoot),path=storePath(view.data,name)
 if(!view.state){if(!absent(join(path,BINDING)))fail('control-missing');return{registered:false,...emptyMask(),revoked:[]}}
 const store=view.state.stores.find(row=>row.name===name);if(!store)fail('store-not-registered')
 binding(view.data,name,view.state.installationId,view.rootId)
 if(view.state.operations.length&&typeof readFreshProofs!=='function'&&!metadataOnly)fail('fresh-evidence-hook-required')
 const rows=view.state.operations.flatMap(op=>op.stores.filter(row=>row.name===name)),unique=key=>[...new Set(rows.flatMap(row=>row.mask[key]))],blocks=new Map(rows.flatMap(row=>row.mask.blocks).map(row=>[row.id,row])),revoked=view.state.operations.map(op=>op.source)
 let fresh=[],proofs=[]
 if(readFreshProofs!==undefined){if(typeof readFreshProofs!=='function')fail('invalid-fresh-hook');const wanted=[...new Set(view.state.confirmations.filter(row=>row.name===name).map(row=>row.proof.candidateId))];proofs=readFreshProofs(path,store,wanted,unique('lineHashes'),revoked);if(!Array.isArray(proofs)||proofs.length>200)fail('invalid-fresh-hook');proofs.forEach(validateProof);fresh=view.state.confirmations.filter(row=>row.name===name&&!row.proof.sources.some(source=>revoked.includes(source))&&proofs.some(proof=>stable(proof)===stable(row.proof))).map(row=>row.proof)}
 const pending=proofs.filter(proof=>!fresh.some(accepted=>stable(accepted)===stable(proof)));for(const proof of pending)if(proof.block)blocks.set(proof.block.id,proof.block)
 const cleared=new Set(fresh.map(proof=>proof.lineHash)),memoryIds=unique('memoryIds').filter(memoryId=>!fresh.some(proof=>proof.memoryId===memoryId&&rows.filter(row=>row.mask.memoryIds.includes(memoryId)).every(row=>row.mask.lineHashes.every(lineHash=>row.mask.entries.some(entry=>entry.lineHash===lineHash))&&row.mask.entries.filter(entry=>entry.memoryId===memoryId).every(entry=>cleared.has(entry.lineHash)))))
 if(load(dataRoot).revision!==view.revision)fail('stale-policy-during-read')
 return{registered:true,quarantined:store.quarantined,contentSafe:!metadataOnly&&!store.quarantined,revision:view.revision,lineHashes:unique('lineHashes').filter(lineHash=>!cleared.has(lineHash)),memoryIds,candidateIds:[...new Set([...unique('candidateIds'),...pending.map(proof=>proof.candidateId)])],blocks:[...blocks.values()],revoked,freshConfirmedCandidateIds:fresh.map(proof=>proof.candidateId)}
}
export function reviewFreshCandidate(dataRoot,name,candidateId,{reviewCandidate}={}){
 if(!hex(candidateId)||typeof reviewCandidate!=='function')fail('invalid-fresh-review')
 const view=load(dataRoot);if(!view.state||!view.state.operations.length)fail('no-barrier-to-reaffirm');const row=view.state.stores.find(row=>row.name===name);if(!row)fail('store-not-registered');binding(view.data,name,view.state.installationId,view.rootId)
 const proof=validateProof(reviewCandidate(storePath(view.data,name),row,candidateId))
 if(proof.candidateId!==candidateId||proof.sources.some(source=>view.state.operations.some(op=>op.source===source)))fail('fresh-source-revoked')
 if(!view.state.operations.some(op=>op.stores.some(store=>store.name===name&&store.mask.lineHashes.includes(proof.lineHash))))fail('not-withdrawn-content')
 return{applied:false,proof,review:digest({revision:view.revision,name,proof,storeReview:storeReview(dataRoot,name)})}
}
export function confirmFreshCandidate(dataRoot,name,candidateId,{reviewCandidate,reviewed}={}){
 return controlLock(dataRoot,()=>{
  const plan=reviewFreshCandidate(dataRoot,name,candidateId,{reviewCandidate});if(!hex(reviewed)||plan.review!==reviewed)fail('stale-fresh-review')
  const view=load(dataRoot),state=view.state
  if(state.confirmations.some(row=>row.name===name&&stable(row.proof)===stable(plan.proof)))return{applied:false,duplicate:true,candidateId}
  if(state.confirmations.length>=MAX_OPS)fail('capacity')
  state.confirmations.push({name,proof:plan.proof,acceptedAfterOperation:state.operations.at(-1).id});state.revision++;save(view,state)
  return{applied:true,candidateId,revokedRootsUnchanged:true}
 })
}
/** Hooks must be synchronous and store-scoped; review returns only hashes/masks. */
function plans(dataRoot,source,reviewStore){
 if(!hex(source)||typeof reviewStore!=='function')fail('invalid-source-or-hook')
 const view=load(dataRoot);if(!view.state)fail('not-registered')
 if(view.state.operations.some(op=>op.source===source))fail('already-started-use-resume')
 const stores=view.state.stores.map(row=>{if(row.quarantined)return{name:row.name,review:storeReview(dataRoot,row.name),mask:emptyMask(),status:'pending'};binding(view.data,row.name,view.state.installationId,view.rootId);const current=reviewStore(storePath(view.data,row.name),row,source);if(!current||Object.keys(current).sort().join('|')!=='mask|revision'||!hex(current.revision))fail('invalid-review-hook');validateMask(current.mask);return{name:row.name,review:current.revision,mask:current.mask,status:'pending'}})
 return{view,stores,review:digest({controlRevision:view.revision,source,stores})}
}
export function reviewWithdrawal(dataRoot,source,{reviewStore}={}){const value=plans(dataRoot,source,reviewStore);return{applied:false,review:value.review,stores:value.stores.map(row=>({name:row.name,review:row.review,affected:row.mask.lineHashes.length})),controlRevision:value.view.revision}}
/** First publish one source barrier atomically. Cleanup is resumable, never auto-rollback. */
export function beginWithdrawal(dataRoot,source,{reviewStore,reviewed,fault}={}){
 const result=controlLock(dataRoot,()=>{
  const value=plans(dataRoot,source,reviewStore);if(!hex(reviewed)||reviewed!==value.review)fail('stale-withdrawal')
  const state=value.view.state;if(state.operations.length>=MAX_OPS)fail('capacity');const op={id:randomUUID(),source,stores:value.stores};state.operations.push(op);state.revision++;save(value.view,state)
  return{applied:true,id:op.id,pending:op.stores.length,barrierPublished:true,cleanupComplete:false}
 })
 fault?.({phase:'barrier',id:result.id});return result
}
export function resumeWithdrawal(dataRoot,operationId,{cleanupStore,verifyCleanup,reviewStore,fault}={}){
 if(!id(operationId)||typeof cleanupStore!=='function')fail('invalid-operation-or-hook')
 const initial=load(dataRoot);if(!initial.state)fail('not-registered');const operation=initial.state.operations.find(row=>row.id===operationId);if(!operation)fail('unknown-operation')
 for(let index=0;index<operation.stores.length;index++){
  const changed=controlLock(dataRoot,()=>{
   const view=load(dataRoot),op=view.state.operations.find(row=>row.id===operationId),row=op.stores[index];if(row.status==='cleaned'){if(typeof verifyCleanup!=='function'||verifyCleanup(storePath(view.data,row.name),view.state.stores.find(store=>store.name===row.name),op.source))return false;if(typeof reviewStore!=='function')fail('restored-cleanup-review-required');const current=reviewStore(storePath(view.data,row.name),view.state.stores.find(store=>store.name===row.name),op.source);row.review=current.revision;row.mask=mergeMasks(row.mask,current.mask);row.status='pending'}if(view.state.stores.find(store=>store.name===row.name).quarantined)fail('store-pending-source-review')
   binding(view.data,row.name,view.state.installationId,view.rootId)
   const result=cleanupStore(storePath(view.data,row.name),view.state.stores.find(store=>store.name===row.name),op.source,row.review)
   if(!result||result.complete!==true)fail('cleanup-incomplete')
   if(result.reviewed!==undefined){if(!hex(result.reviewed))fail('invalid-cleanup-review');row.review=result.reviewed}
   if(result.mask!==undefined)row.mask=mergeMasks(row.mask,validateMask(result.mask))
   fault?.({phase:'local-cleanup',index,id:op.id})
   row.status='cleaned';view.state.revision++;save(view,view.state);return true
  })
  if(changed)fault?.({phase:'checkpoint',index,id:operationId})
 }
 return{applied:true,id:operationId,barrierPublished:true,cleanupComplete:true,pending:0}
}
export function withManagedWriter(dataRoot,name,run,{sources=[],validateIdentity}={}){
 if(typeof run!=='function')fail('invalid-writer')
 if(!Array.isArray(sources)||sources.length>64||!sources.every(hex))fail('invalid-write-sources')
 if(validateIdentity!==undefined&&typeof validateIdentity!=='function')fail('invalid-identity-hook')
 return controlLock(dataRoot,()=>{const checked=validateIdentity?.();if(checked&&typeof checked.then==='function')fail('async-transaction-hook');const policy=policyForStore(dataRoot,name,{metadataOnly:true});if(policy.quarantined)fail('store-pending-source-review');if(sources.some(source=>policy.revoked.includes(source)))fail('write-source-revoked');return run()},{requireExisting:validateIdentity!==undefined})
}

/** Hold the same transaction ownership over policy and Markdown reads. */
export function withManagedRead(dataRoot,name,read,options={}){
 if(typeof read!=='function')fail('invalid-reader')
 if(options.metadataOnly===true)fail('metadata-not-content-policy')
 if(options.validateIdentity!==undefined&&typeof options.validateIdentity!=='function')fail('invalid-identity-hook')
 return controlLock(dataRoot,()=>{
  const checked=options.validateIdentity?.();if(checked&&typeof checked.then==='function')fail('async-transaction-hook')
  const policy=policyForStore(dataRoot,name,options);if(!policy.registered)fail('not-registered');if(policy.quarantined)fail('store-pending-source-review');return read(policy)
 },{requireExisting:true})
}
