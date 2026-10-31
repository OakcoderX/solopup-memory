/** One model-returned data submission; this module never dispatches tools. */
import {isDeepStrictEqual} from 'node:util'
import {MEANING_SCHEMA} from './meaning.mjs'
import {CAPTURE_RESPONSE_BYTES,parseCaptureBatch} from './capture-diagnostics.mjs'
export const CAPTURE_SUBMISSION_NAME='submit_memory_candidates'
export const CAPTURE_SUBMISSION_TOOL={
 name:CAPTURE_SUBMISSION_NAME,
 description:'提交本次记忆候选。只调用一次；没有值得记忆的内容时entries=[]。这是数据提交，不执行文件、网络或其他动作。不要附解释文字。',
 parameters:{type:'object',additionalProperties:false,required:['entries'],properties:{entries:{type:'array',maxItems:64,items:{type:'object',additionalProperties:false,required:['type','summary','scope','basis','evidence','meaning'],properties:{type:{type:'string',enum:['user','feedback','project','reference']},summary:{type:'string'},detail:{type:'string'},expires:{type:'string'},scope:{type:'string',enum:['global','project']},basis:{type:'string',enum:['explicit','inferred']},evidence:{type:'array',items:{type:'object',additionalProperties:false,required:['messageId','quote'],properties:{messageId:{type:'string'},quote:{type:'string'}}}},meaning:structuredClone(MEANING_SCHEMA),supersedes:{type:'string'},revisionMode:{type:'string',enum:['value','replace']}}}}}},
}
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
freeze(CAPTURE_SUBMISSION_TOOL)
const invalid=()=>{throw Error('capture-invalid-envelope')}
/** Inspect the documented canonical block protocol, bounding deltas before retention.
 * Invalid small envelopes are rejected after settlement, never retried or mined.
 */
export class CaptureSubmission {
 constructor({name=CAPTURE_SUBMISSION_NAME}={}){this.name=name;this.bytes=0;this.sawTool=false;this.frame=undefined;this.error=false;this.finish=undefined;this.finalTextBlocks=[];this.textBytes=0;this.finalTextBytes=0}
 observe(chunk,textDelta=''){
  const delta=chunk?.type==='tool-call-delta'?chunk.argumentsDelta:''
  this.textBytes+=Buffer.byteLength(textDelta)
  this.bytes+=Buffer.byteLength(textDelta)+Buffer.byteLength(typeof delta==='string'?delta:'')
  if(this.bytes>CAPTURE_RESPONSE_BYTES)throw Error('capture-response-too-large')
  if(this.finish!==undefined){this.error=true;return}
  if(chunk?.type==='finish'){this.finish=chunk.reason?.kind;return}
  if(chunk?.type==='block-start'&&chunk.blockType==='tool-call'){
   this.sawTool=true
   if(this.frame||!Number.isInteger(chunk.index)||chunk.index<0||chunk.index>7){this.error=true;return}
   this.frame={index:chunk.index,args:'',id:undefined,name:undefined,complete:false,sawDelta:false};return
  }
  if(chunk?.type==='tool-call-delta'){
   this.sawTool=true;const f=this.frame
   if(!f||f.complete||chunk.index!==f.index||typeof delta!=='string'||typeof chunk.id!=='string'||!chunk.id||chunk.id.length>300||f.id!==undefined&&chunk.id!==f.id||chunk.name!==undefined&&(typeof chunk.name!=='string'||f.name!==undefined&&chunk.name!==f.name)){this.error=true;return}
   f.id=chunk.id;if(chunk.name!==undefined)f.name=chunk.name
   f.sawDelta=true;f.args+=delta;return
  }
  if(chunk?.type==='block-end'){
   const block=chunk.block
   if(block?.type==='text'&&typeof block.text==='string'&&block.text.trim()){this.finalTextBytes+=Buffer.byteLength(block.text);if(this.bytes-this.textBytes+Math.max(this.textBytes,this.finalTextBytes)>CAPTURE_RESPONSE_BYTES||this.finalTextBlocks.length>=8)throw Error('capture-response-too-large');this.finalTextBlocks.push(block.text)}
   if(block?.type!=='tool-call')return
   this.sawTool=true;const f=this.frame
   if(!f||f.complete||chunk.index!==f.index||block.name!==this.name||f.name!==undefined&&block.name!==f.name||typeof block.id!=='string'||!block.id||block.id.length>300||f.id!==undefined&&block.id!==f.id||typeof block.arguments!=='string'||f.sawDelta&&block.arguments!==f.args){this.error=true;return}
   if(!f.sawDelta){this.bytes+=Buffer.byteLength(block.arguments);if(this.bytes>CAPTURE_RESPONSE_BYTES)throw Error('capture-response-too-large');f.args=block.arguments}
   f.complete=true
  }
 }
 /** Strict object contract for dedicated tasks; no legacy arrays or prose mining. */
 objectPayload(text){
  if(this.sawTool&&(this.error||!this.frame?.complete||this.finish!=='tool-calls'))invalid()
  let payload;try{payload=JSON.parse(this.sawTool?this.frame.args:text)}catch{throw Error('capture-invalid-json')}
  if(!payload||Array.isArray(payload)||typeof payload!=='object')invalid()
  if(this.sawTool){
   const finalText=this.finalTextBlocks.join('');if(finalText&&text&&finalText!==text)invalid()
   const copy=text.trim()?text:finalText
   if(copy.trim()){let repeated;try{repeated=JSON.parse(copy)}catch{invalid()}if(!isDeepStrictEqual(repeated,payload))invalid()}
  }
  return payload
 }
 batch(text,maxEntries){
  if(!this.sawTool)return parseCaptureBatch(text,maxEntries)
  if(this.error||!this.frame?.complete||this.finish!=='tool-calls')invalid()
  let payload;try{payload=JSON.parse(this.frame.args)}catch{throw Error('capture-invalid-json')}
  if(!payload||Array.isArray(payload)||typeof payload!=='object'||Object.keys(payload).join('|')!=='entries'||!Array.isArray(payload.entries))invalid()
  // An optional textual copy must itself be exact JSON and deeply identical.
  // No fence/prose extraction or field repair is performed in this dual form.
  const finalText=this.finalTextBlocks.join('')
  if(finalText&&text&&finalText!==text)invalid()
  const copy=text.trim()?text:finalText
  if(copy.trim()){
   let repeated;try{repeated=JSON.parse(copy)}catch{invalid()}
   if(!Array.isArray(repeated)||!isDeepStrictEqual(repeated,payload.entries))invalid()
  }
  return parseCaptureBatch(JSON.stringify(payload.entries),maxEntries)
 }
}
