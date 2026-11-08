import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,symlinkSync,linkSync,chmodSync,lstatSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createMemorySnapshot,verifyMemorySnapshot,SNAPSHOT_LIMITS} from '../snapshots.mjs'
import {initializeManagedMemory,writeMemory,indexLine,withdrawManagedSource,managedMemoryStatus} from '../index.mjs'
import {createHash} from 'node:crypto'
const hash=b=>createHash('sha256').update(b).digest('hex'),here=dirname(dirname(fileURLToPath(import.meta.url)))
function box(run){const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-snapshot-'))),data=join(root,'memory'),snapshot=join(root,'backup');mkdirSync(data);try{return run({root,data,snapshot})}finally{rmSync(root,{recursive:true,force:true})}}
function text(data){writeFileSync(join(data,'MEMORY.md'),'- [user] Synthetic preference cyan1234\n',{mode:0o600});mkdirSync(join(data,'projects/empty'),{recursive:true})}
function tree(root){const rows=[];const walk=(p,r='')=>{for(const name of readdirSync(p).sort()){const f=join(p,name),n=r?r+'/'+name:name,s=lstatSync(f);if(s.isDirectory()){rows.push([n,'dir']);walk(f,n)}else rows.push([n,hash(readFileSync(f))])}};walk(root);return rows}
test('offline backup preserves byte-exact data and empty project directories; verify is read-only',()=>box(f=>{
 text(f.data);writeFileSync(join(f.data,'reference.md'),Buffer.from([0,255,195,40]));const before=tree(f.data),r=createMemorySnapshot(f.data,f.snapshot);assert.equal(r.verified,true);assert.equal(r.restoreSupported,true);assert.equal(r.integrityOnly,true);assert.equal(r.controlRegistered,false);assert.equal(r.sourceVersion,null);assert.deepEqual(tree(f.data),before)
 assert.deepEqual(readFileSync(join(f.snapshot,'data/reference.md')),Buffer.from([0,255,195,40]));assert.ok(existsSync(join(f.snapshot,'data/projects/empty')));const backupBefore=tree(f.snapshot);assert.equal(verifyMemorySnapshot(f.snapshot).manifestSha256,r.manifestSha256);assert.deepEqual(tree(f.snapshot),backupBefore);assert.equal(lstatSync(f.snapshot).mode&0o077,0);assert.equal(lstatSync(join(f.snapshot,'data/reference.md')).mode&0o077,0)
}))
test('managed backup includes independent SQLite control and binding; no control revision rewind',()=>box(f=>{
 const p=initializeManagedMemory(f.data);initializeManagedMemory(f.data,undefined,{apply:true,reviewed:p.review})
 const summary='Synthetic sourced backup preference jade1234';writeMemory({dir:f.data,type:'user',scope:'global',summary,line:indexLine('user',summary,undefined,false),provenance:{basis:'tool-context',sessionId:'backup-owner',callHash:hash('call'),evidence:[{messageId:'root',hash:hash('quote'),quote:'Synthetic sourced backup quotation jade1234'}]}})
 const w=withdrawManagedSource(f.data,'backup-owner','root');withdrawManagedSource(f.data,'backup-owner','root',{apply:true,controlReview:w.controlReview});const before=managedMemoryStatus(f.data),r=createMemorySnapshot(f.data,f.snapshot)
 assert.equal(r.controlRegistered,true);assert.ok(existsSync(join(f.snapshot,'control/state.sqlite')));assert.deepEqual(readFileSync(join(f.snapshot,'pin/binding.json')),readFileSync(f.data+'.control-binding.json'));assert.deepEqual(managedMemoryStatus(f.data),before);assert.equal(verifyMemorySnapshot(f.snapshot).verified,true)
 const p2=join(f.snapshot,'control/state.sqlite'),body=readFileSync(p2);body[0]^=1;writeFileSync(p2,body);assert.throws(()=>verifyMemorySnapshot(f.snapshot),/content-mismatch/)
}))
test('running host or writer refuses backup before creating destination',()=>box(f=>{
 text(f.data);for(const name of ['.loaded.json','.write.lock']){writeFileSync(join(f.data,name),JSON.stringify({pid:process.pid,version:'0.20.0'}));assert.throws(()=>createMemorySnapshot(f.data,f.snapshot),/host-or-writer-running/);assert.equal(existsSync(f.snapshot),false);rmSync(join(f.data,name))}
}))
test('invalid lock owner, pending publication and restore journal refuse incomplete snapshots',()=>box(f=>{
 text(f.data);writeFileSync(join(f.data,'.write.lock'),'not JSON');assert.throws(()=>createMemorySnapshot(f.data,f.snapshot),/invalid-owner/);rmSync(join(f.data,'.write.lock'));writeFileSync(join(f.data,'.publication.json'),'{}');assert.throws(()=>createMemorySnapshot(f.data,f.snapshot),/publication-needs-recovery/);rmSync(join(f.data,'.publication.json'));writeFileSync(f.data+'.restore-state.json','{}');assert.throws(()=>createMemorySnapshot(f.data,f.snapshot),/restore-in-progress/);assert.equal(existsSync(f.snapshot),false)
}))
test('source link and hardlink are refused without following or copying their contents',()=>box(f=>{
 text(f.data);const outside=join(f.root,'outside');writeFileSync(outside,'Synthetic external sentinel');symlinkSync(outside,join(f.data,'linked'));assert.throws(()=>createMemorySnapshot(f.data,f.snapshot),/unsafe-file/);rmSync(join(f.data,'linked'));linkSync(outside,join(f.data,'linked'));assert.throws(()=>createMemorySnapshot(f.data,f.snapshot),/unsafe-file/);assert.equal(readFileSync(outside,'utf8'),'Synthetic external sentinel');assert.equal(existsSync(f.snapshot),false)
}))
test('source ancestors and destination ancestors cannot be symlinks',()=>box(f=>{
 text(f.data);const alias=join(f.root,'alias');symlinkSync(f.data,alias);assert.throws(()=>createMemorySnapshot(alias,f.snapshot),/unsafe-directory/);const external=join(f.root,'external');mkdirSync(external);const outAlias=join(f.root,'out-alias');symlinkSync(external,outAlias);assert.throws(()=>createMemorySnapshot(f.data,join(outAlias,'snapshot')),/unsafe-directory/);assert.equal(readdirSync(external).length,0)
}))
test('nested/ancestor destinations and existing directories cannot overwrite originals',()=>box(f=>{
 text(f.data);const before=tree(f.data);for(const to of [f.data,join(f.data,'backup'),f.root,f.data+'.control',join(f.data+'.control','backup')])assert.throws(()=>createMemorySnapshot(f.data,to),/destination-overlaps-source/);mkdirSync(f.snapshot);writeFileSync(join(f.snapshot,'sentinel'),'Synthetic preserved');assert.throws(()=>createMemorySnapshot(f.data,f.snapshot),/destination-exists/);assert.deepEqual(tree(f.data),before);assert.equal(readFileSync(join(f.snapshot,'sentinel'),'utf8'),'Synthetic preserved')
}))
test('source change during copying cannot publish a valid backup manifest',()=>box(f=>{
 text(f.data);assert.throws(()=>createMemorySnapshot(f.data,f.snapshot,{beforeCommit(){writeFileSync(join(f.data,'MEMORY.md'),'Synthetic changed during backup')}}),/source-changed/);assert.equal(existsSync(join(f.snapshot,'manifest.json')),false);assert.throws(()=>verifyMemorySnapshot(f.snapshot),/unsafe-file/)
}))
test('altered, missing and extra backup contents are all rejected',()=>box(f=>{
 text(f.data);createMemorySnapshot(f.data,f.snapshot);const file=join(f.snapshot,'data/MEMORY.md'),original=readFileSync(file);writeFileSync(file,'Synthetic corruption');assert.throws(()=>verifyMemorySnapshot(f.snapshot),/content-mismatch/);writeFileSync(file,original);rmSync(file);assert.throws(()=>verifyMemorySnapshot(f.snapshot),/missing-content/);writeFileSync(file,original);writeFileSync(join(f.snapshot,'extra'),'Synthetic extra');assert.throws(()=>verifyMemorySnapshot(f.snapshot),/extra-content/)
}))
test('manifest path escape, duplicate inventory and tampered counts are rejected',()=>box(f=>{
 text(f.data);createMemorySnapshot(f.data,f.snapshot);const p=join(f.snapshot,'manifest.json'),original=JSON.parse(readFileSync(p));for(const mutate of [m=>m.tree.files[0].path='../../outside',m=>m.tree.files.push(m.tree.files[0]),m=>m.tree.bytes++,m=>m.credentialsIncludedByDesign=true,m=>m.restoreSupported="invalid"]){const m=structuredClone(original);mutate(m);writeFileSync(p,JSON.stringify(m));assert.throws(()=>verifyMemorySnapshot(f.snapshot),/invalid-manifest/)}
}))
test('backup file/manifest links and added directories cannot pass verification',()=>box(f=>{
 text(f.data);createMemorySnapshot(f.data,f.snapshot);const p=join(f.snapshot,'data/MEMORY.md'),original=readFileSync(p),outside=join(f.root,'outside');writeFileSync(outside,original);rmSync(p);symlinkSync(outside,p);assert.throws(()=>verifyMemorySnapshot(f.snapshot),/unsafe-file/);rmSync(p);writeFileSync(p,original);mkdirSync(join(f.snapshot,'data/extra'));assert.throws(()=>verifyMemorySnapshot(f.snapshot),/extra-content/)
}))
test('oversized source file is refused before copying',()=>box(f=>{
 writeFileSync(join(f.data,'large'),Buffer.alloc(SNAPSHOT_LIMITS.fileBytes+1));assert.throws(()=>createMemorySnapshot(f.data,f.snapshot),/unsafe-file/);assert.equal(existsSync(f.snapshot),false)
}))
test('CLI uses no model or installation; verifies in a fresh process and refuses incomplete restore arguments',()=>box(f=>{
 text(f.data);const cli=join(here,'scripts/backup.mjs'),call=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});let r=call(['create','--root',f.data,'--to',f.snapshot]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).verified,true);r=call(['verify','--snapshot',f.snapshot]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).restoreSupported,true);const before=tree(f.snapshot);r=call(['restore']);assert.notEqual(r.status,0);assert.match(r.stderr,/usage:/);assert.deepEqual(tree(f.snapshot),before)
}))
