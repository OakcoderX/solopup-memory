/** Bounded record-time history, published with the current projection. Never auto-injected. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {lstatSync} from 'node:fs'
import {readSafely,normalizeText,escapeFraming,entryId} from './security.mjs'
import {proposal,toolProposal} from './source-record.mjs'

export const EPISODE_FILE='.episodes.json',EPISODE_BYTES=2*1024*1024,EPISODE_LIMIT=1024
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const fail=code=>{const error=new Error('memory-history-'+code);error.code=error.message;throw error}
const sourced=source=>['tool-context','quoted-extraction'].includes(source?.origin)
const sourceLine=source=>source.indexLine??`- [${source.type}] ${source.summary} — ${source.detail===undefined?'索引摘要':source.type+'.md'}`
const lines=text=>new Set(String(text??'').split(/\r?\n/).map(line=>normalizeText(line).trim()).filter(line=>line.startsWith('- [')))
function sourceProof(input,strict=false){
 if(!input||!iso(input.createdAt))fail('invalid-source-time')
 const result=sourced(input)?toolProposal(input):input.origin==='reviewed-adoption'?{...proposal(input),origin:'reviewed-adoption'}:fail('invalid-source-origin')
 if(result.id!==input.id)fail('invalid-source-identity')
 const canonical={...result,createdAt:input.createdAt}
 if(strict&&JSON.stringify(input)!==JSON.stringify(canonical))fail('corrupt-source-proof')
 return canonical
}
function sealEntry(entry){const {checksum,...body}=entry;return{...body,checksum:sha(body)}}
function entry(input){
 if(!input||!Number.isSafeInteger(input.sequence)||input.sequence<1||!iso(input.recordedAt)||!['published','observed-existing'].includes(input.observation))fail('corrupt-entry')
 const source=sourceProof(input.source,true),line=sourceLine(source)
 if(input.line!==line||input.id!==sha([source.id,input.sequence,input.observation])||input.scope!==source.scope)fail('corrupt-entry-identity')
 const result={id:input.id,sequence:input.sequence,recordedAt:input.recordedAt,observation:input.observation,scope:source.scope,line,source}
 if(input.closed!==undefined){
  const c=input.closed
  if(!c||!Number.isSafeInteger(c.sequence)||c.sequence<input.sequence||!iso(c.at)||c.at<input.recordedAt||!['superseded','forgotten','expired','compacted','over-cap','untracked-removal'].includes(c.reason)||c.by!==undefined&&!hex(c.by)||c.uncertain!==undefined&&c.uncertain!==true||Object.keys(c).some(key=>!['sequence','at','reason','by','uncertain'].includes(key)))fail('corrupt-closure')
  result.closed={sequence:c.sequence,at:c.at,reason:c.reason,...c.by===undefined?{}:{by:c.by},...c.uncertain?{uncertain:true}:{}}
 }
 if(Object.keys(input).sort().join('|')!==[...Object.keys(result),'checksum'].sort().join('|')||input.checksum!==sha(result))fail('corrupt-entry-checksum')
 return{...result,checksum:input.checksum}
}
function empty(){return{schema:1,revision:0,latestSequence:0,startedAt:null,lastRecordedAt:null,droppedEntries:0,droppedThroughSequence:0,droppedThroughAt:null,untrackedTransitions:0,entries:[]}}
export function episodeSnapshot(dir){
 try{const stat=lstatSync(join(dir,EPISODE_FILE));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('unsafe-file')}catch(error){if(error.code!=='ENOENT')throw error}
 const raw=readSafely(join(dir,EPISODE_FILE),{maxBytes:EPISODE_BYTES})
 if(raw===undefined)return{exists:false,state:empty(),fingerprint:sha(null),lineNumbers:new Map()}
 let parsed;try{parsed=JSON.parse(raw)}catch{fail('corrupt-json')}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail('corrupt-state')
 const {checksum,...state}=parsed;if(!hex(checksum)||checksum!==sha(state))fail('corrupt-state-checksum')
 const keys=Object.keys(empty()).sort().join('|')
 if(Object.keys(state).sort().join('|')!==keys||![1,2].includes(state.schema)||!['revision','latestSequence','droppedEntries','droppedThroughSequence','untrackedTransitions'].every(k=>Number.isSafeInteger(state[k])&&state[k]>=0)||state.droppedThroughSequence>state.latestSequence||!Array.isArray(state.entries)||state.entries.length>EPISODE_LIMIT||state.startedAt!==null&&!iso(state.startedAt)||state.lastRecordedAt!==null&&!iso(state.lastRecordedAt)||state.droppedThroughAt!==null&&!iso(state.droppedThroughAt)||state.latestSequence>0&&(state.startedAt===null||state.lastRecordedAt===null)||state.droppedEntries>0&&state.droppedThroughAt===null)fail('corrupt-state')
 if(state.schema===1&&state.entries.some(row=>row?.source?.fieldLineage!==undefined))fail('field-format-needs-schema2')
 state.entries=state.entries.map(entry);const seen=new Set(),sources=new Set()
 for(const row of state.entries){if(seen.has(row.sequence)||sources.has(row.source.id)||row.sequence>state.latestSequence||row.closed?.sequence>state.latestSequence||state.lastRecordedAt===null||row.recordedAt>state.lastRecordedAt||row.closed?.at>state.lastRecordedAt||state.startedAt===null||row.recordedAt<state.startedAt)fail('corrupt-sequence');seen.add(row.sequence);sources.add(row.source.id)}
 const identities=new Set(state.entries.map(row=>row.id)),lineNumbers=new Map();let offset=0,line=1
 for(const match of raw.matchAll(/"id"\s*:\s*"([a-f0-9]{64})"/g)){line+=raw.slice(offset,match.index).split('\n').length-1;offset=match.index;if(identities.has(match[1])){if(lineNumbers.has(match[1]))fail('ambiguous-entry-location');lineNumbers.set(match[1],line)}}
 if(lineNumbers.size!==state.entries.length)fail('missing-entry-location')
 return{exists:true,state,fingerprint:sha(raw),lineNumbers}
}
function serialized(state){return JSON.stringify({...state,checksum:sha(state)},null,2)+'\n'}
function bounded(state){
 while(state.entries.length>EPISODE_LIMIT||Buffer.byteLength(serialized(state))>EPISODE_BYTES){
  const at=state.entries.findIndex(row=>row.closed!==undefined)
  if(at<0)fail('active-capacity')
  const [removed]=state.entries.splice(at,1);state.droppedEntries++;state.droppedThroughSequence=Math.max(state.droppedThroughSequence,removed.closed.sequence);state.droppedThroughAt=state.droppedThroughAt&&state.droppedThroughAt>removed.closed.at?state.droppedThroughAt:removed.closed.at
 }
 return{name:EPISODE_FILE,text:serialized(state)}
}
/** Caller holds publication ownership. One logical sequence per observed transition. */
export function prepareEpisodes(dir,{before,after,published,baseline=[],revoked=[],reason='forgotten',at=new Date().toISOString()}){
 const snap=episodeSnapshot(dir)
 if(!snap.exists&&!published&&!baseline.length)return undefined
 if(!iso(at))fail('invalid-time')
 const state=snap.state,old=lines(before),next=lines(after),removed=[...old].filter(line=>!next.has(line)),recordedAt=state.lastRecordedAt&&state.lastRecordedAt>at?state.lastRecordedAt:at
 const canonical=published?sourceProof(published.source):undefined
 if(canonical&&sourceLine(canonical)!==published.line)fail('publication-line-mismatch')
  if(canonical?.sources.some(root=>revoked.includes(root)))fail('publication-source-withdrawn')
  const countBefore=state.entries.length;state.entries=state.entries.filter(row=>!row.source.sources.some(root=>revoked.includes(root)))
 const live=state.entries.filter(row=>!row.closed)
 const orphaned=live.filter(row=>!old.has(row.line))
 state.untrackedTransitions+=orphaned.length
 // Observe a traceable pre-upgrade value only at this transition, never invent
 // an earlier interval from a ledger timestamp or old best-effort log.
 for(const line of removed){
  if(state.entries.some(row=>!row.closed&&row.line===line))continue
  const records=baseline.filter(r=>['recorded','adopted'].includes(r.status)&&sourceLine({...r,origin:sourced(r)?r.origin:'reviewed-adoption'})===line)
  if(records.length!==1){state.untrackedTransitions++;continue}
  const source=sourceProof({...records[0],origin:sourced(records[0])?records[0].origin:'reviewed-adoption'}),sequence=++state.latestSequence
  state.entries.push(sealEntry({id:sha([source.id,sequence,'observed-existing']),sequence,recordedAt,observation:'observed-existing',scope:source.scope,line,source}))
 }
 const changed=removed.length>0||canonical!==undefined||orphaned.length>0||countBefore!==state.entries.length
 if(!changed)return undefined
 const sequence=++state.latestSequence
 for(let i=0;i<state.entries.length;i++){
  const row=state.entries[i];if(row.closed||!removed.includes(row.line)&&!orphaned.some(old=>old.id===row.id))continue
  const unknown=orphaned.some(old=>old.id===row.id)
  state.entries[i]=sealEntry({...row,closed:{sequence,at:recordedAt,reason:unknown?'untracked-removal':reason,...canonical&&!unknown?{by:canonical.id}:{},...unknown?{uncertain:true}:{}}})
 }
 if(canonical){
  if(state.entries.some(row=>row.source.id===canonical.id))fail('duplicate-publication')
  state.entries.push(sealEntry({id:sha([canonical.id,sequence,'published']),sequence,recordedAt,observation:'published',scope:canonical.scope,line:published.line,source:canonical}))
 }
 if(state.entries.some(row=>row.source.fieldLineage))state.schema=2
 state.startedAt??=recordedAt;state.lastRecordedAt=recordedAt;state.revision++
 return bounded(state)
}
/** Whole tracked historical entries depend on every contributing source root. */
export function purgeEpisodes(dir,source){
 if(!hex(source))fail('invalid-source-key')
 const snap=episodeSnapshot(dir);if(!snap.exists)return undefined
 const kept=snap.state.entries.filter(row=>!row.source.sources.includes(source))
 if(kept.length===snap.state.entries.length)return undefined
 snap.state.entries=kept;snap.state.revision++
 return bounded(snap.state)
}
export function historyRows(dir,{scope,index,revoked=[],atSequence,asOf,expiredAt=()=>false}={}){
 if(atSequence!==undefined&&(!Number.isSafeInteger(atSequence)||atSequence<1)||asOf!==undefined&&!iso(asOf)||atSequence!==undefined&&asOf!==undefined)fail('invalid-cutoff')
 const snap=episodeSnapshot(dir),s=snap.state,current=lines(index)
 if(s.entries.some(row=>scope!==undefined&&row.scope!==scope))fail('scope-mismatch')
 if(atSequence!==undefined&&atSequence>s.latestSequence)fail('unknown-future-sequence')
 const allowed=s.entries.filter(row=>!row.source.sources.some(root=>revoked.includes(root)))
 const untrackedCurrentRows=[...current].filter(line=>!allowed.some(row=>!row.closed&&row.line===line)).length
 const unreconciled=allowed.filter(row=>!row.closed&&!current.has(row.line))
 const cutoff=atSequence??s.latestSequence
 const times=s.entries.flatMap(row=>[...(row.sequence<=cutoff?[row.recordedAt]:[]),...(row.closed&&row.closed.sequence<=cutoff?[row.closed.at]:[])])
 const cutoffTime=asOf??(atSequence!==undefined?times.sort().at(-1):new Date().toISOString())
 const selected=allowed.filter(row=>(atSequence!==undefined?row.sequence<=atSequence&&(!row.closed||row.closed.sequence>atSequence):asOf!==undefined?row.recordedAt<=asOf&&(!row.closed||row.closed.at>asOf):true)&&(!(atSequence!==undefined||asOf!==undefined)||!expiredAt(row.line,Date.parse(cutoffTime))))
 const covered=atSequence!==undefined?cutoff>s.droppedThroughSequence:asOf!==undefined?(s.startedAt!==null&&asOf>=s.startedAt&&(!s.droppedThroughAt||asOf>s.droppedThroughAt)):s.droppedEntries===0
 const coverage={exists:snap.exists,scope:scope??'unspecified',startedAt:s.startedAt,latestSequence:s.latestSequence,droppedEntries:s.droppedEntries,droppedThroughSequence:s.droppedThroughSequence,droppedThroughAt:s.droppedThroughAt,untrackedCurrentRows,untrackedTransitions:s.untrackedTransitions,unreconciledEntries:unreconciled.length,withdrawalBarriersPresent:revoked.length>0,complete:snap.exists&&covered&&untrackedCurrentRows===0&&s.untrackedTransitions===0&&unreconciled.length===0}
 return{coverage,rows:selected.map(row=>({row,line:snap.lineNumbers.get(row.id),history:{sequence:row.sequence,recordedAt:row.recordedAt,observation:row.observation,state:unreconciled.some(old=>old.id===row.id)?'unreconciled':row.closed?.uncertain?'uncertain-interval':atSequence!==undefined||asOf!==undefined?'active-at-cutoff':row.closed?row.closed.reason:expiredAt(row.line,Date.parse(cutoffTime))?'expired':'current',sourceSessionId:row.source.sessionId,sourceMessageIds:row.source.evidence.map(e=>e.messageId),...row.closed?{closedAt:row.closed.at,closedAtSequence:row.closed.sequence}:{}}}))}
}
const nullableTime={oneOf:[{type:'string'},{type:'null'}]}
export const HISTORY_SCHEMA={type:'object',additionalProperties:false,required:['sequence','recordedAt','observation','state','sourceSessionId','sourceMessageIds'],properties:{sequence:{type:'integer'},recordedAt:{type:'string'},observation:{type:'string',enum:['published','observed-existing']},state:{type:'string'},sourceSessionId:{type:'string'},sourceMessageIds:{type:'array',items:{type:'string'}},closedAt:{type:'string'},closedAtSequence:{type:'integer'}}}
export const COVERAGE_SCHEMA={type:'array',items:{type:'object',additionalProperties:false,required:['exists','scope','startedAt','latestSequence','droppedEntries','droppedThroughSequence','droppedThroughAt','untrackedCurrentRows','untrackedTransitions','unreconciledEntries','withdrawalBarriersPresent','complete'],properties:{exists:{type:'boolean'},scope:{type:'string'},startedAt:nullableTime,latestSequence:{type:'integer'},droppedEntries:{type:'integer'},droppedThroughSequence:{type:'integer'},droppedThroughAt:nullableTime,untrackedCurrentRows:{type:'integer'},untrackedTransitions:{type:'integer'},unreconciledEntries:{type:'integer'},withdrawalBarriersPresent:{type:'boolean'},complete:{type:'boolean'}}}}
