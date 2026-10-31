/** Local activation review. Existing project directories must all be declared. */
import {readdirSync,lstatSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {readSafely} from './security.mjs'
import {initializeManagedMemory} from './managed-access.mjs'
const fail=code=>{throw Error('managed-activation-'+code)}
function directory(path){try{const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())fail('unsafe-directory');return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
export function activationInventory(root){
 root=resolve(root);directory(root);const projects=join(root,'projects'),names=[]
 if(directory(projects))for(const name of readdirSync(projects).sort()){
  const path=join(projects,name)
  if(name==='.legacy-claims'){directory(path);continue}
  if(name.startsWith('.migration-'))fail('project-migration-needs-recovery')
  if(name.startsWith('.')||!directory(path))fail('unknown-project-entry')
  names.push('projects/'+name);if(names.length>127)fail('too-many-stores')
 }
 return{projectStores:names,projectDeclarationsRequired:names.length>0}
}
export function activationStores(root,declared){
 const {projectStores:names}=activationInventory(root)
 if(declared===undefined){if(names.length)fail('project-declarations-required');return[{name:'.',role:'global'}]}
 if(!Array.isArray(declared)||!declared.some(row=>row?.name==='.')||names.some(name=>!declared.some(row=>row?.name===name)))fail('incomplete-project-declarations')
 return declared
}
export function assertActivationHostStopped(root){
 const raw=readSafely(join(root,'.loaded.json'),{maxBytes:65536});if(raw===undefined)return
 let marker;try{marker=JSON.parse(raw)}catch{fail('invalid-host-marker')}
 if(!Number.isSafeInteger(marker?.pid)||marker.pid<1)fail('invalid-host-marker')
 try{process.kill(marker.pid,0);fail('host-must-stop-before-activation')}catch(error){if(error.code!=='ESRCH')throw error}
}
export function activateManagedMemory(root,{stores,apply=false,reviewed,importLegacy=false}={}){
 root=resolve(root);if(typeof apply!=='boolean'||typeof importLegacy!=='boolean')fail('invalid-options')
 const rows=activationStores(root,stores)
 if(apply)assertActivationHostStopped(root)
 return initializeManagedMemory(root,rows,{apply,reviewed,importLegacy})
}
