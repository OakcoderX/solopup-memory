/** A verified hash preimage identifies a source's session, never grants ownership or approval. */
import {createHash} from 'node:crypto'
import {normalizeText,escapeFraming} from './security.mjs'
const digest=pair=>createHash('sha256').update(JSON.stringify(pair)).digest('hex')
const fail=()=>{throw Error('withdrawal-source-identity-mismatch')}
const clean=(value,max)=>{if(typeof value!=='string')fail();const s=escapeFraming(normalizeText(value).trim());if(!s||s.length>max)fail();return s}
export function withdrawalSelector(key,identity){
 if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))fail()
 if(identity===undefined)return{sourceKey:key}
 const sessionId=clean(identity.sessionId,250),messageId=clean(identity.messageId,300)
 if(digest([sessionId,messageId])!==key)fail()
 return{sourceKey:key,sessionId,messageId}
}
export function discoverWithdrawalIdentity(key,proofs){
 withdrawalSelector(key)
 let found
 for(const proof of proofs){
  if(typeof proof?.sessionId!=='string'||!Array.isArray(proof.evidence))continue
  for(const ref of proof.evidence){
   if(typeof ref?.messageId!=='string')continue
   const sessionId=escapeFraming(normalizeText(proof.sessionId).trim()),messageId=escapeFraming(normalizeText(ref.messageId).trim())
   if(digest([sessionId,messageId])!==key)continue
   const identity=withdrawalSelector(key,{sessionId,messageId})
   if(found&&(found.sessionId!==identity.sessionId||found.messageId!==identity.messageId))fail()
   found=identity
  }
 }
 return found
}
