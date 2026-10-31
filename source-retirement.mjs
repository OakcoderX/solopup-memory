/** Compact inactive provenance, retaining revocation roots and exact projection footprints. */
import {createHash} from 'node:crypto'
import {readdirSync} from 'node:fs'
import {join} from 'node:path'
import {readSafely,normalizeText,entryId} from './security.mjs'

export const SOURCE_LEDGER_BYTES = 2 * 1024 * 1024
export const SOURCE_RECORD_LIMIT = 512
export const RETIRED_SOURCE_LIMIT = 4096
export const PENDING_CANDIDATE_LIMIT = 200
const hash=value=>createHash('sha256').update(value).digest('hex')
const seal=value=>hash(JSON.stringify(value))
const digest=/^[a-f0-9]{64}$/
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
const origins=['tool-context','quoted-extraction','reviewed-adoption']
const types=['user','feedback','project','reference']

export function validateRetiredSource(input){
 if(!input||input.status!=='retired'||!digest.test(input.id)||!origins.includes(input.origin)||!types.includes(input.type)||!['global','project'].includes(input.scope)||input.type==='project'&&input.scope!=='project'||!digest.test(input.lineHash)||!/^\w{8}$/.test(input.memoryId)||!/^[a-f0-9]{8}$/.test(input.memoryId)||!iso(input.retiredAt))throw Error('candidate-corrupt-retired-source')
 if(!Array.isArray(input.sources)||input.sources.length<1||input.sources.length>(input.observationHash===undefined?3:5)||input.sources.some(s=>!digest.test(s))||JSON.stringify([...new Set(input.sources)].sort())!==JSON.stringify(input.sources))throw Error('candidate-corrupt-retired-source')
 const result={id:input.id,status:'retired',origin:input.origin,type:input.type,scope:input.scope,sources:input.sources,lineHash:input.lineHash,memoryId:input.memoryId,retiredAt:input.retiredAt}
 if(input.observationHash!==undefined){if(!digest.test(input.observationHash)||input.origin!=='tool-context')throw Error('candidate-corrupt-retired-source');result.observationHash=input.observationHash}
 if(input.invocationHash!==undefined){if(!digest.test(input.invocationHash)||input.origin==='reviewed-adoption')throw Error('candidate-corrupt-retired-source');result.invocationHash=input.invocationHash}
 if(input.block!==undefined){const b=input.block;if(!b||b.id!==input.id||!digest.test(b.hash)||!Number.isSafeInteger(b.length)||b.length<1||b.length>=6000||Object.keys(b).sort().join('|')!=='hash|id|length')throw Error('candidate-corrupt-retired-source');result.block={id:b.id,length:b.length,hash:b.hash}}
 if(input.receiptHash!==seal(result)||Object.keys(input).sort().join('|')!==[...Object.keys(result),'receiptHash'].sort().join('|'))throw Error('candidate-corrupt-retired-source')
 return{...result,receiptHash:input.receiptHash}
}

/** Delete only an exact, uniquely marked canonical block, never guessed matching prose. */
export function removeRetiredBlock(body,receipt){
 if(receipt.block===undefined)return body
 const marker=`[candidate:${receipt.id}]\n`,start=body.indexOf(marker)
 if(start<0)return body
 const {length}=receipt.block,header=body.lastIndexOf('\n- ',start)
 if(body.indexOf(marker,start+marker.length)>=0||hash(body.slice(start,start+length))!==receipt.block.hash||header<0||!/^\n- \d{4}-\d\d-\d\d｜$/.test(body.slice(header,start))||body[start+length]!=='\n')throw Error('candidate-retirement-detail-diverged')
 return body.slice(0,header)+'\n'+body.slice(start+length+1)
}

function makeReceipt(record){
 const sourced=['tool-context','quoted-extraction'].includes(record.origin)
 const lineHash=sourced?hash(normalizeText(record.indexLine).trim()):record.adoption?.lineHash
 if(!digest.test(lineHash))return undefined // Legacy adoption has no exact line proof: retain it.
 const receipt={id:record.id,status:'retired',origin:sourced?record.origin:'reviewed-adoption',type:record.type,scope:record.scope,sources:record.sources,lineHash,memoryId:sourced?entryId(record.indexLine):record.adoption.memoryId,retiredAt:new Date().toISOString()}
 if(record.observation)receipt.observationHash=seal(record.observation)
 if(sourced)receipt.invocationHash=record.callHash
 if(record.detail!==undefined){const text=`[candidate:${record.id}]\n${record.detail}`;receipt.block={id:record.id,length:text.length,hash:hash(text)}}
 receipt.receiptHash=seal(receipt)
 return validateRetiredSource(receipt)
}

/** Caller owns the local publication lock; returns topic after-images, performs no writes. */
export function prepareSourceRetirement(dir,state,{indexText,force=false}={}){
 if(!force&&state.records.length<160&&Buffer.byteLength(JSON.stringify(state))<320*1024)return[]
 const index=indexText??readSafely(join(dir,'MEMORY.md'))??'',live=new Set(index.split(/\r?\n/).filter(line=>line.trim().startsWith('- [')).map(line=>hash(normalizeText(line).trim()))),liveIds=new Set(index.split(/\r?\n/).filter(line=>line.trim().startsWith('- [')).map(line=>entryId(line.trim())))
 const files=readdirSync(dir);if(files.length>2048)throw Error('candidate-retirement-directory-limit')
 const eligible=state.records.flatMap(record=>{
  if(!['recorded','superseded','adopted'].includes(record.status))return[]
  const receipt=makeReceipt(record);if(!receipt)return[]
  if(record.status!=='superseded'&&(live.has(receipt.lineHash)||liveIds.has(receipt.memoryId)))return[]
  // Unknown topic archives remain full records until archive coverage is implemented.
  if(receipt.block&&files.some(name=>name.startsWith(record.type+'.archive-')))return[]
  return[receipt]
 })
 const selected=force?eligible:eligible.slice(0,Math.max(0,eligible.length-12))
 if(!selected.length)return[]
 if(state.retired.length+selected.length>RETIRED_SOURCE_LIMIT)throw Error('candidate-retirement-capacity')
 const topics=new Map(),ids=new Set(selected.map(r=>r.id))
 for(const receipt of selected){
  if(!receipt.block)continue
  const name=receipt.type+'.md',body=topics.has(name)?topics.get(name):readSafely(join(dir,name))
  if(body===undefined)continue
  const next=removeRetiredBlock(body,receipt);if(next!==body)topics.set(name,next)
 }
 state.schema=Math.max(state.schema,3);state.records=state.records.filter(record=>!ids.has(record.id));state.retired.push(...selected)
 return[...topics].map(([name,text])=>({name,text}))
}
