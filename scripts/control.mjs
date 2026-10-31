#!/usr/bin/env node
/** Offline control activation and resumable cleanup. Preview by default. */
import {resolve,join} from 'node:path'
import {homedir} from 'node:os'
import {readSafely} from '../security.mjs'
import {activateManagedMemory,activationInventory} from '../managed-activation.mjs'
import {managedMemoryStatus,withdrawManagedSourceKey} from '../index.mjs'
const args=process.argv.slice(2),command=args.shift()??'status'
function option(name){const i=args.indexOf(name);if(i<0)return;const value=args[i+1];if(!value||value.startsWith('--'))throw Error(name+' requires a value');args.splice(i,2);return value}
function flag(name){const i=args.indexOf(name);if(i<0)return false;args.splice(i,1);return true}
try{
 const root=resolve(option('--root')??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'memory')),storesFile=option('--stores-file'),reviewed=option('--reviewed'),operationId=option('--operation'),apply=flag('--apply'),importLegacy=flag('--import-legacy')
 if(args.length||!['inventory','status','initialize','resume'].includes(command)||command!=='initialize'&&(storesFile!==undefined||reviewed!==undefined||importLegacy)||command!=='resume'&&operationId!==undefined||['status','inventory'].includes(command)&&apply||command==='resume'&&!operationId)throw Error('usage: control inventory/status; initialize [--stores-file JSON] [--import-legacy] [--apply --reviewed HASH]; resume --operation ID [--apply]; optional --root PATH')
 let result
 if(command==='inventory')result=activationInventory(root)
 else if(command==='status')result=managedMemoryStatus(root)
 else if(command==='initialize'){
  let stores;if(storesFile!==undefined){const raw=readSafely(resolve(storesFile),{maxBytes:65536});if(raw===undefined)throw Error('managed-activation-stores-file-missing');stores=JSON.parse(raw)}
  result=activateManagedMemory(root,{stores,reviewed,apply,importLegacy})
 }else{
  const status=managedMemoryStatus(root),op=status.operations?.find(row=>row.id===operationId);if(!op)throw Error('managed-activation-operation-not-found')
  result=withdrawManagedSourceKey(root,op.source,{operationId,apply})
 }
 console.log(JSON.stringify(result,null,2))
}catch(error){console.error(error.message);process.exitCode=1}
