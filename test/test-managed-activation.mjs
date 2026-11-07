import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,existsSync,symlinkSync,realpathSync,cpSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {writeMemory,indexLine,withdrawManagedSource,searchStore,managedMemoryStatus,initializeManagedMemory,storeRevision,adoptCandidate} from '../index.mjs'
import {stageCandidate} from '../candidates.mjs'
import {activateManagedMemory,activationStores} from '../managed-activation.mjs'
import {probeEnvironment} from '../scripts/probe-env.mjs'
const here=dirname(dirname(fileURLToPath(import.meta.url))),hash=value=>createHash('sha256').update(value).digest('hex')
function box(run){const root=realpathSync(mkdtempSync(join(tmpdir(),'managed-activation-'))),data=join(root,'memory');mkdirSync(data);try{return run({root,data})}finally{rmSync(root,{recursive:true,force:true})}}
function write(dir,scope='global',owner='old-owner',word='jade9876'){
 const summary='Synthetic activation preference '+word
 writeMemory({dir,scope,type:'user',summary,detail:summary,line:indexLine('user',summary,undefined,true),provenance:{basis:'tool-context',sessionId:owner,callHash:hash(owner+scope+word),evidence:[{messageId:'root',hash:hash('synthetic '+owner),quote:summary}]}})
}
function withdraw(dir,owner='old-owner',scope='global'){const view=withdrawManagedSource(dir,owner,'root',{scope});withdrawManagedSource(dir,owner,'root',{scope,apply:true,reviewedIndex:view.reviewedIndex,candidateRevision:view.candidateRevision})}
function cli(f,command,...args){return spawnSync(process.execPath,[join(here,'scripts/control.mjs'),command,'--root',f.data,...args],{encoding:'utf8',env:probeEnvironment(f.root),timeout:20000})}
function candidateCli(f,...args){return spawnSync(process.execPath,[join(here,'scripts/candidates.mjs'),...args,'--scope','global'],{encoding:'utf8',env:{...probeEnvironment(f.root),DSH_HOME:f.root},timeout:20000})}
function legacyAdopted(f){
 const project=join(f.data,'projects/legacy-project');mkdirSync(project,{recursive:true})
 for(const [dir,scope]of [[f.data,'global'],[project,'project']]){const {id}=stageCandidate(dir,{type:'user',scope,summary:'Synthetic legacy adopted jade9876',detail:'Synthetic legacy adopted jade9876 detail',sessionId:'old-owner',indexRevision:storeRevision(dir),evidence:[{messageId:'root',hash:hash('old explicit source'),quote:'Synthetic legacy explicit confirmation'}]}),plan=adoptCandidate(dir,id,{scope});adoptCandidate(dir,id,{scope,apply:true,reviewedIndex:plan.reviewedIndex,candidateRevision:plan.candidateRevision})}
 const file=join(project,'.candidates.json'),state=JSON.parse(readFileSync(file));delete state.records[0].adoption.lineHash;writeFileSync(file,JSON.stringify(state));const backup=join(f.root,'legacy-before-withdrawal');cpSync(f.data,backup,{recursive:true});withdraw(f.data)
 return{project,file,backup,stores:[{name:'.',role:'global'},{name:'projects/legacy-project',role:'legacy-copy',scope:'project'}]}
}
test('activation CLI preview and invalid arguments do not create control or mutate existing files',()=>box(f=>{
 write(f.data);const before=Object.fromEntries(readdirSync(f.data).map(name=>[name,readFileSync(join(f.data,name),'utf8')]))
 const view=cli(f,'initialize');assert.equal(view.status,0);assert.equal(JSON.parse(view.stdout).applied,false);assert.equal(existsSync(f.data+'.control'),false)
 assert.equal(cli(f,'initialize','--unexpected').status,1);assert.equal(cli(f,'status','--apply').status,1)
 assert.deepEqual(Object.fromEntries(readdirSync(f.data).map(name=>[name,readFileSync(join(f.data,name),'utf8')])),before)
}))
test('reviewed import binds old adoption records lacking lineHash without rewriting their original ledger',()=>box(f=>{
 const {project,file,stores}=legacyAdopted(f),original=readFileSync(file),plan=activateManagedMemory(f.data,{stores,importLegacy:true});activateManagedMemory(f.data,{stores,importLegacy:true,apply:true,reviewed:plan.review})
 assert.deepEqual(readFileSync(file),original);assert.equal(searchStore(project,'jade9876').hits.length,0);const op=managedMemoryStatus(f.data).operations[0];assert.equal(withdrawManagedSource(f.data,'old-owner','root',{operationId:op.id,apply:true}).cleanupComplete,true);assert.doesNotMatch(readFileSync(join(project,'user.md'),'utf8'),/jade9876/)
}))
test('an old adoption with a different memory identity is rejected before registration creates control',()=>box(f=>{
 const {file,stores}=legacyAdopted(f),state=JSON.parse(readFileSync(file));state.records[0].adoption.memoryId='00000000';writeFileSync(file,JSON.stringify(state));assert.throws(()=>activateManagedMemory(f.data,{stores,importLegacy:true}),/legacy-adoption-identity-diverged/);assert.equal(existsSync(f.data+'.control'),false)
}))
test('unrelated write after legacy whole-store restore retires revoked adoptions before filtering projections',()=>box(f=>{
 const {project,backup,stores}=legacyAdopted(f),plan=activateManagedMemory(f.data,{stores,importLegacy:true});activateManagedMemory(f.data,{stores,importLegacy:true,apply:true,reviewed:plan.review});const op=managedMemoryStatus(f.data).operations[0];withdrawManagedSource(f.data,'old-owner','root',{operationId:op.id,apply:true})
 rmSync(f.data,{recursive:true});cpSync(backup,f.data,{recursive:true});write(f.data,'global','valid-owner','cobalt7654');assert.ok(searchStore(f.data,'cobalt7654').hits.length>0);assert.equal(searchStore(f.data,'jade9876').hits.length,0);assert.equal(searchStore(project,'jade9876').hits.length,0)
 assert.equal(withdrawManagedSource(f.data,'old-owner','root',{operationId:op.id,apply:true}).cleanupComplete,true);assert.ok(searchStore(f.data,'cobalt7654').hits.length>0);assert.doesNotMatch(readFileSync(join(project,'user.md'),'utf8'),/jade9876/)
}))
test('existing project directories require complete explicit declarations rather than silently excluding stores',()=>box(f=>{
 mkdirSync(join(f.data,'projects/legacy-one'),{recursive:true});mkdirSync(join(f.data,'projects/legacy-two'))
 assert.throws(()=>activationStores(f.data),/project-declarations-required/)
 assert.deepEqual(JSON.parse(cli(f,'inventory').stdout),{projectStores:['projects/legacy-one','projects/legacy-two'],projectDeclarationsRequired:true})
 assert.throws(()=>activationStores(f.data,[{name:'.',role:'global'},{name:'projects/legacy-one',role:'legacy-copy',scope:'project'}]),/incomplete-project-declarations/)
 assert.equal(existsSync(f.data+'.control'),false)
}))
test('activation refuses linked project directories and unfinished project migrations',()=>box(f=>{
 const outside=join(f.root,'outside');mkdirSync(outside);mkdirSync(join(f.data,'projects'));symlinkSync(outside,join(f.data,'projects/linked'))
 assert.throws(()=>activationStores(f.data),/unsafe-directory/);rmSync(join(f.data,'projects/linked'));mkdirSync(join(f.data,'projects/.migration-unfinished'))
 assert.throws(()=>activationStores(f.data),/project-migration-needs-recovery/);assert.equal(existsSync(f.data+'.control'),false)
}))
test('apply refuses a live recorded host while read-only activation preview remains available',()=>box(f=>{
 writeFileSync(join(f.data,'.loaded.json'),JSON.stringify({pid:process.pid}));const preview=activateManagedMemory(f.data)
 assert.throws(()=>activateManagedMemory(f.data,{apply:true,reviewed:preview.review}),/host-must-stop-before-activation/);assert.equal(existsSync(f.data+'.control'),false)
}))
test('local CLI imports a legacy source across declared stores and resumes physical cleanup',()=>box(f=>{
 const project=join(f.data,'projects/legacy-project');mkdirSync(project,{recursive:true});write(f.data);write(project,'project');write(project,'project','other-owner','cobalt7654');withdraw(f.data)
 const rows=[{name:'.',role:'global'},{name:'projects/legacy-project',role:'legacy-copy',scope:'project'}],file=join(f.root,'stores.json');writeFileSync(file,JSON.stringify(rows));assert.equal(cli(f,'initialize','--stores-file',file).status,1)
 const preview=cli(f,'initialize','--stores-file',file,'--import-legacy');assert.equal(preview.status,0);const plan=JSON.parse(preview.stdout);assert.equal(plan.legacyImports.length,1)
 const applied=cli(f,'initialize','--stores-file',file,'--import-legacy','--apply','--reviewed',plan.review);assert.equal(applied.status,0);assert.equal(JSON.parse(applied.stdout).legacySourcesImported,1);assert.equal(searchStore(project,'jade9876').hits.length,0);assert.ok(searchStore(project,'cobalt7654').hits.length>0)
 const status=JSON.parse(cli(f,'status').stdout),op=status.operations[0];assert.equal(status.stores.length,2);assert.equal(JSON.parse(cli(f,'resume','--operation',op.id).stdout).applied,false);assert.match(readFileSync(join(project,'MEMORY.md'),'utf8'),/jade9876/)
 const resumed=cli(f,'resume','--operation',op.id,'--apply');assert.equal(resumed.status,0);assert.equal(JSON.parse(resumed.stdout).pending,0);assert.doesNotMatch(readFileSync(join(project,'user.md'),'utf8'),/jade9876/);assert.ok(searchStore(project,'cobalt7654').hits.length>0)
}))
test('two different legacy source roots are imported into every store in the same registration',()=>box(f=>{
 const project=join(f.data,'projects/legacy-project');mkdirSync(project,{recursive:true});write(f.data);withdraw(f.data);write(project,'project','second-owner','amber3258');withdraw(project,'second-owner','project');write(f.data,'global','valid-owner','cobalt7654')
 const stores=[{name:'.',role:'global'},{name:'projects/legacy-project',role:'legacy-copy',scope:'project'}],plan=activateManagedMemory(f.data,{stores,importLegacy:true});assert.equal(plan.legacyImports.length,2)
 activateManagedMemory(f.data,{stores,importLegacy:true,apply:true,reviewed:plan.review});const status=managedMemoryStatus(f.data);assert.equal(status.operations.length,2);assert.ok(status.operations.every(op=>op.pending===2));assert.ok(searchStore(f.data,'cobalt7654').hits.length>0)
 for(const [dir,scope,owner,word]of [[f.data,'global','second-owner','amber3258'],[project,'project','old-owner','jade9876']])assert.throws(()=>write(dir,scope,owner,word),/source-revoked/)
}))
test('new project registration cannot omit its previously unknown local revocation',()=>box(f=>{
 const initial=initializeManagedMemory(f.data);initializeManagedMemory(f.data,undefined,{apply:true,reviewed:initial.review});const project=join(f.data,'projects/new-project');mkdirSync(project,{recursive:true})
 // An old library brought in before registration retains its old admission barrier.
 const source=hash(JSON.stringify(['imported-owner','root']));writeFileSync(join(project,'.candidates.json'),JSON.stringify({schema:1,revision:1,records:[],revoked:[source]}))
 const stores=[{name:'.',role:'global'},{name:'projects/new-project',role:'legacy-copy',scope:'project'}];assert.throws(()=>initializeManagedMemory(f.data,stores),/legacy-source-import-required/)
 const plan=initializeManagedMemory(f.data,stores,{importLegacy:true});initializeManagedMemory(f.data,stores,{importLegacy:true,apply:true,reviewed:plan.review});assert.equal(managedMemoryStatus(f.data).operations.length,1);assert.throws(()=>write(f.data,'global','imported-owner'),/source-revoked/)
}))
test('candidate CLI forwards the reviewed global control revision for explicit adoption',()=>box(f=>{
 const plan=initializeManagedMemory(f.data);initializeManagedMemory(f.data,undefined,{apply:true,reviewed:plan.review})
 const {id}=stageCandidate(f.data,{type:'user',scope:'global',summary:'Synthetic explicitly reviewed cobalt7654',sessionId:'fresh-owner',indexRevision:storeRevision(f.data),evidence:[{messageId:'fresh-root',hash:hash('fresh evidence'),quote:'Synthetic fresh explicit statement'}]})
 const preview=candidateCli(f,'adopt','--id',id);assert.equal(preview.status,0);const review=JSON.parse(preview.stdout),args=['adopt','--id',id,'--apply','--reviewed-index',review.reviewedIndex,'--candidate-revision',String(review.candidateRevision)]
 assert.equal(candidateCli(f,...args).status,1);const adopted=candidateCli(f,...args,'--control-revision',review.controlRevision);assert.equal(adopted.status,0);assert.ok(searchStore(f.data,'cobalt7654').hits.length>0)
}))
test('candidate CLI forwards the reviewed global barrier for source withdrawal',()=>box(f=>{
 write(f.data);const plan=initializeManagedMemory(f.data);initializeManagedMemory(f.data,undefined,{apply:true,reviewed:plan.review})
 const args=['withdraw-managed-source','--session','old-owner','--message','root'],preview=candidateCli(f,...args);assert.equal(preview.status,0);const review=JSON.parse(preview.stdout)
 assert.equal(candidateCli(f,...args,'--apply').status,1);const applied=candidateCli(f,...args,'--apply','--control-review',review.controlReview);assert.equal(applied.status,0);assert.equal(JSON.parse(applied.stdout).cleanupComplete,true);assert.equal(searchStore(f.data,'jade9876').hits.length,0)
}))
