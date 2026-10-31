#!/usr/bin/env node
/** Reviewed offline data restore; never installs code, rewinds control or calls a model. */
import {resolve,join} from 'node:path'
import {homedir} from 'node:os'
import {createMemorySnapshot,verifyMemorySnapshot} from '../snapshots.mjs'
import {restoreMemorySnapshot,resumeMemoryRestore} from '../restore.mjs'
const args=process.argv.slice(2),command=args.shift()
function option(name){const i=args.indexOf(name);if(i<0)return;const value=args[i+1];if(!value||value.startsWith('--'))throw Error('memory-backup-invalid-option');args.splice(i,2);return value}
function flag(name){const i=args.indexOf(name);if(i<0)return false;args.splice(i,1);return true}
try{
 const root=option('--root'),to=option('--to'),snapshot=option('--snapshot'),reviewed=option('--reviewed'),targetArchive=option('--target-archive'),apply=flag('--apply'),dir=resolve(root??join(process.env.DSH_HOME??join(homedir(),'.dsh'),'memory'))
 if(args.length||command==='create'&&(!to||snapshot||reviewed||targetArchive||apply)||command==='verify'&&(!snapshot||root||to||reviewed||targetArchive||apply)||command==='restore'&&(!snapshot||to||apply!==!!reviewed)||command==='resume'&&(snapshot||to||reviewed||targetArchive)||!['create','verify','restore','resume'].includes(command))throw Error('usage: backup create --to NEW_DIRECTORY [--root MEMORY_ROOT]; verify --snapshot DIRECTORY; restore --snapshot DIRECTORY [--target-archive TGZ] [--apply --reviewed HASH] [--root MEMORY_ROOT]; resume [--apply] [--root MEMORY_ROOT]')
 const value=command==='create'?createMemorySnapshot(dir,resolve(to)):command==='verify'?verifyMemorySnapshot(resolve(snapshot)):command==='restore'?restoreMemorySnapshot(dir,resolve(snapshot),{apply,reviewed,targetArchive}):resumeMemoryRestore(dir,{apply})
 console.log(JSON.stringify(value,null,2))
}catch(error){console.error(/^(?:memory-(?:backup|restore)-[a-z-]+|managed-(?:memory|policy)-[a-z-]+|usage:)/.test(error.message??'')?error.message:'memory-backup-operation-failed');process.exitCode=1}
