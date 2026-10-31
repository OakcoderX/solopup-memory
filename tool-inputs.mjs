/** Host-owned call-to-admitted-input lineage. Context linkage is not semantic evidence. */
import {createHash} from 'node:crypto'
import {captureMessage} from './capture-evidence.mjs'
import {normalizeText,redactSecrets} from './security.mjs'
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const id=value=>typeof value==='string'&&value.length>0&&value.length<=300&&!/[\u0000-\u001f]/.test(value)
const position=value=>Number.isSafeInteger(value)&&value>0
export function createToolInputTracker({workingDirectory}={}){
 const cwdHash=session=>{try{const value=workingDirectory?.(session);return typeof value==='string'&&value.trim()?digest(value.trim()):undefined}catch{return undefined}}
 const states=new WeakMap()
 const stateFor=session=>{let state=states.get(session);if(!state){state={turns:new Map(),messages:new Map(),calls:new Map()};states.set(session,state)}return state}
 function preStep(input){
  const session=input?.agent?.session
  if(!session||typeof session!=='object'||!id(session.id)||!position(input.turn)||!position(input.step)||!Array.isArray(input.messages))return
  const state=stateFor(session);let turn=state.turns.get(input.turn)
  if(!turn){turn={messages:new Map(),overflow:false};state.turns.set(input.turn,turn)}
  if(input.messages.length>64)turn.overflow=true
  for(const message of input.messages.slice(0,64)){
   if(message?.source?.kind!=='user'||!id(message.id))continue
   if(turn.messages.size>=64&&!turn.messages.has(message.id)){turn.overflow=true;continue}
   if(!turn.messages.has(message.id))turn.messages.set(message.id,input.step)
  }
  while(state.turns.size>8)state.turns.delete(state.turns.keys().next().value)
 }
 function event(session,event){
  if(!session||typeof session!=='object'||!id(session.id)||!position(event?.seq))return
  const state=stateFor(session)
  if(event.type==='user/message'){
   const message=event.data?.message??event.data
   if(!id(message?.id))return
   const captured=captureMessage(event,session.id+':'+event.seq)
   const fullText=Array.isArray(message.content)?redactSecrets(normalizeText(message.content.filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>b.text).join('\n'))).trim():''
   if(captured?.role==='user')state.messages.set(message.id,{seq:event.seq,...captured,sourceComplete:fullText.length<=2000,cwdHash:cwdHash(session)})
   while(state.messages.size>64)state.messages.delete(state.messages.keys().next().value)
  }else if(event.type==='tool/call'){
   const call=event.data
   if(!id(call?.callId)||!position(call.turn)||!position(call.step))return
   // The first native call event wins; duplicate IDs never move their cutoff.
   if(!state.calls.has(call.callId))state.calls.set(call.callId,{turn:call.turn,step:call.step,seq:event.seq})
   while(state.calls.size>256)state.calls.delete(state.calls.keys().next().value)
  }
 }
 function admitted(exec){
  exec?.signal?.throwIfAborted()
  const session=exec?.agent?.session,state=session&&states.get(session),callId=exec?.rootCallId??exec?.callId,call=state?.calls.get(callId),turn=call&&state.turns.get(call.turn)
  if(!call||!turn||turn.overflow)throw Error('memory-tool-source-unavailable')
  const roots=[...turn.messages].filter(([,step])=>step<=call.step).map(([messageId])=>state.messages.get(messageId)).filter(message=>message&&message.seq<call.seq)
  if(!roots.length||roots.length>3||roots.some(message=>message.text.length<1))throw Error('memory-tool-source-unavailable')
  return{session,state,call,roots:roots.sort((a,b)=>a.seq-b.seq),callId}
 }
 function forExecution(exec){
  const{session,roots,callId}=admitted(exec)
  return{sessionId:session.id,via:'memory_write',basis:'tool-context',callHash:digest([session.id,callId]),evidence:roots.map(message=>({messageId:message.id,hash:message.hash,quote:message.text.slice(0,500)}))}
 }
 function forValidation(exec){
  const{session,state,call,roots}=admitted(exec),contextCwdHash=cwdHash(session)
  if(roots.some(m=>m.sourceComplete===false))throw Error('memory-tool-source-incomplete')
  if(roots.some(m=>m.cwdHash!==contextCwdHash))throw Error('memory-tool-source-scope-changed')
  const rootIds=new Set(roots.map(m=>m.id))
  const earlierOwned=new Set([...state.turns].filter(([turn])=>turn<call.turn).flatMap(([,turn])=>[...turn.messages.keys()]))
  const history=contextCwdHash?[...state.messages].filter(([key,m])=>earlierOwned.has(key)&&m.seq<call.seq&&m.cwdHash===contextCwdHash&&!rootIds.has(m.id)).map(([,m])=>m).sort((a,b)=>a.seq-b.seq).slice(-(30-roots.length)):[]
  if(history.some(m=>m.sourceComplete===false))throw Error('memory-tool-source-incomplete')
  const messages=[...history,...roots].sort((a,b)=>a.seq-b.seq).map(({id,role,text,hash})=>({id,role,text,hash}))
  return{messages,contextCwdHash}

 }
 return{preStep,event,forExecution,forValidation,disposeSession:session=>states.delete(session)}
}
