/** Remove this plugin's superseded context sections, never ordinary conversation. */
import { randomUUID } from 'node:crypto'
import { optionalService } from './host-services.mjs'

export const MEMORY_CONTEXT_NAME = 'memory:index'
export const HISTORY_PROJECTION_KEY = 'dsh-memory:context-history'
const MAX_TRACKED = 4096
const SNAPSHOT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const CLEARED = '[dsh-memory] The memory:index section of this historical snapshot has been removed.'
const fail = (code) => { throw new Error(code) }
const sectionOwned = (message) => message?.source?.kind === 'runtime-context' &&
  Array.isArray(message.source.sections) && message.source.sections.some(s => s?.name === MEMORY_CONTEXT_NAME)
const framed = (message) => message?.source?.kind === 'runtime-context' &&
  message.content?.some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.includes('<memory-store>'))
const joinSections = (sections) => sections.length ? `${SNAPSHOT_HEADER}\n\n${sections.map(s=>s.text).join('\n\n')}` : CLEARED

export function memoryContextProjection() {
  return {
    key: HISTORY_PROJECTION_KEY, stateVersion: 1,
    // Host-only checkpoints contain identities, not copies of memory text.
    stateSchema: { parse(value) {
      if (!value || Object.keys(value).some(k=>!['nodes','overflow'].includes(k)) || typeof value.overflow !== 'boolean' ||
        !Array.isArray(value.nodes) || value.nodes.length > MAX_TRACKED) fail('memory-context-invalid-checkpoint')
      const ids=new Set(),seqs=new Set()
      for(const row of value.nodes){
        if(!row || Object.keys(row).some(k=>!['id','seq'].includes(k)) || typeof row.id!=='string' || !row.id.length || row.id.length>128 ||
          !Number.isSafeInteger(row.seq) || row.seq<0 || ids.has(row.id) || seqs.has(row.seq)) fail('memory-context-invalid-checkpoint')
        ids.add(row.id);seqs.add(row.seq)
      }
      return {nodes:value.nodes.map(r=>({...r})),overflow:value.overflow}
    } },
    init:()=>({nodes:[],overflow:false}),
    apply(state,event){
      const removed=event?.surfaceOp?.op==='replace'?new Set(event.sourceEventSeqs??[]):new Set()
      let nodes=removed.size?state.nodes.filter(row=>!removed.has(row.seq)):state.nodes
      const message=event?.type==='user/message'?event.data:undefined
      if(sectionOwned(message)||framed(message)){
        if(nodes.length===MAX_TRACKED)return{nodes,overflow:true}
        nodes=[...nodes,{id:message.id,seq:event.seq}]
      }
      return nodes===state.nodes?state:{nodes,overflow:state.overflow}
    },
  }
}

/** A section's recorded provenance must reproduce its exact rendered snapshot. */
function ownedSection(message) {
  if(!sectionOwned(message)){
    if(framed(message))fail('memory-context-unattributed-history')
    return undefined
  }
  const sections=message.source.sections
  if(message.role!=='user' || message.content?.length!==1 || message.content[0]?.type!=='text' ||
    sections.some(s=>!s || typeof s.name!=='string' || typeof s.text!=='string') ||
    sections.filter(s=>s.name===MEMORY_CONTEXT_NAME).length!==1 || message.content[0].text!==joinSections(sections)) fail('memory-context-render-mismatch')
  return sections.find(s=>s.name===MEMORY_CONTEXT_NAME)
}

export function reconcileMemoryContext(session, state, currentText) {
  if(typeof session?.deriveMessages!=='function')return{replaced:0}
  const visible=session.deriveMessages().map(message=>({message,owned:ownedSection(message)})).filter(row=>row.owned!==undefined)
  if(!visible.length)return{replaced:0}
  if(visible.length===1&&visible[0].owned.text===currentText)return{replaced:0}
  if(!state || state.overflow)fail(state?.overflow?'memory-context-history-limit':'memory-context-history-unavailable')
  const byId=new Map(state.nodes.map(row=>[row.id,row.seq])), active=new Set(session.surface?.nodes??[])
  // Validate every replacement before the first append; never guess a source seq.
  const plans=visible.map(({message})=>{
    const seq=byId.get(message.id)
    if(!Number.isSafeInteger(seq)||!active.has(seq))fail('memory-context-unmapped-history')
    const sections=message.source.sections.filter(s=>s.name!==MEMORY_CONTEXT_NAME).map(s=>({...s}))
    const replacement={id:randomUUID(),role:'user',content:[{type:'text',text:joinSections(sections)}],
      source:sections.length?{...message.source,sections}:{kind:'runtime-context'}}
    return{seq,replacement}
  })
  for(const plan of plans){
    try{session.append('user/message',plan.replacement,{surfaceOp:{op:'replace',startSeq:plan.seq,endSeq:plan.seq},sourceEventSeqs:[plan.seq]})}
    catch{fail('memory-context-rewrite-failed')}
  }
  return{replaced:plans.length}
}

/** Requests are frozen by the host: reject stale inputs instead of editing them. */
export function assertCurrentMemoryRequest(messages,currentText) {
  const sections=(messages??[]).map(ownedSection).filter(s=>s!==undefined)
  // Other providers may change after our boundary check and cause the host to
  // append an otherwise identical memory section. Duplication alone is safe;
  // every retained copy must still equal the current memory view.
  if(sections.some(s=>s.text!==currentText))fail('memory-context-stale-request')
}

export function setupMemoryHistory(ctx,render) {
  const projections = optionalService(ctx, 'sessionProjections')
  if(typeof projections?.register!=='function')return{available:false,observe:()=>{}}
  const registration=projections.register(memoryContextProjection())
  // DSH 0.2.2 returns a callable thenable. Await it before publishing hooks,
  // while retaining synchronous support for the older registry API.
  const ready=handle=>{
    // Disposal can win after the host resolves registration but before this
    // continuation runs. The owning fiber already releases its registration.
    if(ctx.fiber?.uid===null)return{available:false,observe:()=>{}}
    return installMemoryHistory(ctx,render,typeof handle?.stateOf==='function'
      ? session=>handle.stateOf(session)
      : typeof projections.stateOf==='function'
        ? session=>projections.stateOf(session,HISTORY_PROJECTION_KEY)
        : undefined)
  }
  return typeof registration?.then==='function'?Promise.resolve(registration).then(ready):ready(registration)
}

function installMemoryHistory(ctx,render,stateOf) {
  if(!stateOf)fail('memory-context-reader-unavailable')
  const sessions=new Map()
  const cwdFor=(session,fallback)=>typeof ctx.workingDirectory?.get==='function'?ctx.workingDirectory.get(session):fallback
  const refresh=(input,next)=>{
    const session=input.agent?.session
    if(!session)fail('memory-context-session-unavailable')
    const cwd=cwdFor(session)
    sessions.set(session.id,{ref:new WeakRef(session),cwd})
    reconcileMemoryContext(session,stateOf(session),render(cwd))
    return next()
  }
  // Run before pre-step consumers (including summarizers), then recheck at
  // request preparation because other pre-step work may have changed history.
  ctx.on('agent/pre-step',refresh,{prepend:true})
  ctx.on('agent/request',refresh)
  ctx.on('session/disposed',session=>sessions.delete(session.id))
  ctx.on('llm/stream',(request,next)=>{
    const owned=(request.messages??[]).some(m=>sectionOwned(m)||framed(m))
    if(owned){
      const stored=sessions.get(request.sessionId),session=stored?.ref.deref()
      if(!session)fail('memory-context-session-unavailable')
      assertCurrentMemoryRequest(request.messages,render(cwdFor(session,stored.cwd)))
    }
    return next()
  })
  return{available:true,observe(session,cwd){
    if(!session)return
    sessions.set(session.id,{ref:new WeakRef(session),cwd})
  }}
}
