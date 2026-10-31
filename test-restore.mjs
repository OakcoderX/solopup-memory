import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,readdirSync,cpSync,symlinkSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {createMemorySnapshot,snapshotIO} from './snapshots.mjs'
import {restoreMemorySnapshot,reviewMemoryRestore,resumeMemoryRestore} from './restore.mjs'
import {restorationPending,restorationJournalPath} from './restoration-lock.mjs'
import {initializeManagedMemory,managedMemoryStatus,writeMemory,indexLine,searchStore,withdrawManagedSource,storeDirFor,apply} from './index.mjs'
import {controlStatus} from './managed-policy.mjs'
import {claimCaptureJob,finishCaptureJob,listCaptureJobs} from './capture-jobs.mjs'
import {captureInputDescriptor,enqueueCaptureInput,listCaptureInputs,bindCaptureInput} from './capture-inputs.mjs'
import {compileValueRevision} from './field-lineage.mjs'
import {candidateSnapshot} from './candidates.mjs'
import {episodeSnapshot} from './episodes.mjs'
const here=dirname(fileURLToPath(import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex')
async function box(run){const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-restore-'))),home=join(root,'home'),data=join(home,'memory'),snapshot=join(root,'snapshot'),cwd=join(root,'project'),previous=process.env.DSH_HOME;mkdirSync(home);mkdirSync(data);mkdirSync(cwd);writeFileSync(join(cwd,'.dsh-root'),'');process.env.DSH_HOME=home;const p=initializeManagedMemory(data);initializeManagedMemory(data,undefined,{apply:true,reviewed:p.review});try{return await run({root,home,data,snapshot,cwd})}finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(root,{recursive:true,force:true})}}
function seed(dir,word,owner='owner-'+word,scope='global'){const summary='Synthetic lasting preference '+word;return writeMemory({dir,scope,type:'user',summary,detail:summary,line:indexLine('user',summary,undefined,true),provenance:{basis:'tool-context',sessionId:owner,callHash:hash(owner+word),evidence:[{messageId:'root',hash:hash('quote '+word),quote:summary}]}})}
function revoke(data,owner){const p=withdrawManagedSource(data,owner,'root');return withdrawManagedSource(data,owner,'root',{apply:true,controlReview:p.controlReview})}
function tree(data){return snapshotIO.digest(snapshotIO.inventory(data,{dataOnly:true}))}
function restore(f,options={}){const p=reviewMemoryRestore(f.data,f.snapshot,options);return restoreMemorySnapshot(f.data,f.snapshot,{...options,apply:true,reviewed:p.review})}
const options={everyTurns:4,maxEntries:3,maxTokens:800,maxInputBytes:24000,timeoutMs:25000}
function input(id){return captureInputDescriptor({id,header:{createdAt:1234}},[{seq:1,role:'user',hash:hash('synthetic '+id)}],'/synthetic/project',options,{provider:'fixture',model:'fixture'})}
function fieldValue(f,n,parent){
 const summary='Synthetic draft palette field-'+n,compiled=parent?compileValueRevision(parent,{kind:'preference'},'global'):undefined;
 writeMemory({dir:f.data,type:'user',scope:'global',summary,line:indexLine('user',summary,undefined,false),meaning:compiled?.meaning??{kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}]},...parent?{supersedes:parent.indexLine}:{},provenance:{basis:'tool-context',sessionId:'field-owner-'+n,callHash:hash('field-call-'+n),evidence:[{messageId:'root',hash:hash('field-source-'+n),quote:'Synthetic field palette original source '+n}],...compiled?{fieldLineage:compiled.fieldLineage}:{}}});
 return candidateSnapshot(f.data,'global').records.find(r=>r.status==='recorded'&&r.summary===summary);
}
test('schema4 source ledger and schema2 history restore together and retain inherited-source withdrawals',()=>box(f=>{
 const a=fieldValue(f,1),b=fieldValue(f,2,a);assert.equal(episodeSnapshot(f.data).state.schema,2);createMemorySnapshot(f.data,f.snapshot);
 fieldValue(f,3,b);revoke(f.data,'field-owner-1');restore(f);
 assert.equal(searchStore(f.data,'field-2').hits.length,0);assert.equal(episodeSnapshot(f.data).state.entries.some(r=>r.source.sources.includes(a.sources[0])),false);
 assert.equal(JSON.parse(readFileSync(join(f.data,'.candidates.json'))).schema,4);
}))
test('a field-lineage snapshot cannot be reviewed for a legacy archive lacking its data capability',()=>box(f=>{
 const a=fieldValue(f,1);createMemorySnapshot(f.data,join(f.root,'legacy-snapshot'));fieldValue(f,2,a);createMemorySnapshot(f.data,f.snapshot);
 const p=join(f.root,'target/package');mkdirSync(p,{recursive:true});const archive=join(f.root,'target.tgz'),json=join(p,'package.json');
 const pack=()=>assert.equal(spawnSync('tar',['-czf',archive,'-C',dirname(p),'package']).status,0);
 const legacy={name:'dsh-memory',version:'0.21.0-dev.31',dshMemoryRestoreProtocol:1};writeFileSync(json,JSON.stringify(legacy));pack();const before=tree(f.data);
 assert.throws(()=>reviewMemoryRestore(f.data,f.snapshot,{targetArchive:archive}),/target-data-schema-unsupported/);assert.equal(tree(f.data),before);assert.equal(restorationPending(f.data),false);
 // A real pre-field snapshot can still be selected for supported data rollback.
 assert.equal(reviewMemoryRestore(f.data,join(f.root,'legacy-snapshot'),{targetArchive:archive}).target.version,legacy.version);
 writeFileSync(json,JSON.stringify({...legacy,version:'0.21.0-dev.33',dshMemoryDataSchemas:{candidates:[1,2,3,4],episodes:[1,2]}}));pack();assert.equal(reviewMemoryRestore(f.data,f.snapshot,{targetArchive:archive}).target.version,'0.21.0-dev.33');
 writeFileSync(json,JSON.stringify({...legacy,dshMemoryDataSchemas:{candidates:[1,2,3,4],episodes:[1]}}));pack();assert.throws(()=>reviewMemoryRestore(f.data,f.snapshot,{targetArchive:archive}),/target-data-schema-unsupported/);
}))
test('review is readonly; restore selects old data, keeps independent control, and quarantines every newer file',()=>box(f=>{
 seed(f.data,'before4826');createMemorySnapshot(f.data,f.snapshot);seed(f.data,'after5937');const before=tree(f.data),status=managedMemoryStatus(f.data),pin=readFileSync(f.data+'.control-binding.json')
 const p=reviewMemoryRestore(f.data,f.snapshot);assert.equal(p.applied,false);assert.equal(tree(f.data),before);assert.equal(restorationPending(f.data),false)
 const r=restoreMemorySnapshot(f.data,f.snapshot,{apply:true,reviewed:p.review});assert.equal(r.pending,false);assert.equal(r.codeChanged,false);assert.equal(r.modelRequestResent,false);assert.ok(searchStore(f.data,'before4826').hits.length);assert.equal(searchStore(f.data,'after5937').hits.length,0);assert.equal(tree(r.quarantine),before);assert.deepEqual(readFileSync(f.data+'.control-binding.json'),pin);assert.equal(managedMemoryStatus(f.data).installationId,status.installationId);assert.ok(existsSync(r.receipt));assert.equal(restorationPending(f.data),false);assert.deepEqual(resumeMemoryRestore(f.data,{apply:true}),{applied:false,pending:false,modelRequestResent:false,codeChanged:false})
}))
test('post-backup withdrawal remains effective and is physically reapplied in global and project history',()=>box(f=>{
 const project=storeDirFor('project',f.cwd);for(const [dir,scope]of [[f.data,'global'],[project,'project']])seed(dir,'private6048','withdrawn-owner',scope)
 createMemorySnapshot(f.data,f.snapshot);revoke(f.data,'withdrawn-owner');seed(f.data,'fresh6159');const before=controlStatus(f.data);const r=restore(f)
 assert.equal(r.latestControlRetained,true);assert.equal(managedMemoryStatus(f.data).installationId,before.installationId);assert.deepEqual(controlStatus(f.data).operations.map(r=>r.source),before.operations.map(r=>r.source))
 for(const dir of [f.data,project]){assert.equal(searchStore(dir,'private6048').hits.length,0);assert.doesNotMatch(readFileSync(join(dir,'MEMORY.md'),'utf8'),/private6048/);assert.doesNotMatch(readFileSync(join(dir,'user.md'),'utf8'),/private6048/);assert.doesNotMatch(readFileSync(join(dir,'.episodes.json'),'utf8'),/private6048/)}
 assert.throws(()=>seed(storeDirFor('project',f.cwd),'repeat6260','withdrawn-owner','project'),/source-revoked/)
}))
test('current known failure and unknown invocation ids survive; restoring never creates a new claim for them',()=>box(f=>{
 seed(f.data,'prior6371');createMemorySnapshot(f.data,f.snapshot)
 const known=claimCaptureJob(f.data,hash('known'));finishCaptureJob(f.data,known,{outcome:'error',reason:'capture-provider-error',counts:{proposed:0}})
 const unknown=claimCaptureJob(f.data,hash('unknown'),{now:Date.now()-10000,leaseMs:1000}),old=readFileSync(join(f.data,'.capture-jobs.json'))
 restore(f);assert.deepEqual(readFileSync(join(f.data,'.capture-jobs.json')),old);assert.equal(claimCaptureJob(f.data,hash('known')).claimed,false);assert.equal(claimCaptureJob(f.data,hash('unknown')).claimed,false);assert.equal(listCaptureJobs(f.data).jobs.find(j=>j.id===unknown.id).status,'uncertain')
}))
test('backup-only pending input is blocked for review; latest bound input and job are retained',()=>box(f=>{
 const pending=enqueueCaptureInput(f.data,input('old-pending'));createMemorySnapshot(f.data,f.snapshot);rmSync(join(f.data,'.capture-inputs.json'))
 const current=enqueueCaptureInput(f.data,input('current-bound')),job=claimCaptureJob(f.data,current.id);bindCaptureInput(f.data,current.id,job.id);finishCaptureJob(f.data,job,{outcome:'ok',counts:{proposed:0}})
 const r=restore(f),rows=listCaptureInputs(f.data).inputs;assert.equal(r.metadataCounts.blockedBackupInputs,1);assert.equal(rows.find(r=>r.id===pending.id).reason,'restore-review-required');assert.equal(rows.find(r=>r.id===current.id).status,'bound');assert.equal(claimCaptureJob(f.data,current.id).claimed,false)
}))
test('backup-only completed invocation is retained even if current metadata no longer lists it',()=>box(f=>{
 const job=claimCaptureJob(f.data,hash('old-complete'));finishCaptureJob(f.data,job,{outcome:'ok',counts:{proposed:0}});createMemorySnapshot(f.data,f.snapshot);rmSync(join(f.data,'.capture-jobs.json'));restore(f);assert.equal(claimCaptureJob(f.data,hash('old-complete')).claimed,false)
}))
test('stale review, wrong root, lost control and different installation reject without replacing any data',()=>box(f=>{
 seed(f.data,'old6482');createMemorySnapshot(f.data,f.snapshot);const p=reviewMemoryRestore(f.data,f.snapshot);seed(f.data,'new6593');const before=tree(f.data)
 assert.throws(()=>restoreMemorySnapshot(f.data,f.snapshot,{apply:true,reviewed:p.review}),/stale-review/);assert.equal(tree(f.data),before);assert.equal(restorationPending(f.data),false)
 assert.throws(()=>reviewMemoryRestore(join(f.root,'other'),f.snapshot),/different-source-root/)
 const controls=f.data+'.control';cpSync(controls,join(f.root,'saved-control'),{recursive:true});rmSync(controls,{recursive:true});assert.throws(()=>reviewMemoryRestore(f.data,f.snapshot),/control-missing/);assert.equal(tree(f.data),before)
}))
for(const phase of ['prepared','old-renamed','old-moved','new-renamed','new-live','cleaning','restored-operation','complete','receipt'])test('interrupted '+phase+' stays guarded and resumes once with the latest withdrawal barrier',()=>box(f=>{
 seed(f.data,'withdraw6704','withdrawn-owner');seed(f.data,'keep6815');createMemorySnapshot(f.data,f.snapshot);revoke(f.data,'withdrawn-owner');seed(f.data,'new6926');let hit=false
 assert.throws(()=>restore(f,{fault:e=>{if(e.phase===phase){hit=true;throw Error('synthetic-interruption')}}}),/synthetic-interruption/);assert.equal(hit,true);assert.equal(restorationPending(f.data),true);assert.throws(()=>searchStore(f.data,'withdraw6704'),/restore-in-progress/);assert.throws(()=>seed(f.data,'blocked7037'),/restore-in-progress/)
 const view=resumeMemoryRestore(f.data);assert.equal(view.pending,true);const result=resumeMemoryRestore(f.data,{apply:true});assert.equal(result.pending,false);assert.equal(searchStore(f.data,'withdraw6704').hits.length,0);assert.equal(searchStore(f.data,'new6926').hits.length,0);assert.ok(searchStore(f.data,'keep6815').hits.length);assert.equal(resumeMemoryRestore(f.data,{apply:true}).pending,false)
}))
test('a corrupt restore journal blocks ordinary reads and cannot redirect replacement paths',()=>box(f=>{
 seed(f.data,'safe7148');createMemorySnapshot(f.data,f.snapshot);assert.throws(()=>restore(f,{fault:e=>{if(e.phase==='prepared')throw Error('stop')}}),/stop/)
 const p=restorationJournalPath(f.data),j=JSON.parse(readFileSync(p));j.quarantine='../outside';writeFileSync(p,JSON.stringify(j));assert.throws(()=>resumeMemoryRestore(f.data,{apply:true}),/invalid-journal/);assert.throws(()=>searchStore(f.data,'safe7148'),/restore-in-progress/);assert.ok(readFileSync(join(f.data,'MEMORY.md'),'utf8').includes('safe7148'))
}))
test('a live second worker cannot resume or steal the in-progress journal',()=>box(f=>{
 seed(f.data,'old7259');createMemorySnapshot(f.data,f.snapshot);assert.throws(()=>restore(f,{fault:e=>{if(e.phase==='prepared')throw Error('stop')}}),/stop/)
 writeFileSync(f.data+'.restore-worker.lock',JSON.stringify({pid:process.pid,token:'00000000-0000-0000-0000-000000000000'}));assert.throws(()=>resumeMemoryRestore(f.data,{apply:true}),/worker-busy/)
}))
test('a host mounted during the missing-directory phase writes no new root and sees only a restore notice',()=>box(async f=>{
 seed(f.data,'private7360');createMemorySnapshot(f.data,f.snapshot);assert.throws(()=>restore(f,{fault:e=>{if(e.phase==='old-moved')throw Error('stop')}}),/stop/);assert.equal(existsSync(f.data),false)
 const tools=[],providers=[],effects=[];let calls=0;const ctx={systemPrompt:{context:p=>providers.push(p)},tools:{register:t=>tools.push(t)},workingDirectory:{get:()=>f.cwd},llm:{listProviders:()=>[],prepareCall(){calls++;throw Error('must not call')}},on(){},effect(fn){effects.push(fn())}}
 apply(ctx,{autoCapture:{everyTurns:1}});const status=await tools.find(t=>t.name==='memory_status').execute({scope:'global'});assert.equal(status.sourceControl.code,'managed-memory-restore-in-progress');const text=providers.find(p=>p.name==='memory:index').text({agent:{session:{id:'during-restore'}}});assert.match(text,/恢复尚未完成/);assert.doesNotMatch(text,/private7360/);assert.equal(existsSync(f.data),false);assert.equal(calls,0);for(const fn of effects.reverse())fn?.();resumeMemoryRestore(f.data,{apply:true})
}))
test('CLI performs a reviewed restore in a fresh process; incomplete arguments cannot mutate the target',()=>box(f=>{
 seed(f.data,'before7471');createMemorySnapshot(f.data,f.snapshot);seed(f.data,'after7582');const cli=join(here,'scripts/backup.mjs'),run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'}),base=['restore','--root',f.data,'--snapshot',f.snapshot]
 let r=run(base);assert.equal(r.status,0,r.stderr);const plan=JSON.parse(r.stdout);assert.equal(plan.applied,false);r=run([...base,'--apply']);assert.notEqual(r.status,0);assert.ok(searchStore(f.data,'after7582').hits.length);r=run([...base,'--apply','--reviewed',plan.review]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).codeChanged,false);assert.equal(searchStore(f.data,'after7582').hits.length,0)
}))
test('an actual archive without the restore protocol is rejected; a declared protocol is bound to its SHA',()=>box(f=>{
 seed(f.data,'archive7693');createMemorySnapshot(f.data,f.snapshot);const p=join(f.root,'target/package');mkdirSync(p,{recursive:true});const file=join(p,'package.json'),archive=join(f.root,'target.tgz'),pack=()=>assert.equal(spawnSync('tar',['-czf',archive,'-C',dirname(p),'package']).status,0)
 writeFileSync(file,JSON.stringify({name:'dsh-memory',version:'0.20.0',dsh:{}}));pack();const before=tree(f.data);assert.throws(()=>reviewMemoryRestore(f.data,f.snapshot,{targetArchive:archive}),/incompatible-target-archive/);assert.equal(tree(f.data),before);assert.equal(restorationPending(f.data),false)
 writeFileSync(file,JSON.stringify({name:'dsh-memory',version:'0.21.0-dev.22',dshMemoryRestoreProtocol:1}));pack();const p1=reviewMemoryRestore(f.data,f.snapshot,{targetArchive:archive});assert.equal(p1.target.sha256,hash(readFileSync(archive)));writeFileSync(file,JSON.stringify({name:'dsh-memory',version:'0.21.0-dev.23',dshMemoryRestoreProtocol:1}));pack();assert.throws(()=>restoreMemorySnapshot(f.data,f.snapshot,{targetArchive:archive,apply:true,reviewed:p1.review}),/stale-review/)
}))
test('corrupt snapshot and unregistered snapshot project are rejected before any journal or replacement',()=>box(f=>{
 seed(f.data,'damage7804');createMemorySnapshot(f.data,f.snapshot);const file=join(f.snapshot,'data/MEMORY.md'),body=readFileSync(file),before=tree(f.data);writeFileSync(file,'Synthetic corrupted snapshot');assert.throws(()=>reviewMemoryRestore(f.data,f.snapshot),/content-mismatch/);assert.equal(tree(f.data),before);assert.equal(restorationPending(f.data),false);writeFileSync(file,body);const unknown=join(f.data,'projects/unregistered');mkdirSync(unknown,{recursive:true});writeFileSync(join(unknown,'MEMORY.md'),'Synthetic unknown project');const second=join(f.root,'second-snapshot');createMemorySnapshot(f.data,second);const unchanged=tree(f.data);assert.throws(()=>reviewMemoryRestore(f.data,second),/snapshot-store-needs-review/);assert.equal(tree(f.data),unchanged)
}))
test('restoration refuses a union that would silently evict invocation history',()=>box(f=>{
 for(let i=0;i<256;i++){const job=claimCaptureJob(f.data,hash('retained-'+i));finishCaptureJob(f.data,job,{outcome:'ok',counts:{proposed:0}})}createMemorySnapshot(f.data,f.snapshot)
 rmSync(join(f.data,'.capture-jobs.json'));const extra=claimCaptureJob(f.data,hash('extra'));finishCaptureJob(f.data,extra,{outcome:'ok',counts:{proposed:0}});const before=tree(f.data);assert.throws(()=>reviewMemoryRestore(f.data,f.snapshot),/invocation-retention-capacity/);assert.equal(tree(f.data),before);assert.equal(restorationPending(f.data),false)
}))
test('rewinding the independent control during an interrupted restore cannot erase captured withdrawals',()=>box(f=>{
 seed(f.data,'source7915','withdrawn-owner');createMemorySnapshot(f.data,f.snapshot);revoke(f.data,'withdrawn-owner');assert.throws(()=>restore(f,{fault:e=>{if(e.phase==='cleaning')throw Error('stop')}}),/stop/)
 rmSync(f.data+'.control',{recursive:true});cpSync(join(f.snapshot,'control'),f.data+'.control',{recursive:true});assert.throws(()=>resumeMemoryRestore(f.data,{apply:true}),/control-state-regressed/);assert.equal(restorationPending(f.data),true);assert.throws(()=>searchStore(f.data,'source7915'),/restore-in-progress/)
}))

test('the renamed package restores legacy snapshots without accepting arbitrary package identities',()=>box(f=>{
 seed(f.data,'brand-compatibility');createMemorySnapshot(f.data,f.snapshot)
 const target=join(f.root,'target/package');mkdirSync(target,{recursive:true});const file=join(target,'package.json'),archive=join(f.root,'brand.tgz'),pack=()=>assert.equal(spawnSync('tar',['-czf',archive,'-C',dirname(target),'package']).status,0),before=tree(f.data)
 writeFileSync(file,JSON.stringify({name:'solopup-memory',version:'0.21.0-beta.1',dshMemoryRestoreProtocol:1,dshMemoryDataSchemas:{candidates:[1,2,3,4],episodes:[1,2]}}));pack()
 assert.equal(reviewMemoryRestore(f.data,f.snapshot,{targetArchive:archive}).target.version,'0.21.0-beta.1');assert.equal(tree(f.data),before)
 writeFileSync(file,JSON.stringify({name:'unrelated-memory',version:'0.21.0-beta.1',dshMemoryRestoreProtocol:1,dshMemoryDataSchemas:{candidates:[1,2,3,4],episodes:[1,2]}}));pack()
 assert.throws(()=>reviewMemoryRestore(f.data,f.snapshot,{targetArchive:archive}),/incompatible-target-archive/);assert.equal(tree(f.data),before)
}))
