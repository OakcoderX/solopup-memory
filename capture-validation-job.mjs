/** One durable child invocation. No model output bodies or publication authority retained. */
import {createHash} from 'node:crypto'
import {claimCaptureJob,assertCaptureClaim,finishCaptureJob,retryBusyWrite} from './capture-jobs.mjs'
import {buildCaptureDiagnostic} from './capture-diagnostics.mjs'
import {prepareValidationPrompt,validateCandidatesWithLlm,VALIDATION_CONTRACT} from './capture-validation.mjs'
const zero={proposed:0,inserted:0,staged:0,rejected:0}
export async function runCandidateValidation(options){
 const {jobDir,parentId,candidates,messages,route,sessionId,maxInputBytes,timeoutMs=25000}=options
 if(!/^[a-f0-9]{64}$/.test(parentId))throw Error('capture-invalid-envelope')
 const prepared=prepareValidationPrompt(messages,candidates,maxInputBytes,options.minimumQuoteLength,options.currentRecords)
 if(!prepared.records.length)return{verdicts:[],shown:0,omitted:candidates.length,called:false,reason:'input-limit'}
 const check=async(claim)=>{
  for(let attempt=0;;attempt++)try{if(claim)assertCaptureClaim(jobDir,claim);options.assertCurrent?.();return}catch(error){if(error?.code!=='memory-lock-busy'||attempt===8)throw error;await new Promise(r=>setTimeout(r,10*(attempt+1)))}
 }
 await check()
 if(options.invocationFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(options.invocationFingerprint))throw Error('capture-invalid-envelope')
 const fingerprint=options.invocationFingerprint??createHash('sha256').update(JSON.stringify({task:'candidate-validation-v1',parentId,contract:VALIDATION_CONTRACT,request:prepared.text,route,sessionId,timeoutMs,maxInputBytes})).digest('hex')
 const claim=await retryBusyWrite(()=>claimCaptureJob(jobDir,fingerprint,{leaseMs:Math.min(120000,Math.max(1000,timeoutMs+30000))}))
 if(!claim.claimed)return{verdicts:[],shown:prepared.records.length,omitted:candidates.length-prepared.records.length,called:false,jobId:claim.id,reason:'previous-invocation'}
 let issued=false,failureStage='audit-link'
 const assertDispatch=()=>{assertCaptureClaim(jobDir,claim);const result=options.assertCurrent?.();if(result&&typeof result.then==='function')throw Error('capture-invalid-envelope')}
 try{
  await options.onClaim?.({id:claim.id})
  failureStage='prepare-or-stream'
  const result=await validateCandidatesWithLlm({...options,prepared,beforeStream:async()=>{failureStage='source-check-before-stream';await check(claim)},beforeDispatch:()=>{assertDispatch();failureStage='stream';issued=true}})
  failureStage='source-check-after-stream';await check(claim)
  // Validation itself proposes zero memory entries; audit counts live separately.
  failureStage='finish-ledger'
  await retryBusyWrite(()=>finishCaptureJob(jobDir,claim,{outcome:'ok',counts:zero,diagnostic:buildCaptureDiagnostic({responseItems:0,parsedItems:0,parserRejected:0,deferred:0,wrapped:false,codes:[]})}),{beforeAttempt:()=>assertCaptureClaim(jobDir,claim)})
  await check()
  return{...result,called:issued,jobId:claim.id}

 }catch(error){
  const reason=['capture-invalid-envelope','capture-invalid-json','capture-max-tokens','capture-provider-error','capture-timeout','capture-cancelled','capture-model-capability','capture-response-too-large','capture-empty-response'].includes(error?.message)?error.message:'capture-failed'
  try{await retryBusyWrite(()=>finishCaptureJob(jobDir,claim,{outcome:'error',reason,counts:zero,diagnostic:buildCaptureDiagnostic(undefined,{},reason)}))}catch{/* Expired or already settled invocation stays explicit. */}
  const known=['capture-input-source-changed','capture-input-source-withdrawn','capture-input-source-unavailable','capture-jobs-stale-claim']
  const kind=error?.code==='memory-lock-busy'?'local-lock-busy':known.includes(error?.message)?error.message:['TypeError','RangeError'].includes(error?.name)?error.name:reason==='capture-failed'?'other-error':reason
  await options.onFailure?.({validationJobId:claim.id,failureStage,errorKind:kind,issued})
  await check()
  return{verdicts:[],shown:prepared.records.length,omitted:candidates.length-prepared.records.length,called:issued,jobId:claim.id,reason,failureStage,errorKind:kind}

 }
}
