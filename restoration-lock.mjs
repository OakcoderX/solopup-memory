/** Presence, even a corrupt/dangling journal, blocks cooperating product access. */
import {lstatSync} from 'node:fs'
import {resolve} from 'node:path'
const permits=new Set()
export const restorationJournalPath=root=>resolve(root)+'.restore-state.json'
export function restorationPending(root){try{lstatSync(restorationJournalPath(root));return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
export function assertRestorationInactive(root){if(!permits.has(resolve(root))&&restorationPending(root))throw Error('managed-memory-restore-in-progress')}
/** Synchronous local maintenance only; never a model tool or a cross-process grant. */
export function withRestorationPermit(root,run){root=resolve(root);if(permits.has(root))throw Error('managed-memory-nested-restore');permits.add(root);try{const value=run();if(value&&typeof value.then==='function')throw Error('managed-memory-async-restore');return value}finally{permits.delete(root)}}
