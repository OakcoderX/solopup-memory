import {assertMeaningSatisfiable} from './meaning.mjs'
import {createHash} from 'node:crypto'
import {redactSecrets} from './security.mjs'
import {CaptureSubmission} from './capture-submission.mjs'
import {runCaptureModel} from './capture-llm.mjs'
import {validationTransitionContext} from './validation-transition-context.mjs'
import {VALIDATION_FIELDS,VALIDATION_NAME,VALIDATION_TOOL,VALIDATION_SYSTEM,VALIDATION_CONTRACT} from './capture-validation-contract.mjs'
export {VALIDATION_CONTRACT}
const invalid=()=>{throw Error('capture-invalid-envelope')}
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)
const keys=(x,k)=>plain(x)&&Object.keys(x).sort().join('|')===[...k].sort().join('|')
const canonical=x=>Array.isArray(x)?x.map(canonical):plain(x)?Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,canonical(x[k])])):x
export const validationCandidateId=c=>createHash('sha256').update('memory-validation-v1:'+JSON.stringify(canonical(c))).digest('hex')
export function prepareValidationPrompt(messages,candidates,maxInputBytes=24576,minimumQuoteLength=8,currentRecords){
 if(![1,8].includes(minimumQuoteLength))throw Error('capture-invalid-input-budget')
 if(!Number.isInteger(maxInputBytes)||maxInputBytes<1024||maxInputBytes>65536||!Array.isArray(candidates)||candidates.length>10)throw Error('capture-invalid-input-budget')
 const available=maxInputBytes-512,records=[];let used=0
 for(const candidate of candidates){
  const requiredSourceRefs=Object.fromEntries((Array.isArray(candidate.evidence)?candidate.evidence:[]).map((e,i)=>['r'+(records.length+1)+'e'+(i+1),e.messageId]))
  const record={candidateId:validationCandidateId(candidate),value:candidate,requiredSourceRefs},raw=JSON.stringify(record)
  if(redactSecrets(raw)!==raw||used+Buffer.byteLength(raw)>Math.floor(available*0.6))continue
  records.push(record);used+=Buffer.byteLength(raw)+1
 }
 if(new Set(records.map(r=>r.candidateId)).size!==records.length)throw Error('capture-invalid-envelope')
 const ownerMessages=[];let sourceBytes=0
 for(const m of messages.slice(-30).filter(m=>m?.role==='user').reverse()){
  const value={id:m.id,role:'user',text:redactSecrets(m.text)},size=Buffer.byteLength(JSON.stringify(value))+1
  if(sourceBytes+size>available-used)continue
  ownerMessages.unshift(value);sourceBytes+=size
 }
 if(currentRecords!==undefined&&!Array.isArray(currentRecords))throw Error('memory-validation-context-invalid')
 const currentMemory=[],currentMemorySummary={provided:currentRecords!==undefined,omittedContexts:records.length}
 const payload={minimumQuoteLength,candidates:records,ownerMessages,omittedCandidates:candidates.length-records.length,omittedMessages:messages.length-ownerMessages.length,currentMemorySummary,currentMemory}
 // Owner testimony and whole candidates retain priority. Context uses only the remaining bytes.
 if(currentRecords!==undefined)for(const record of records){
  const remaining=Math.min(4096,maxInputBytes-Buffer.byteLength(JSON.stringify(payload))-Buffer.byteLength(JSON.stringify({candidateId:record.candidateId})))
  if(remaining<256)continue
  let projection
  try{projection=validationTransitionContext(record.value,currentRecords,{maxBytes:remaining})}catch(error){if(error.message==='memory-validation-context-budget')continue;throw error}
  const row={candidateId:record.candidateId,...projection}
  // Discard a sensitive projection rather than mutating its identity or source-linked interpretation.
  if(redactSecrets(JSON.stringify(row))!==JSON.stringify(row))continue
  currentMemory.push(row);currentMemorySummary.omittedContexts--
  if(Buffer.byteLength(JSON.stringify(payload))>maxInputBytes){currentMemory.pop();currentMemorySummary.omittedContexts++}
 }
 const text=JSON.stringify(payload)
 if(Buffer.byteLength(text)>maxInputBytes)throw Error('capture-invalid-input-budget')
 return{text,records,messages:ownerMessages,minimumQuoteLength,currentMemorySummary,currentMemory}
}
export class ValidationSubmission extends CaptureSubmission{
 constructor(prepared){super({name:VALIDATION_NAME});this.prepared=prepared}
 batch(text){
  const p=this.objectPayload(text),{records,messages}=this.prepared
  if(!keys(p,['checks'])||!Array.isArray(p.checks)||p.checks.length!==records.length)invalid()
  const remaining=new Map(records.map(r=>[r.candidateId,r])),verdicts=[]
  for(const check of p.checks){
   const record=remaining.get(check?.candidateId)
   if(record&&Object.hasOwn(check,'sourceRefs')){
    if(!keys(check,['candidateId','fields','taskRestriction','sourceRefs','evidence'])||!['none','review','explain_concept','other','uncertain'].includes(check.taskRestriction)||!Array.isArray(check.sourceRefs)||!Array.isArray(check.evidence)||check.evidence.length>3||new Set(check.sourceRefs).size!==check.sourceRefs.length)invalid()
    const bound=check.sourceRefs.map(ref=>{
     if(typeof ref!=='string'||!Object.hasOwn(record.requiredSourceRefs,ref))invalid()
     const messageId=record.requiredSourceRefs[ref],proof=record.value.evidence.find(e=>e.messageId===messageId)
     if(!proof)invalid();return{messageId,quote:proof.quote}
    })
    // Only an identical duplicate of a code-bound quote may collapse. No source is dropped.
    const combined=[]
    for(const e of [...bound,...check.evidence]){
     if(!keys(e,['messageId','quote']))invalid()
     const previous=combined.find(x=>x.messageId===e.messageId)
     if(previous){if(previous.quote!==e.quote)invalid()}else combined.push(e)
    }
    if(!keys(check.fields,VALIDATION_FIELDS)||!VALIDATION_FIELDS.every(k=>['supported','unsupported','uncertain'].includes(check.fields[k])))invalid()
    if(record.value.meaning?.kind==='preference'){
     if(['review','explain_concept','other'].includes(check.taskRestriction)&&!record.value.meaning.conditions?.some(term=>term.dimension==='task'))check.fields.applicability='unsupported'
     else if(check.taskRestriction==='uncertain'&&check.fields.applicability==='supported')check.fields.applicability='uncertain'
    }
    delete check.taskRestriction;delete check.sourceRefs;check.evidence=combined
   }
   if(!record||!keys(check,['candidateId','fields','evidence'])||!keys(check.fields,VALIDATION_FIELDS)||!VALIDATION_FIELDS.every(f=>['supported','unsupported','uncertain'].includes(check.fields[f]))||!Array.isArray(check.evidence)||check.evidence.length>3)invalid()
   remaining.delete(check.candidateId);const refs=new Set()
   for(const e of check.evidence){
    const m=messages.find(m=>m.id===e?.messageId)
    if(!keys(e,['messageId','quote'])||!m||typeof e.quote!=='string'||e.quote.length<(this.prepared.minimumQuoteLength??8)||e.quote.length>500||!m.text.includes(e.quote)||refs.has(e.messageId))invalid()
    refs.add(e.messageId)
   }
   const fields={...check.fields}
   try{assertMeaningSatisfiable(record.value.meaning)}catch(error){if(error.code!=='memory-meaning-contradictory-conditions')throw error;fields.applicability='unsupported'}
   // A model vote cannot certify a target that the bounded request did not show.
   if(this.prepared.currentMemorySummary?.provided===true&&record.value.supersedes!==undefined&&!this.prepared.currentMemory?.some(row=>row.candidateId===record.candidateId&&row.targetShown===true)&&fields.transition==='supported')fields.transition='uncertain'
   const values=Object.values(fields),approved=values.every(v=>v==='supported')
   if(values.some(v=>v==='supported')&&!refs.size)invalid()
   if(approved&&(!refs.size||record.value.evidence.some(e=>!refs.has(e.messageId))))invalid()
   verdicts.push({candidateId:check.candidateId,status:approved?'approved':values.includes('unsupported')?'rejected':'uncertain',evidence:check.evidence.map(({messageId,quote})=>({messageId,quote})),...approved?{}:{unsupportedFields:VALIDATION_FIELDS.filter(f=>fields[f]==='unsupported'),uncertainFields:VALIDATION_FIELDS.filter(f=>fields[f]==='uncertain')}})
  }
  return{candidates:[],verdicts,responseItems:0,parsedItems:0,parserRejected:0,deferred:0,wrapped:false,codes:[]}
 }
}
/** Evaluates only; this function never stages or publishes records. */
export async function validateCandidatesWithLlm(options){
 const prepared=options.prepared??prepareValidationPrompt(options.messages,options.candidates,options.maxInputBytes,options.minimumQuoteLength,options.currentRecords)
 if(!prepared.records.length)return{verdicts:[],shown:0,omitted:options.candidates.length}
 const result=await runCaptureModel({...options,maxTokens:Math.min(8192,448+320*prepared.records.length),includeDiagnostics:true},{system:VALIDATION_SYSTEM,tool:VALIDATION_TOOL,purpose:'memory-validation',prepare:()=>prepared,submission:p=>new ValidationSubmission(p)})
 return{verdicts:result.verdicts,shown:prepared.records.length,omitted:options.candidates.length-prepared.records.length}
}

/** Keep every source used to accept a candidate; never silently truncate withdrawal roots. */
export function mergeValidationEvidence(candidate,validationEvidence){
 const refs=new Map(candidate.evidence.map(e=>[e.messageId,e]))
 for(const e of validationEvidence){if(!refs.has(e.messageId))refs.set(e.messageId,e)}
 if(refs.size>3)throw Error('capture-invalid-envelope')
 return[...refs.values()]
}
