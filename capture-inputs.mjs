/** Bounded durable source pointers. No transcript, prompt, route or model output. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readSafely, writeSafely, withLock } from './security.mjs'
import {CAPTURE_REQUEST_CONTRACT} from './capture-llm.mjs'
import { captureMessage } from './capture-evidence.mjs'
import { listCaptureJobs } from './capture-jobs.mjs'

const FILE = '.capture-inputs.json'
const HASH = /^[a-f0-9]{64}$/
const LIMIT = 256
const MAX_BYTES = 1024 * 1024
const REASONS = ['source-incomplete','restore-review-required', 'source-changed', 'scope-changed', 'configuration-changed', 'source-withdrawn', 'session-ineligible']
const fail = code => { throw new Error(`capture-input-${code}`) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|')
const time = n => Number.isSafeInteger(n) && n >= 0 && n <= 8.64e15
const identity = row => digest(['capture-input-v1', row.sessionHash, row.scopeHash, row.configurationHash, row.routeHash, row.refs])
const invocationId = id => createHash('sha256').update(`capture-v1:${id}`).digest('hex')
const sessionHash = session => digest([session.id, session.header?.createdAt ?? null])
const scopeHash = cwd => digest(cwd ?? null)
const configurationHash = options => digest(['capture-configuration-v2',CAPTURE_REQUEST_CONTRACT,options.everyTurns, options.maxEntries, options.maxTokens, options.maxInputBytes, options.timeoutMs])
const routeHash = route => route ? digest([route.provider, route.model]) : null

export function captureSessionEligible(session) {
  return typeof session?.id === 'string' && session.id.length > 0 &&
    !session.header?.parentSession && !(session.header?.delegationDepth > 0) && session.header?.isSeeded !== true
}

export function captureInputDescriptor(session, messages, cwd, options, route) {
  if (!captureSessionEligible(session)) fail('session-ineligible')
  if (Array.isArray(messages)&&messages.some(m=>m?.role==='user'&&m.sourceComplete===false))fail('source-incomplete')
  if (!Array.isArray(messages) || !messages.length || messages.length > 30 ||
    messages.some(m => !Number.isSafeInteger(m?.seq) || m.seq < 0 || !['user','assistant'].includes(m.role) || !HASH.test(m.hash)) ||
    messages.some((m,i) => i > 0 && m.seq <= messages[i-1].seq) || !messages.some(m => m.role === 'user')) fail('invalid-source')
  const value = {sessionHash:sessionHash(session), scopeHash:scopeHash(cwd), configurationHash:configurationHash(options), routeHash:routeHash(route),
    refs:messages.map(m => ({seq:m.seq, role:m.role, hash:m.hash}))}
  return {id:identity(value), ...value}
}

function validDescriptor(row) {
  return row && typeof row === 'object' && ['id','sessionHash','scopeHash','configurationHash'].every(k => typeof row[k] === 'string' && HASH.test(row[k])) &&
    (row.routeHash === null || typeof row.routeHash === 'string' && HASH.test(row.routeHash)) &&
    Array.isArray(row.refs) && row.refs.length > 0 && row.refs.length <= 30 && row.refs.some(r => r.role === 'user') &&
    row.refs.every((r,i) => exact(r,['seq','role','hash']) && Number.isSafeInteger(r.seq) && r.seq >= 0 && ['user','assistant'].includes(r.role) &&
      typeof r.hash === 'string' && HASH.test(r.hash) && (i===0 || r.seq > row.refs[i-1].seq)) && identity(row) === row.id
}

function load(dir) {
  if (!existsSync(join(dir,FILE))) return {schema:1, revision:0, inputs:[]}
  try {
    const text=readSafely(join(dir,FILE),{maxBytes:MAX_BYTES}), state=JSON.parse(text)
    if (!exact(state,['schema','revision','inputs']) || state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      !Array.isArray(state.inputs) || state.inputs.length > LIMIT) fail('corrupt')
    const ids=new Set()
    for (const row of state.inputs) {
      const base=['id','sessionHash','scopeHash','configurationHash','routeHash','refs','status','at','updatedAt']
      const keys=row?.status==='bound'?[...base,'jobId']:row?.status==='blocked'?[...base,'reason']:base
      if (!exact(row,keys) || !validDescriptor(row) || ids.has(row.id) || !time(row.at) || !time(row.updatedAt) || row.updatedAt < row.at ||
        !['pending','bound','blocked'].includes(row.status) || row.status === 'bound' && row.jobId !== invocationId(row.id) ||
        row.status === 'blocked' && !REASONS.includes(row.reason)) fail('corrupt')
      ids.add(row.id)
    }
    return state
  } catch { fail('corrupt') }
}

function save(dir,state) {
  state.revision++
  if (!Number.isSafeInteger(state.revision)) fail('full')
  const text=JSON.stringify(state)
  if (Buffer.byteLength(text)>MAX_BYTES) fail('full')
  writeSafely(join(dir,FILE),text)
}

export function listCaptureInputs(dir) { return structuredClone(load(dir)) }

export function enqueueCaptureInput(dir, descriptor, {now=Date.now()}={}) {
  if (!exact(descriptor,['id','sessionHash','scopeHash','configurationHash','routeHash','refs']) || !validDescriptor(descriptor) || !time(now)) fail('invalid-source')
  return withLock(dir,()=>{
    const state=load(dir), previous=state.inputs.find(r=>r.id===descriptor.id)
    if (previous) return structuredClone(previous)
    // A changed route/configuration/contract or assistant rendering must not
    // turn the same owner-source window into a fresh model invocation.
    const users=JSON.stringify(descriptor.refs.filter(ref=>ref.role==='user'))
    const alias=state.inputs.find(row=>row.sessionHash===descriptor.sessionHash&&JSON.stringify(row.refs.filter(ref=>ref.role==='user'))===users)
    if(alias)return structuredClone(alias)
    // Never silently evict pending or uncertain work to accept a new batch.
    if (state.inputs.length===LIMIT) fail('full')
    const row={...structuredClone(descriptor),status:'pending',at:now,updatedAt:now}
    state.inputs.push(row);save(dir,state);return structuredClone(row)
  })
}

export function bindCaptureInput(dir,id,jobId,{now=Date.now()}={}) {
  if (!HASH.test(id) || jobId !== invocationId(id) || !time(now)) fail('invalid-binding')
  return withLock(dir,()=>{
    const state=load(dir),row=state.inputs.find(r=>r.id===id)
    if (!row || now<row.updatedAt || row.status==='blocked' || row.status==='bound' && row.jobId!==jobId) fail('stale')
    if (row.status==='pending') { row.status='bound';row.jobId=jobId;row.updatedAt=now;save(dir,state) }
    return structuredClone(row)
  })
}

export function blockCaptureInput(dir,id,reason,{now=Date.now()}={}) {
  if (!HASH.test(id) || !REASONS.includes(reason) || !time(now)) fail('invalid-block')
  return withLock(dir,()=>{
    const state=load(dir),row=state.inputs.find(r=>r.id===id)
    if (!row || now<row.updatedAt || row.status==='bound') fail('stale')
    if(row.status==='pending'){row.status='blocked';row.reason=reason;row.updatedAt=now;save(dir,state)}
    return structuredClone(row)
  })
}

export function pendingCaptureInputs(dir, session) {
  if(!captureSessionEligible(session))return []
  return listCaptureInputs(dir).inputs.filter(r=>r.status==='pending' && r.sessionHash===sessionHash(session))
}

/** Bound local waiting even when a read-plane implementation ignores abort. */
export async function observeCaptureSource(query,id,timeoutMs) {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)fail('invalid-timeout')
  const controller=new AbortController();let timer
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('capture-input-source-unavailable'))},timeoutMs)})
  const read=(async()=>{
    const observation=await query.observeSession(id,{projectionMode:'none',signal:controller.signal})
    if(controller.signal.aborted){observation?.[Symbol.dispose]?.();fail('source-unavailable')}
    return observation
  })()
  try{return await Promise.race([read,deadline])}finally{clearTimeout(timer)}
}

/** Explicit, versioned cleanup; pending/running/unknown invocations stay. */
export function pruneCaptureInputs(dir,{apply=false,expectedRevision,expectedJobsRevision}={}) {
  if(typeof apply!=='boolean')fail('invalid-prune')
  const inspect=()=>{
    const state=load(dir),jobs=listCaptureJobs(dir),closed=new Set(jobs.jobs.filter(j=>['succeeded','failed','abandoned'].includes(j.status)).map(j=>j.id))
    const removable=state.inputs.filter(r=>r.status==='blocked'||r.status==='bound'&&closed.has(r.jobId)).map(r=>r.id)
    return{state,jobsRevision:jobs.revision,removable}
  }
  const result=(view,applied)=>({applied,revision:view.state.revision,jobsRevision:view.jobsRevision,removable:view.removable,modelRequestResent:false})
  if(!apply)return result(inspect(),false)
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||!Number.isSafeInteger(expectedJobsRevision)||expectedJobsRevision<0)fail('review-required')
  return withLock(dir,()=>{
    const view=inspect()
    if(view.state.revision!==expectedRevision||view.jobsRevision!==expectedJobsRevision)fail('review-stale')
    if(view.removable.length){const ids=new Set(view.removable);view.state.inputs=view.state.inputs.filter(r=>!ids.has(r.id));save(dir,view.state)}
    return result(view,view.removable.length>0)
  })
}

/** Call only with an observation from the host's sessionQuery read plane. */
export function reconstructCaptureInput(row, session, events, cwd, options, route) {
  if (!validDescriptor(row)) fail('corrupt')
  if (!captureSessionEligible(session)) fail('session-ineligible')
  if (row.sessionHash!==sessionHash(session)) fail('source-changed')
  if (row.scopeHash!==scopeHash(cwd)) fail('scope-changed')
  if (row.configurationHash!==configurationHash(options) || row.routeHash!==null && row.routeHash!==routeHash(route)) fail('configuration-changed')
  if (!Array.isArray(events) || !Array.isArray(session.surface?.nodes) || typeof session.isOwnSeq!=='function') fail('source-changed')
  const active=new Set(session.surface.nodes)
  const messages=[]
  for(const ref of row.refs) {
    const event=events[ref.seq]
    const message=event?.seq===ref.seq ? captureMessage(event,`${session.id}:${ref.seq}`) : undefined
    if(message?.role==='user'&&message.sourceComplete===false)fail('source-incomplete')
    if (!active.has(ref.seq) || !session.isOwnSeq(ref.seq) || !message || message.role!==ref.role || message.hash!==ref.hash) fail('source-changed')
    messages.push({...message,seq:ref.seq})
  }
  return messages
}
