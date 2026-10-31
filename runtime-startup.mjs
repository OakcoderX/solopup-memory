/** Startup admission precedes tools and capture; existing data is never guessed empty. */
import {lstatSync,readdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {initializeManagedMemory,managedMemoryStatus,isManagedStore} from './managed-access.mjs'
import {publicationPending} from './publication.mjs'
const cleanCode=error=>/^(?:managed-(?:memory|policy|activation)-|project-store-)[a-z0-9-]+/.exec(error?.message??'')?.[0]??'managed-memory-startup-unavailable'
function empty(root){try{const info=lstatSync(root);if(!info.isDirectory()||info.isSymbolicLink())throw Error('managed-memory-unsafe-root');return readdirSync(root).length===0}catch(error){if(error.code==='ENOENT')return true;throw error}}
export function startManagedRuntime(root){
 root=resolve(root)
 try{
  const status=managedMemoryStatus(root)
  if(status.registered)return{state:'managed',code:'managed-memory-ready',root,created:false}
  if(isManagedStore(root))throw Error('managed-memory-control-missing')
  if(!empty(root))return{state:'migration-required',code:publicationPending(root)?'managed-memory-publication-needs-recovery':'managed-memory-upgrade-required',root,created:false}
  const plan=initializeManagedMemory(root)
  if(!empty(root))return{state:'migration-required',code:'managed-memory-upgrade-required',root,created:false}
  initializeManagedMemory(root,undefined,{apply:true,reviewed:plan.review})
  return{state:'managed',code:'managed-memory-ready',root,created:true}
 }catch(error){return{state:'unavailable',code:cleanCode(error),root,created:false}}
}
export function runtimeSourceControl(startup){
 if(startup.state!=='managed')return{state:startup.state,code:startup.code}
 try{if(!managedMemoryStatus(startup.root).registered)throw Error('managed-memory-control-missing');return{state:'managed',code:'managed-memory-ready'}}catch(error){return{state:'unavailable',code:cleanCode(error)}}
}
export function runtimeNotice(status){if(status.code==='managed-memory-restore-in-progress')return '记忆恢复尚未完成；当前暂停记忆读取、写入和自动记录，请关闭宿主后继续本地恢复。';if(status.code==='managed-memory-publication-needs-recovery')return '记忆库存在中断发布，需先恢复，再完成升级。当前暂停记忆读取、写入和自动记录。';return status.state==='migration-required'?'记忆库需要升级；当前暂停记忆读取、写入和自动记录。请关闭DSH后使用本地记忆升级预览。':'记忆暂不可用；请修复来源控制状态后重启。当前暂停记忆读取和写入。'}
export function runtimeContextNotice(status){return '<memory-store>\n'+runtimeNotice(status)+'\n</memory-store>'}
const sourceSchema={type:'object',additionalProperties:false,required:['state','code'],properties:{state:{type:'string',enum:['managed','migration-required','unavailable']},code:{type:'string'}}}
export function runtimeTool(definition,startup){
 const isStatus=definition.name==='memory_status',guarded={...definition,async execute(args,exec){
  const status=runtimeSourceControl(startup)
  if(status.state!=='managed'){if(isStatus)return{sourceControl:status};throw Error(status.code+': '+runtimeNotice(status))}
  try{const value=await definition.execute(args,exec);return isStatus?{...value,sourceControl:status}:value}catch(error){if(isStatus&&/^(managed-|project-store-)/.test(error?.message??''))return{sourceControl:{state:'unavailable',code:cleanCode(error)}};throw error}
 }}
 if(isStatus)guarded.output={...definition.output,schema:{oneOf:[...(definition.output.schema.oneOf??[definition.output.schema]).map(schema=>({...schema,properties:{...schema.properties,sourceControl:sourceSchema}})),{type:'object',additionalProperties:false,required:['sourceControl'],properties:{sourceControl:sourceSchema}}]},render:(args,value)=>value.sourceControl?.state!=='managed'?[{type:'text',text:runtimeNotice(value.sourceControl)}]:definition.output.render(args,value)}
 return guarded
}
