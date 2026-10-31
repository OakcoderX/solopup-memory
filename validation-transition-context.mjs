/** Bounded code-owned current projections for a no-rewrite validator. Not new owner evidence. */
import {normalizeMeaning} from './meaning.mjs'
import {rankLines} from './retrieval.mjs'
const fail=()=>{throw Error('memory-validation-context-invalid')}
export function validationTransitionContext(target,records,{maxBytes=4096,maxRecords=4}={}){
 if(!target||!['global','project'].includes(target.scope)||typeof target.summary!=='string'||!Array.isArray(records)||records.length>512||!Number.isSafeInteger(maxBytes)||maxBytes<128||maxBytes>12288||!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>8)fail()
 const ids=new Set(),owned=records.filter(r=>r?.scope===target.scope&&['recorded','adopted'].includes(r.status)).map(r=>{
  if(typeof r.id!=='string'||!/^[a-f0-9]{64}$/.test(r.id)||ids.has(r.id)||typeof r.summary!=='string')fail();ids.add(r.id)
  const line=r.indexLine??`- [${r.type}] ${r.summary} — ${r.detail===undefined?'索引摘要':r.type+'.md'}${r.expires===undefined?'':` (exp:${r.expires})`}`
  return structuredClone({recordId:r.id,identityKind:r.legacyIndexOnly===true?'index-line':'source-record',sourceLinked:r.legacyIndexOnly!==true,indexLine:line,summary:r.summary,type:r.type,scope:r.scope,meaning:r.meaning??null,expires:r.expires??null})
 })
 const oldLine=typeof target.supersedes==='string'?target.supersedes.replace(/^\[(?:global|project)\] /,''):undefined
 const exact=oldLine===undefined?[]:owned.filter(r=>r.indexLine===oldLine||r.indexLine.includes(oldLine))
 if(exact.length>1)fail()
 const ranked=rankLines(target.summary,owned.map(r=>({file:r.recordId,line:1,text:r.summary})))
 const byId=new Map(owned.map(r=>[r.recordId,r])),order=[...exact.map(r=>r.recordId),...ranked.map(r=>r.file),...owned.toReversed().map(r=>r.recordId)]
 const sameMetadata=row=>row.sourceLinked&&target.meaning!==undefined&&row.meaning!==null&&row.type===target.type&&row.expires===(target.expires??null)&&JSON.stringify(normalizeMeaning(row.meaning))===JSON.stringify(normalizeMeaning(target.meaning))
 const effect=rows=>({proposed:oldLine===undefined?'append':'replace',existingRowsRemain:oldLine===undefined?'all':'all-except-designated-target',sameMetadataRecordIds:rows.filter(sameMetadata).map(row=>row.recordId)})
 const envelope={operation:effect([]),records:[],omittedRecords:owned.length,scope:target.scope,targetShown:oldLine===undefined?null:false,boundary:'Existing indexed interpretations for transition checking only; sourceLinked=false is unclassified legacy index data with no verified source metadata. Not new owner evidence, world truth or execution authority.'}
 const seen=new Set()
 for(const id of order){
  if(seen.has(id))continue;seen.add(id)
  if(envelope.records.length>=maxRecords)break
  const row=byId.get(id),rows=[...envelope.records,row],next={...envelope,operation:effect(rows),records:rows,omittedRecords:owned.length-envelope.records.length-1,targetShown:oldLine===undefined?null:exact.some(t=>t.recordId===id)||envelope.targetShown}
  if(Buffer.byteLength(JSON.stringify(next))>maxBytes)continue
  Object.assign(envelope,next)
 }
 if(Buffer.byteLength(JSON.stringify(envelope))>maxBytes)throw Error('memory-validation-context-budget')
 return envelope
}
