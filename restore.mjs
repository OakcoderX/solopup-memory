/** Same-root data restoration. Never rewinds independent control or invokes a model. */
import {readFileSync,writeFileSync,mkdirSync,renameSync,unlinkSync,openSync,closeSync,fsyncSync} from 'node:fs'
import {resolve,join,dirname,basename} from 'node:path'
import {randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import './index.mjs'
import {snapshotIO as io,verifyMemorySnapshot,SNAPSHOT_LIMITS} from './snapshots.mjs'
import {managedMemoryStatus,managedRead,reconcileRestoredMemory} from './managed-access.mjs'
import {controlStatus} from './managed-policy.mjs'
import {listCaptureJobs} from './capture-jobs.mjs'
import {listCaptureInputs} from './capture-inputs.mjs'
import {candidateSnapshot} from './candidates.mjs'
import {episodeSnapshot} from './episodes.mjs'
import {recoverMemoryPublication} from './index.mjs'
import {writeSafely} from './security.mjs'
import {restorationJournalPath,restorationPending,withRestorationPermit,assertRestorationInactive} from './restoration-lock.mjs'
import {VERSION} from './version.mjs'
const fail=code=>{throw Error('memory-restore-'+code)},hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x)
const phases=['prepared','old-moved','new-live','cleaning','complete'],special=['.capture-jobs.json','.capture-inputs.json','.capture-state.json','.loaded.json','.managed-policy.json','.project-identity.json']
const dataTree=(root,offline=false)=>io.inventory(root,{dataOnly:true,offline,allowRestore:true}),fingerprint=root=>io.digest(dataTree(root)),readJson=p=>{try{return JSON.parse(io.bytes(p,8*1024*1024))}catch{fail('invalid-json')}}
const fileFor=(root,path)=>join(root,path),storeDir=(root,name)=>name==='.'?root:join(root,name)
function worker(root,run){
 const p=root+'.restore-worker.lock';io.ancestors(dirname(p));const old=io.stat(p)
 if(old){const raw=io.bytes(p,4096),owner=JSON.parse(raw);if(!Number.isSafeInteger(owner.pid)||owner.pid<1||!uuid(owner.token))fail('invalid-worker');try{process.kill(owner.pid,0);fail('worker-busy')}catch(e){if(e.code!=='ESRCH')throw e}if(io.hash(io.bytes(p,4096))!==io.hash(raw))fail('worker-changed');unlinkSync(p)}
 const token=randomUUID();writeFileSync(p,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600})
 try{return run()}finally{try{if(readJson(p).token===token)unlinkSync(p)}catch{}}
}
function assertSchemas(declared,required){
 // Legacy protocol-1 packages predate field lineage. Never infer support from a version label.
 const capabilities=declared??{candidates:[1,2,3],episodes:[1]}
 if(!capabilities||Object.keys(capabilities).sort().join('|')!=='candidates|episodes'||!['candidates','episodes'].every(name=>Array.isArray(capabilities[name])&&capabilities[name].length>0&&capabilities[name].length<=16&&capabilities[name].every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(capabilities[name]).size===capabilities[name].length))fail('invalid-target-data-schemas')
 for(const {kind,schema}of required)if(!capabilities[kind].includes(schema))fail('target-data-schema-unsupported')
}
function snapshotSchemas(snapshot,manifest){
 const required=[]
 for(const row of manifest.tree.files.filter(row=>row.area==='data'&&['.candidates.json','.episodes.json'].includes(basename(row.path)))){
  const value=readJson(join(snapshot,'data',row.path)),kind=basename(row.path)==='.candidates.json'?'candidates':'episodes'
  if(!Number.isSafeInteger(value?.schema)||value.schema<1)fail('invalid-snapshot-data-schema')
  required.push({kind,schema:value.schema})
 }
 return required
}
function targetInfo(archive,required=[]){
 if(archive===undefined){assertSchemas({candidates:[1,2,3,4],episodes:[1,2]},required);return{protocol:1,version:VERSION,archive:null,sha256:null,codeChanged:false}}
 archive=resolve(archive);io.ancestors(dirname(archive));const body=io.bytes(archive,64*1024*1024),sha256=io.hash(body)
 const r=spawnSync('tar',['-xOf',archive,'package/package.json'],{encoding:'utf8',maxBuffer:65536,timeout:10000});let p;try{p=JSON.parse(r.stdout)}catch{fail('invalid-target-archive')}
 if(r.status!==0||!['dsh-memory','solopup-memory'].includes(p.name)||typeof p.version!=='string'||p.dshMemoryRestoreProtocol!==1)fail('incompatible-target-archive')
 assertSchemas(p.dshMemoryDataSchemas,required)
 if(io.hash(io.bytes(archive,64*1024*1024))!==sha256)fail('target-archive-changed')
 return{protocol:1,version:p.version,archive,sha256,codeChanged:false}
}
function rawMeta(dir,name,reader){if(!io.stat(join(dir,name)))return;reader(dir);return readJson(join(dir,name))}
function mergeMeta(current,snapshot,name,kind){
 const reader=kind==='jobs'?listCaptureJobs:listCaptureInputs,a=rawMeta(current,name,reader),b=rawMeta(snapshot,name,reader),field=kind==='jobs'?'jobs':'inputs'
 if(!a&&!b)return{count:0,blocked:0}
 const rows=new Map((a?.[field]??[]).map(r=>[r.id,r]));let changed=!a,blocked=0
 for(const old of b?.[field]??[]){
  const now=rows.get(old.id)
  if(now){
   if(now.at!==old.at||now.updatedAt<old.updatedAt)fail('invocation-state-regression')
   if(kind==='jobs'&&(['succeeded','failed','abandoned'].includes(old.status)&&JSON.stringify(now)!==JSON.stringify(old)||old.status==='uncertain'&&now.status==='running'||now.expiresAt!==old.expiresAt))fail('invocation-state-regression')
   if(kind==='inputs'&&old.status!=='pending'&&(old.status!==now.status||old.jobId!==now.jobId||old.reason!==now.reason))fail('invocation-state-regression')
   continue
  }
  const row=structuredClone(old);if(kind==='inputs'&&row.status==='pending'){row.status='blocked';row.reason='restore-review-required';blocked++}
  rows.set(row.id,row);changed=true
 }
 if(rows.size>256)fail('invocation-retention-capacity')
 const value=changed?{schema:1,revision:Math.max(a?.revision??0,b?.revision??0)+1,[field]:[...rows.values()]}:a
 if(!Number.isSafeInteger(value.revision))fail('invocation-retention-capacity')
 const text=changed?JSON.stringify(value):io.bytes(join(current,name)).toString('utf8')
 if(Buffer.byteLength(text)>(kind==='jobs'?256*1024:1024*1024))fail('invocation-retention-capacity')
 return{text,count:rows.size,blocked}
}
function metadata(root,snapshot,stores){
 const writes=[],counts={jobs:0,inputs:0,blockedBackupInputs:0}
 for(const row of stores){
  const current=storeDir(root,row.name),old=storeDir(join(snapshot,'data'),row.name),prefix=row.name==='.'?'':row.name+'/'
  for(const [name,kind]of [['.capture-jobs.json','jobs'],['.capture-inputs.json','inputs']]){const value=mergeMeta(current,old,name,kind);counts[kind]+=value.count;counts.blockedBackupInputs+=value.blocked;if(value.text!==undefined)writes.push({path:prefix+name,text:value.text})}
  for(const name of special.slice(2))if(io.stat(join(current,name))){const body=io.bytes(join(current,name));try{JSON.parse(body)}catch{fail('invalid-current-metadata')};writes.push({path:prefix+name,text:body.toString('utf8')})}
 }
 return{writes,counts}
}
function checkpoint(root,j,fault){writeSafely(restorationJournalPath(root),JSON.stringify(j)+'\n');fault?.({phase:j.phase})}
function validateJournal(root,j){
 const fields=['schema','id','root','installationId','phase','stage','quarantine','before','prepared','snapshot','snapshotSha256','target','metadataCounts','controlBefore','controlBaseline']
 if(!j||Object.keys(j).sort().join('|')!==fields.sort().join('|')||j.schema!==1||!uuid(j.id)||j.root!==root||!uuid(j.installationId)||!phases.includes(j.phase)||j.stage!==basename(root)+'.restore-stage-'+j.id||j.quarantine!==basename(root)+'.restore-quarantine-'+j.id||!hex(j.before)||!hex(j.prepared)||typeof j.snapshot!=='string'||!hex(j.snapshotSha256)||!hex(j.controlBefore)||j.target?.protocol!==1)fail('invalid-journal')
 if(j.target.archive!==null&&(typeof j.target.archive!=='string'||!hex(j.target.sha256)))fail('invalid-journal')
 if(Object.keys(j.target).sort().join('|')!=='archive|codeChanged|protocol|sha256|version'||j.target.codeChanged!==false||typeof j.target.version!=='string'||!j.controlBaseline||!Array.isArray(j.controlBaseline.stores)||!Array.isArray(j.controlBaseline.operations)||j.controlBaseline.stores.length>128||j.controlBaseline.operations.length>1000)fail('invalid-journal')
 if(!j.metadataCounts||!['jobs','inputs','blockedBackupInputs'].every(k=>Number.isSafeInteger(j.metadataCounts[k])&&j.metadataCounts[k]>=0&&j.metadataCounts[k]<=256*128))fail('invalid-journal')
 return j
}
/** Preview binds source bytes, current data/control, invocation merge and selected code archive. */
export function reviewMemoryRestore(root,snapshot,{targetArchive}={}){
 root=resolve(root);snapshot=resolve(snapshot);assertRestorationInactive(root);io.separate(root,snapshot)
 const verified=verifyMemorySnapshot(snapshot),m=readJson(join(snapshot,'manifest.json'));if(m.sourceRoot!==root)fail('different-source-root')
 const current=managedMemoryStatus(root);if(!current.registered)fail('managed-control-required')
 if(m.control.registered&&m.control.installationId!==current.installationId)fail('different-installation')
 const tree=dataTree(root,true);const declared=new Set(current.stores.map(r=>r.name))
 const claims=files=>files.filter(r=>r.area==='data'&&r.path.startsWith('projects/.legacy-claims/'))
 if(io.digest(claims(tree.files))!==io.digest(claims(m.tree.files)))fail('project-migration-state-changed')
 for(const d of m.tree.dirs.filter(r=>r.area==='data'&&/^projects\/[^/]+$/.test(r.path)&&r.path!=='projects/.legacy-claims'))if(!declared.has(d.path))fail('snapshot-store-needs-review')
 const kept=metadata(root,snapshot,current.stores),target=targetInfo(targetArchive,snapshotSchemas(snapshot,m))
 const body={schema:1,root,snapshot,snapshotSha256:verified.manifestSha256,installationId:current.installationId,before:io.digest(tree),controlBefore:current.controlRevision,metadataHash:io.digest(kept.writes),metadataCounts:kept.counts,target}
 return{applied:false,...body,review:io.digest(body),currentDataIsQuarantined:true,latestControlRetained:true,modelRequestResent:false,codeChanged:false}
}
function prepare(root,snapshot,plan){
 const id=randomUUID(),stage=basename(root)+'.restore-stage-'+id,quarantine=basename(root)+'.restore-quarantine-'+id,dest=join(dirname(root),stage)
 mkdirSync(dest,{mode:0o700});const m=readJson(join(snapshot,'manifest.json'))
 for(const row of m.tree.dirs.filter(r=>r.area==='data'&&r.path))mkdirSync(join(dest,row.path),{recursive:true,mode:0o700})
 for(const row of m.tree.files.filter(r=>r.area==='data')){
  const name=basename(row.path);if(special.includes(name)||name==='.write.lock')continue
  const body=io.bytes(join(snapshot,'data',row.path));if(io.hash(body)!==row.sha256)fail('snapshot-changed');writeFileSync(join(dest,row.path),body,{mode:0o600,flag:'wx'})
 }
 const status=managedMemoryStatus(root),kept=metadata(root,snapshot,status.stores);if(io.digest(kept.writes)!==plan.metadataHash)fail('stale-review')
 for(const row of status.stores)mkdirSync(storeDir(dest,row.name),{recursive:true,mode:0o700})
 for(const row of kept.writes)writeFileSync(join(dest,row.path),row.text,{mode:0o600,flag:'wx'})
 for(const row of status.stores){const dir=storeDir(dest,row.name),inputs=listCaptureInputs(dir),jobs=new Set(listCaptureJobs(dir).jobs.map(j=>j.id));if(inputs.inputs.some(i=>i.status==='bound'&&!jobs.has(i.jobId)))fail('unbound-invocation-state')}
 if(reviewMemoryRestore(root,snapshot,{targetArchive:plan.target.archive??undefined}).review!==plan.review)fail('stale-review')
 const controlBaseline={stores:status.stores.map(({name,role,scope})=>({name,role,scope})),operations:status.operations.map(({id,source})=>({id,source}))}
 return{schema:1,id,root,installationId:plan.installationId,phase:'prepared',stage,quarantine,before:plan.before,prepared:fingerprint(dest),snapshot,snapshotSha256:plan.snapshotSha256,target:plan.target,metadataCounts:kept.counts,controlBefore:plan.controlBefore,controlBaseline}
}
function finish(root,j,{fault}={}){
 const parent=dirname(root),stage=join(parent,j.stage),quarantine=join(parent,j.quarantine)
 const identity=controlStatus(root);if(!identity.registered||identity.installationId!==j.installationId)fail('control-lost-or-mismatched')
 if(j.controlBaseline.stores.some(row=>!identity.stores.some(now=>now.name===row.name&&now.role===row.role&&now.scope===row.scope))||j.controlBaseline.operations.some(row=>!identity.operations.some(now=>now.id===row.id&&now.source===row.source)))fail('control-state-regressed')
 if(['prepared','old-moved','new-live'].includes(j.phase)&&identity.controlRevision!==j.controlBefore)fail('control-changed-before-cleanup')
 for(const path of [root,quarantine])if(io.stat(path))for(const row of dataTree(path).files)if(['.loaded.json','.write.lock'].includes(basename(row.path)))io.owner(join(path,row.path))
 if(j.target.archive!==null){const target=targetInfo(j.target.archive);if(JSON.stringify(target)!==JSON.stringify(j.target))fail('target-archive-changed')}
 if(j.phase==='prepared'){
  if(!io.stat(quarantine)){if(!io.stat(root)||fingerprint(root)!==j.before||fingerprint(stage)!==j.prepared)fail('changed-before-replacement');renameSync(root,quarantine);fault?.({phase:'old-renamed'})}
  else if(io.stat(root)||fingerprint(quarantine)!==j.before)fail('changed-quarantine')
  j.phase='old-moved';checkpoint(root,j,fault)
 }
 if(j.phase==='old-moved'){
  if(!io.stat(root)){if(fingerprint(quarantine)!==j.before||fingerprint(stage)!==j.prepared)fail('changed-before-promotion');renameSync(stage,root);fault?.({phase:'new-renamed'})}
  else if(io.stat(stage)||fingerprint(root)!==j.prepared)fail('changed-promotion')
  j.phase='new-live';checkpoint(root,j,fault)
 }
 if(j.phase==='new-live'){if(fingerprint(root)!==j.prepared||fingerprint(quarantine)!==j.before)fail('changed-promoted-data');j.phase='cleaning';checkpoint(root,j,fault)}
 if(j.phase==='cleaning'){
  withRestorationPermit(root,()=>{
   const status=managedMemoryStatus(root)
   for(const row of status.stores)recoverMemoryPublication(storeDir(root,row.name),{apply:true})
   reconcileRestoredMemory(root,{fault})
   for(const row of controlStatus(root).stores){const dir=storeDir(root,row.name);managedRead(dir,()=>{candidateSnapshot(dir,row.scope);episodeSnapshot(dir);listCaptureJobs(dir);listCaptureInputs(dir)})}
  })
  j.phase='complete';checkpoint(root,j,fault)
 }
 if(j.phase==='complete'){
  const receipt={...j,completedAt:new Date().toISOString(),after:fingerprint(root),controlAfter:controlStatus(root).controlRevision,modelRequestResent:false,codeChanged:false}
  const dir=root+'.restore-receipts';io.ancestors(dir);if(!io.stat(dir))mkdirSync(dir,{mode:0o700});const file=join(dir,j.id+'.json')
  if(!io.stat(file))writeFileSync(file,JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'})
  else{const old=readJson(file);if(old.id!==j.id||old.after!==receipt.after||old.controlAfter!==receipt.controlAfter)fail('receipt-mismatch')}
  fault?.({phase:'receipt'});unlinkSync(restorationJournalPath(root))
  return{applied:true,pending:false,id:j.id,quarantine,receipt:file,metadataCounts:j.metadataCounts,latestControlRetained:true,modelRequestResent:false,codeChanged:false,target:j.target}
 }
 fail('invalid-journal-phase')
}
export function restoreMemorySnapshot(root,snapshot,{apply=false,reviewed,targetArchive,fault}={}){
 root=resolve(root);if(typeof apply!=='boolean')fail('invalid-apply');if(!apply)return reviewMemoryRestore(root,snapshot,{targetArchive})
 return worker(root,()=>{
  const plan=reviewMemoryRestore(root,snapshot,{targetArchive});if(!hex(reviewed)||reviewed!==plan.review)fail('stale-review')
  const j=prepare(root,resolve(snapshot),plan),path=restorationJournalPath(root),fd=openSync(path,'wx',0o600)
  try{writeFileSync(fd,JSON.stringify(j)+'\n');fsyncSync(fd)}finally{closeSync(fd)}
  fault?.({phase:'prepared'});return finish(root,j,{fault})
 })
}
export function resumeMemoryRestore(root,{apply=false,fault}={}){
 root=resolve(root);if(typeof apply!=='boolean')fail('invalid-apply');if(!restorationPending(root))return{applied:false,pending:false,modelRequestResent:false,codeChanged:false}
 const j=validateJournal(root,readJson(restorationJournalPath(root)));if(!apply)return{applied:false,pending:true,id:j.id,phase:j.phase,latestControlRetained:true,modelRequestResent:false,codeChanged:false}
 return worker(root,()=>{const current=validateJournal(root,readJson(restorationJournalPath(root)));return finish(root,current,{fault})})
}
