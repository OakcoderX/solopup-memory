/** Offline, byte-exact memory-domain backups. Verification is integrity, not provenance. */
import {lstatSync,readdirSync,openSync,fstatSync,readFileSync,writeFileSync,closeSync,mkdirSync,constants,existsSync} from 'node:fs'
import {resolve,dirname,join,relative,isAbsolute,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {managedMemoryStatus} from './managed-access.mjs'
import {VERSION} from './version.mjs'
export const SNAPSHOT_LIMITS=Object.freeze({files:16384,bytes:512*1024*1024,fileBytes:16*1024*1024,depth:12,manifestBytes:8*1024*1024})
const hash=b=>createHash('sha256').update(b).digest('hex'),digest=v=>hash(JSON.stringify(v)),fail=code=>{throw Error('memory-backup-'+code)}
const areas=['data','control','pin'],keys=(v,k)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...k].sort().join('|')
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
function stat(path){try{return lstatSync(path)}catch(e){if(e.code==='ENOENT')return;throw e}}
function directory(path){const s=stat(path);if(!s?.isDirectory()||s.isSymbolicLink())fail('unsafe-directory')}
function ancestors(path){for(let p=resolve(path);;p=dirname(p)){if(stat(p))directory(p);if(dirname(p)===p)break}}
function safePath(p,empty=false){return typeof p==='string'&&(empty&&p===''||p.length>0&&p.length<=4096&&!p.includes('\\')&&!/[\u0000-\u001f]/.test(p)&&!isAbsolute(p)&&p.split('/').every(x=>x&&x!=='.'&&x!=='..'))}
function bytes(path,max=SNAPSHOT_LIMITS.fileBytes){
 const before=stat(path);if(!before?.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>max)fail('unsafe-file')
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{const s=fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.ino!==before.ino||s.dev!==before.dev||s.size>max)fail('changed-file');const body=readFileSync(fd),after=fstatSync(fd),now=stat(path);if(body.length!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||now?.ino!==s.ino||now?.dev!==s.dev||now?.isSymbolicLink())fail('changed-file');return body}finally{closeSync(fd)}
}
function stopped(pid){if(!Number.isSafeInteger(pid)||pid<1)fail('invalid-owner');try{process.kill(pid,0);fail('host-or-writer-running')}catch(e){if(e.code!=='ESRCH')throw e}}
function owner(file){let v;try{v=JSON.parse(bytes(file,65536))}catch(e){if(e.message?.startsWith('memory-backup-'))throw e;fail('invalid-owner')};stopped(v.pid)}
function locations(root){return{data:root,control:root+'.control',pin:root+'.control-binding.json'}}
function overlaps(a,b){const p=relative(a,b);return p===''||!isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+sep)}
function separate(root,to){for(const p of Object.values(locations(root)))if(overlaps(p,to)||overlaps(to,p))fail('destination-overlaps-source')}
function inventory(root,{offline=false,dataOnly=false,allowRestore=false}={}){
 ancestors(root);const dirs=[],files=[],present={data:false,control:false,pin:false},paths=locations(root);let size=0
 const add=(area,path,file)=>{const body=bytes(file);size+=body.length;if(files.length>=SNAPSHOT_LIMITS.files||size>SNAPSHOT_LIMITS.bytes)fail('capacity');files.push({area,path,bytes:body.length,sha256:hash(body)})}
 const walk=(area,dir,prefix='',depth=0)=>{
  if(depth>SNAPSHOT_LIMITS.depth||dirs.length>=SNAPSHOT_LIMITS.files)fail('capacity');directory(dir);dirs.push({area,path:prefix})
  const names=readdirSync(dir).sort();if(names.length>SNAPSHOT_LIMITS.files)fail('capacity')
  for(const name of names){if(!safePath(name)||name.includes('/'))fail('unsafe-name');const path=prefix?prefix+'/'+name:name,file=join(dir,name),s=stat(file);if(s?.isDirectory()&&!s.isSymbolicLink()){walk(area,file,path,depth+1);continue}
   if(offline&&name==='.publication.json')fail('publication-needs-recovery')
   if(offline&&(name==='.write.lock'||area==='data'&&name==='.loaded.json'))owner(file)
   add(area,path,file)
  }
 }
 for(const area of dataOnly?['data']:areas){const p=paths[area];ancestors(dirname(p));present[area]=!!stat(p);if(!present[area])continue;if(area==='pin')add(area,'binding.json',p);else walk(area,p)}
 if(!present.data)fail('source-missing')
 if(offline&&!allowRestore&&stat(root+'.restore-state.json'))fail('restore-in-progress')
 return{present,dirs,files,bytes:size}
}
/** Internal shared byte/path checks; not an additional model-facing surface. */
export const snapshotIO={stat,bytes,ancestors,directory,inventory,sourceFile,validate,hash,digest,control,separate,owner}
function sourceFile(root,row){return row.area==='pin'?root+'.control-binding.json':join(locations(root)[row.area],row.path)}
function control(root){const s=managedMemoryStatus(root);return{registered:s.registered,installationId:s.installationId??null,revision:s.controlRevision??null}}
function sourceVersion(root){const p=join(root,'.loaded.json');if(!stat(p))return null;let v;try{v=JSON.parse(bytes(p,65536))}catch{fail('invalid-owner')};return typeof v.version==='string'&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v.version)?v.version:null}
/** Destination must not exist. Incomplete copies have no valid manifest and remain for inspection. */
export function createMemorySnapshot(root,to,{beforeCommit}={}){
 root=resolve(root);to=resolve(to);separate(root,to);ancestors(dirname(to));if(stat(to))fail('destination-exists')
 const state=control(root),tree=inventory(root,{offline:true}),version=sourceVersion(root)
 mkdirSync(to,{mode:0o700});for(const area of areas)mkdirSync(join(to,area),{mode:0o700})
 for(const row of tree.dirs)if(row.path)mkdirSync(join(to,row.area,row.path),{recursive:true,mode:0o700})
 for(const row of tree.files){const body=bytes(sourceFile(root,row));if(hash(body)!==row.sha256)fail('source-changed');writeFileSync(join(to,row.area,row.path),body,{mode:0o600,flag:'wx'})}
 beforeCommit?.()
 if(digest(inventory(root,{offline:true}))!==digest(tree)||digest(control(root))!==digest(state))fail('source-changed')
 const manifest={schema:1,kind:'dsh-memory-offline-snapshot',createdAt:new Date().toISOString(),createdWithVersion:VERSION,sourceRoot:root,sourceVersion:version,control:state,tree,scope:'memory-data-control-and-binding-only',credentialsIncludedByDesign:false,restoreSupported:true}
 const text=JSON.stringify(manifest,null,2)+'\n';if(Buffer.byteLength(text)>SNAPSHOT_LIMITS.manifestBytes)fail('capacity')
 writeFileSync(join(to,'manifest.json'),text,{mode:0o600,flag:'wx'})
 return verifyMemorySnapshot(to)
}
function validate(m){
 if(!keys(m,['schema','kind','createdAt','createdWithVersion','sourceRoot','sourceVersion','control','tree','scope','credentialsIncludedByDesign','restoreSupported'])||m.schema!==1||m.kind!=='dsh-memory-offline-snapshot'||m.scope!=='memory-data-control-and-binding-only'||m.credentialsIncludedByDesign!==false||typeof m.restoreSupported!=='boolean'||typeof m.createdAt!=='string'||Number.isNaN(Date.parse(m.createdAt))||typeof m.createdWithVersion!=='string'||typeof m.sourceRoot!=='string'||!isAbsolute(m.sourceRoot)||resolve(m.sourceRoot)!==m.sourceRoot||m.sourceVersion!==null&&typeof m.sourceVersion!=='string')fail('invalid-manifest')
 if(!keys(m.control,['registered','installationId','revision'])||typeof m.control.registered!=='boolean'||m.control.installationId!==null&&typeof m.control.installationId!=='string'||m.control.revision!==null&&!hex(m.control.revision))fail('invalid-manifest')
 const t=m.tree;if(!keys(t,['present','dirs','files','bytes'])||!keys(t.present,areas)||areas.some(a=>typeof t.present[a]!=='boolean')||!t.present.data||!Array.isArray(t.dirs)||t.dirs.length>SNAPSHOT_LIMITS.files||!Array.isArray(t.files)||t.files.length>SNAPSHOT_LIMITS.files||!Number.isSafeInteger(t.bytes)||t.bytes<0||t.bytes>SNAPSHOT_LIMITS.bytes)fail('invalid-manifest')
 const seen=new Set();for(const row of t.dirs){if(!keys(row,['area','path'])||!['data','control'].includes(row.area)||!safePath(row.path,true)||row.path.split('/').length>SNAPSHOT_LIMITS.depth+1||!t.present[row.area]||seen.has(row.area+'/'+row.path))fail('invalid-manifest');seen.add(row.area+'/'+row.path)}
 seen.clear();for(const row of t.files){if(!keys(row,['area','path','bytes','sha256'])||!areas.includes(row.area)||!safePath(row.path)||!t.present[row.area]||row.area==='pin'&&row.path!=='binding.json'||!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>SNAPSHOT_LIMITS.fileBytes||!hex(row.sha256)||seen.has(row.area+'/'+row.path))fail('invalid-manifest');seen.add(row.area+'/'+row.path)}
 if(t.bytes!==t.files.reduce((n,f)=>n+f.bytes,0))fail('invalid-manifest');return m
}
/** No writes; rejects missing/extra files, path escapes, links and altered binary control data. */
export function verifyMemorySnapshot(snapshot){
 snapshot=resolve(snapshot);ancestors(snapshot);directory(snapshot);let m;const raw=bytes(join(snapshot,'manifest.json'),SNAPSHOT_LIMITS.manifestBytes);try{m=JSON.parse(raw)}catch{fail('invalid-manifest')};validate(m)
 const expectedDirs=new Set(['data','control','pin',...m.tree.dirs.filter(r=>r.path).map(r=>r.area+'/'+r.path)]),expectedFiles=new Map(m.tree.files.map(r=>[r.area+'/'+r.path,r])),found=new Set(),foundDirs=new Set();let total=0
 const walk=(dir,prefix='',depth=0)=>{if(depth>SNAPSHOT_LIMITS.depth+2)fail('capacity');for(const name of readdirSync(dir).sort()){const path=prefix?prefix+'/'+name:name,file=join(dir,name),s=stat(file);if(s?.isDirectory()&&!s.isSymbolicLink()){if(!expectedDirs.has(path))fail('extra-content');foundDirs.add(path);walk(file,path,depth+1);continue}if(path==='manifest.json')continue;const row=expectedFiles.get(path);if(!row)fail('extra-content');const body=bytes(file);if(body.length!==row.bytes||hash(body)!==row.sha256)fail('content-mismatch');found.add(path);total+=body.length}}
 walk(snapshot);if(found.size!==expectedFiles.size||foundDirs.size!==expectedDirs.size||total!==m.tree.bytes)fail('missing-content')
 return{verified:true,manifestSha256:hash(raw),snapshot,sourceRoot:m.sourceRoot,sourceVersion:m.sourceVersion,files:found.size,bytes:total,controlRegistered:m.control.registered,scope:m.scope,integrityOnly:true,restoreSupported:true}
}
