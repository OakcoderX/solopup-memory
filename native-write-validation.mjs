/** Native writes share the read-only semantic checker; publication stays with the caller. */
import {createHash} from 'node:crypto'
import {runCandidateValidation} from './capture-validation-job.mjs'
import {VALIDATION_CONTRACT,validationCandidateId} from './capture-validation.mjs'
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Both the triggering owner and the owner of a checked execution remain mandatory. */
export function nativeOwnerEvidence(owner,source,messages){
 const refs=new Map([...owner.evidence,...source.evidence].map(e=>[e.messageId,e]))
 if(refs.size>3)throw Error('memory-tool-source-overflow')
 return [...refs.values()].map(e=>{
  const m=messages.find(m=>m.id===e.messageId)
  if(!m||m.hash!==e.hash||!m.text.includes(e.quote))throw Error('memory-tool-source-unavailable')
  return {...e}
 })
}

export function nativeValidationCandidate(target,evidence,observation){
 return Object.fromEntries(Object.entries({type:target.type,scope:target.scope,summary:target.summary,detail:target.detail,
  meaning:target.meaning,expires:target.expires,supersedes:target.supersedes,revisionMode:target.revisionMode,inheritedMetadata:target.inheritedMetadata,observation,
  evidence:evidence.map(({messageId,quote})=>({messageId,quote}))}).filter(([,value])=>value!==undefined))
}

/** No route guessing, rewrite, implicit retry, or loss of a source accepted by the checker. */
export async function validateNativeWrite(options){
 const {owner,source,target,messages}=options
 const evidence=nativeOwnerEvidence(owner,source,messages)
 const candidate=nativeValidationCandidate(target,evidence,source.observation)
 options.assertCurrent()
 if(typeof options.llm?.prepareCall!=='function'||!options.route)return {status:'uncertain',reason:'validation-unavailable',evidence}
 const result=await runCandidateValidation({...options,parentId:owner.callHash,candidates:[candidate],minimumQuoteLength:1,
  // The actual native call, rather than model-controlled arguments, owns a single invocation.
  invocationFingerprint:digest(['native-memory-write-validation',owner.callHash,VALIDATION_CONTRACT])})
 options.assertCurrent()
 const verdict=result.verdicts.find(v=>v.candidateId===validationCandidateId(candidate))
 if(!verdict||verdict.status!=='approved')return {status:verdict?.status??'uncertain',reason:result.reason??(verdict?.unsupportedFields?.includes('transition')?'revision-intent-unsupported':verdict?.status==='rejected'?'candidate-rejected':'inference-needs-review'),evidence,jobId:result.jobId,...verdict?{reviewIssues:{unsupported:verdict.unsupportedFields??[],uncertain:verdict.uncertainFields??[]}}:{}}
 const required=new Set(evidence.map(e=>e.messageId)),accepted=new Map()
 for(const e of verdict.evidence){
  const m=messages.find(m=>m.id===e.messageId)
  if(!m||!m.text.includes(e.quote))throw Error('memory-tool-source-unavailable')
  accepted.set(e.messageId,{...e,hash:m.hash});required.delete(e.messageId)
 }
 if(required.size||!accepted.size||accepted.size>3)throw Error('memory-tool-source-overflow')
 return {status:'approved',evidence:[...accepted.values()],jobId:result.jobId}
}
