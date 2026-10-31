/** Host-observed execution output. A checked quote is not a verified world fact. */
import {createHash} from 'node:crypto'
import {normalizeText,escapeFraming,findSecrets} from './security.mjs'
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const id=value=>typeof value==='string'&&value.length>0&&value.length<=300&&!/[\u0000-\u001f]/.test(value)
const seq=value=>Number.isSafeInteger(value)&&value>0
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const fail=reason=>{const error=Error('memory-observation-'+reason);error.code=error.message;throw error}
const toolName=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_.:/-]{0,199}$/.test(value)&&!value.startsWith('memory_')
const keys=['schema','kind','sessionId','toolName','callId','callSeq','resultSeq','resultMessageId','argumentsHash','outputHash','quote','outcome','observedAt']
export function normalizeObservationCertificate(input,sessionId){
 if(!plain(input)||Object.keys(input).sort().join('|')!==[...keys].sort().join('|')||input.schema!==1||input.kind!=='native-tool-result'||!id(input.sessionId)||input.sessionId!==sessionId||!toolName(input.toolName)||!id(input.callId)||!seq(input.callSeq)||!seq(input.resultSeq)||input.callSeq>=input.resultSeq||!id(input.resultMessageId)||!hex(input.argumentsHash)||!hex(input.outputHash)||!['succeeded','error'].includes(input.outcome)||!iso(input.observedAt))fail('invalid-certificate')
 const quote=typeof input.quote==='string'?escapeFraming(normalizeText(input.quote).trim()):''
 if(!quote||quote.length>500||findSecrets(quote).length||quote!==input.quote)fail('invalid-quote')
 return Object.fromEntries(keys.map(key=>[key,input[key]]))
}
/** Control roots include both execution events, not only the request to save a memory. */
export function observationRoots(certificate){return[certificate.callSeq,certificate.resultSeq].map(at=>hash([certificate.sessionId,certificate.sessionId+':'+at]))}
/** Identical arguments and output do not become new evidence on every read. */
export function observationIdentity(certificate){return hash([certificate.toolName,certificate.argumentsHash,certificate.outputHash])}
export function argumentFingerprint(input){
 let value=input
 if(typeof input==='string'){try{value=JSON.parse(input)}catch{return hash(['raw-arguments',input])}}
 let nodes=0
 const canonical=(value,depth=0)=>{
  if(++nodes>2000||depth>12)fail('arguments-too-complex')
  if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))return value
  if(Array.isArray(value)){if(value.length>256)fail('arguments-too-complex');return value.map(item=>canonical(item,depth+1))}
  if(plain(value)){if(Object.keys(value).length>128)fail('arguments-too-complex');return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key],depth+1)]))}
  fail('invalid-arguments')
 }
 return hash(['json-arguments',canonical(value)])
}
function textOf(message){
 if(!Array.isArray(message?.content)||!message.content.length||message.content.length>32||message.content.some(block=>block?.type!=='text'||typeof block.text!=='string'))return undefined
 const text=message.content.map(block=>block.text).join('\n')
 if(Buffer.byteLength(text)>16384||findSecrets(normalizeText(text)).length)return undefined
 return normalizeText(text)
}
function matches(message,result){return message?.role==='tool'&&message.source?.kind==='tool'&&message.source.callId===result.call.callId&&message.toolCallId===result.call.callId&&message.id===result.messageId&&message.isError===result.isError&&hash(message.content)===result.outputHash}
export function createObservationTracker(ownerForCall){
 const states=new WeakMap(),sessions=new Map()
 let active=true
 function stateFor(session){let state=states.get(session);if(!state){state={calls:new Map(),results:new Map(),visible:new Map(),position:null};states.set(session,state)}return state}
 function preStep(input){const session=input?.agent?.session;if(!session||!id(session.id)||!seq(input.turn)||!seq(input.step))return;const state=stateFor(session);state.position={turn:input.turn,step:input.step};state.visible.clear();sessions.set(session.id,new WeakRef(session));while(sessions.size>256)sessions.delete(sessions.keys().next().value)}
 function event(session,event){
  if(!session||!id(session.id)||!seq(event?.seq))return
  const state=stateFor(session),data=event.data
  if(event.surfaceOp&&typeof event.surfaceOp==='object'){
   const op=event.surfaceOp
   for(const result of state.results.values())if(op.op==='replace'&&result.seq>=op.startSeq&&result.seq<=op.endSeq)result.invalid=true
  }
  if(event.type==='tool/call'){
   if(!id(data?.callId)||!seq(data.turn)||!seq(data.step))return
   if(state.calls.has(data.callId)){state.calls.get(data.callId).ambiguous=true;return}
   let owner,argumentsHash
   try{const raw=JSON.stringify(data.arguments);if(typeof raw!=='string'||Buffer.byteLength(raw)>32768||findSecrets(normalizeText(raw)).length)throw Error();argumentsHash=argumentFingerprint(data.arguments);owner=ownerForCall(session,data.callId)}catch{}
   state.calls.set(data.callId,{callId:data.callId,name:data.name,seq:event.seq,turn:data.turn,step:data.step,owner,argumentsHash})
   while(state.calls.size>256)state.calls.delete(state.calls.keys().next().value)
  }else if(event.type==='tool/result'){
   const message=data?.message,call=state.calls.get(message?.toolCallId)
   if(!call)return
   if(state.results.has(call.callId)){state.results.get(call.callId).invalid=true;return}
   const text=textOf(message),valid=event.surfaceOp==='append'&&Array.isArray(event.sourceEventSeqs)&&event.sourceEventSeqs.length===1&&event.sourceEventSeqs[0]===call.seq&&call.seq<event.seq&&data.turn===call.turn&&data.step===call.step&&message.role==='tool'&&message.source?.kind==='tool'&&message.source.callId===call.callId&&id(message.id)&&[true,false,undefined].includes(message.isError)&&(!data.error||message.isError===true)&&text!==undefined
   state.results.set(call.callId,{call,seq:event.seq,messageId:message?.id,outputHash:hash(message?.content??null),isError:message?.isError,text,observedAt:new Date().toISOString(),invalid:!valid})
   while(state.results.size>64)state.results.delete(state.results.keys().next().value)
  }
 }
 function request(request){
  if(!Array.isArray(request?.tools)||!request.tools.some(tool=>tool?.name==='memory_write'))return
  const session=sessions.get(request.sessionId)?.deref(),state=session&&states.get(session)
  if(!state)return
  state.visible.clear()
  if(request.signal?.aborted||!Array.isArray(request.messages)||request.messages.length>4096)return
  for(const result of state.results.values())if(!result.invalid&&request.messages.filter(message=>matches(message,result)).length===1)state.visible.set(result.call.callId,state.position)
 }
 function forExecution(exec,reference,currentOwner){
  exec?.signal?.throwIfAborted()
  if(!active)fail('disposed')
  if(!plain(reference)||Object.keys(reference).sort().join('|')!=='callId|quote'||!id(reference.callId)||typeof reference.quote!=='string')fail('invalid-reference')
  const session=exec?.agent?.session,state=session&&states.get(session),current=state?.calls.get(exec?.rootCallId??exec?.callId),result=state?.results.get(reference.callId),seen=state?.visible.get(reference.callId)
  if(!currentOwner||!current||!result||result.invalid||result.call.ambiguous||!result.call.owner||!result.call.argumentsHash||!toolName(result.call.name)||result.seq>=current.seq||!seen||seen.turn!==current.turn||seen.step!==current.step||typeof session.deriveMessages!=='function')fail('source-unavailable')
  const currentMessages=session.deriveMessages();if(!Array.isArray(currentMessages)||currentMessages.length>4096||currentMessages.filter(message=>matches(message,result)).length!==1)fail('surface-changed')
  const quote=normalizeText(reference.quote).trim();if(!quote||quote.length>500||!result.text.includes(quote)||findSecrets(quote).length)fail('quote-not-in-result')
  const certificate=normalizeObservationCertificate({schema:1,kind:'native-tool-result',sessionId:session.id,toolName:result.call.name,callId:result.call.callId,callSeq:result.call.seq,resultSeq:result.seq,resultMessageId:result.messageId,argumentsHash:result.call.argumentsHash,outputHash:result.outputHash,quote:escapeFraming(quote),outcome:result.isError===true?'error':'succeeded',observedAt:result.observedAt},session.id)
  return{...currentOwner,evidence:result.call.owner.evidence,observation:certificate,observationContextHash:result.call.owner.contextCwdHash}
 }
 function availableForExecution(exec){
  exec?.signal?.throwIfAborted()
  if(!active)fail('disposed')
  const session=exec?.agent?.session,state=session&&states.get(session),current=state?.calls.get(exec?.rootCallId??exec?.callId)
  if(!state||!current||typeof session.deriveMessages!=='function')fail('source-unavailable')
  const messages=session.deriveMessages();if(!Array.isArray(messages)||messages.length>4096)fail('surface-changed')
  const eligible=[...state.results.values()].filter(result=>{
   const seen=state.visible.get(result.call.callId)
   return !result.invalid&&!result.call.ambiguous&&result.call.owner&&result.call.argumentsHash&&toolName(result.call.name)&&result.seq<current.seq&&seen?.turn===current.turn&&seen.step===current.step&&messages.filter(message=>matches(message,result)).length===1
  }).sort((a,b)=>b.seq-a.seq)
  const items=[];let bytes=0
  for(const result of eligible.slice(0,8)){const item={callId:result.call.callId,toolName:result.call.name,outcome:result.isError===true?'error':'succeeded',quotePreview:escapeFraming(result.text.slice(0,100)),observedAt:result.observedAt};const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>2400)break;items.push(item);bytes+=size}
  return{items,truncated:eligible.length>items.length,note:'仅本会话当前可引用的原生输出；复制callId与实际引用，不猜ID。成功不证明世界事实；错误结果只能作诊断。'}
 }
 function disposeSession(session){states.delete(session);if(sessions.get(session.id)?.deref()===session)sessions.delete(session.id)}
 function dispose(){active=false;sessions.clear()}
 return{preStep,event,request,forExecution,availableForExecution,disposeSession,dispose}
}
export function observationView(record){
 if(!record.observation)return undefined
 const proof=normalizeObservationCertificate(record.observation,record.sessionId)
 return{kind:proof.kind,toolName:proof.toolName,callId:proof.callId,resultEventId:proof.sessionId+':'+proof.resultSeq,observedAt:proof.observedAt,outcome:proof.outcome,quote:proof.quote,outputHash:proof.outputHash,quoteChecked:true,currentWorldStateVerified:false,continuouslyRevalidated:false}
}
export const OBSERVATION_REFERENCE_SCHEMA={type:'object',additionalProperties:false,required:['callId','quote'],properties:{callId:{type:'string',description:'先调用memory_status(includeObservations=true)取得并逐字复制真实callId；模型不应猜测传输层ID。仅本会话已见外部工具结果，不是消息ID，不能引用memory工具。'},quote:{type:'string',description:'从该工具实际文本输出逐字摘录，最多500字。插件核对原生调用、结果和可见内容，不接受模型自填验证状态。'}}}
export const OBSERVATION_LIST_SCHEMA={type:'object',additionalProperties:false,required:['items','truncated','note'],properties:{items:{type:'array',items:{type:'object',additionalProperties:false,required:['callId','toolName','outcome','quotePreview','observedAt'],properties:{callId:{type:'string'},toolName:{type:'string'},outcome:{type:'string',enum:['succeeded','error']},quotePreview:{type:'string'},observedAt:{type:'string'}}}},truncated:{type:'boolean'},note:{type:'string'}}}
export const OBSERVATION_VIEW_SCHEMA={type:'object',additionalProperties:false,required:['kind','toolName','callId','resultEventId','observedAt','outcome','quote','outputHash','quoteChecked','currentWorldStateVerified','continuouslyRevalidated'],properties:{kind:{type:'string',enum:['native-tool-result']},toolName:{type:'string'},callId:{type:'string'},resultEventId:{type:'string'},observedAt:{type:'string'},outcome:{type:'string',enum:['succeeded','error']},quote:{type:'string'},outputHash:{type:'string'},quoteChecked:{type:'boolean'},currentWorldStateVerified:{type:'boolean'},continuouslyRevalidated:{type:'boolean'}}}
