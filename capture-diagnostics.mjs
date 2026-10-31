/** Capture accounting contains only bounded enums/counts, never model or user bodies. */
import {normalizeText,escapeFraming,findSecrets} from './security.mjs'
export const CAPTURE_RESPONSE_BYTES=65536,CAPTURE_RESPONSE_ITEMS=64
const TYPES=['user','feedback','project','reference']
const fields=['schema','classification','responseValid','responseItems','parsedItems','parserRejected','deferred','admissionRejected','inserted','staged','duplicates','writeFailures','operationErrors','unresolved','wrapped','codes','semanticCompletenessVerified']
const numeric=['responseItems','parsedItems','parserRejected','deferred','admissionRejected','inserted','staged','duplicates','writeFailures','operationErrors','unresolved']
export const DIAGNOSTIC_CODES=['item-shape','item-type','item-summary','item-detail','secret','entry-limit','format-wrapper','invalid-meaning','missing-scope','project-global','missing-project','missing-evidence','invalid-user-evidence','incomplete-user-source','missing-basis','inference-needs-review','source-withdrawn','candidate-rejected','write-failed','unaccounted','capture-invalid-json','capture-invalid-envelope','capture-empty-response','capture-response-too-large','capture-too-many-items','capture-max-tokens','capture-provider-error','capture-timeout','capture-cancelled','capture-model-capability','capture-failed','other-failure']
const classes=['model-noop','recorded','pending-review','already-known','partial','parser-rejected','admission-rejected','write-failed','response-error','operation-error']
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
const failure=code=>{throw Error(code)}
const count=value=>Number.isInteger(value)&&value>=0&&value<=CAPTURE_RESPONSE_ITEMS
function classification(d){
 if(!d.responseValid)return'response-error'
 if(d.operationErrors)return'operation-error'
 if(d.responseItems===0)return'model-noop'
 if(d.parserRejected===d.responseItems)return'parser-rejected'
 if(d.parserRejected+d.admissionRejected===d.responseItems)return'admission-rejected'
 if(d.writeFailures&&d.inserted+d.staged+d.duplicates===0&&!d.deferred&&!d.parserRejected&&!d.admissionRejected&&!d.unresolved)return'write-failed'
 if(d.parserRejected+d.deferred+d.admissionRejected+d.writeFailures+d.unresolved)return'partial'
 if(d.inserted)return'recorded'
 if(d.staged)return'pending-review'
 return'already-known'
}
export function normalizeCaptureDiagnostic(value){
 if(!plain(value)||Object.keys(value).sort().join('|')!==[...fields].sort().join('|')||value.schema!==1||!classes.includes(value.classification)||typeof value.responseValid!=='boolean'||typeof value.wrapped!=='boolean'||value.semanticCompletenessVerified!==false||numeric.some(key=>!count(value[key]))||!Array.isArray(value.codes)||value.codes.length>DIAGNOSTIC_CODES.length)failure('capture-diagnostic-invalid')
 const codes=value.codes.map(item=>{if(!plain(item)||Object.keys(item).sort().join('|')!=='code|count'||!DIAGNOSTIC_CODES.includes(item.code)||!count(item.count)||item.count<1)failure('capture-diagnostic-invalid');return{code:item.code,count:item.count}})
 if(new Set(codes.map(item=>item.code)).size!==codes.length||value.responseItems!==value.parsedItems+value.parserRejected+value.deferred||value.parsedItems!==value.inserted+value.staged+value.duplicates+value.admissionRejected+value.writeFailures+value.unresolved||!value.responseValid&&numeric.some(key=>value[key]!==0)||value.classification!==classification(value))failure('capture-diagnostic-invalid')
 return Object.fromEntries(fields.map(key=>[key,key==='codes'?codes.sort((a,b)=>a.code.localeCompare(b.code,'en')):value[key]]))
}
export function buildCaptureDiagnostic(batch,progress={},errorCode){
 const d={schema:1,responseValid:batch!==undefined,responseItems:batch?.responseItems??0,parsedItems:batch?.parsedItems??0,parserRejected:batch?.parserRejected??0,deferred:batch?.deferred??0,admissionRejected:progress.admissionRejected??0,inserted:progress.inserted??0,staged:progress.staged??0,duplicates:progress.duplicates??0,writeFailures:progress.writeFailures??0,operationErrors:batch&&errorCode?1:0,unresolved:0,wrapped:batch?.wrapped??false,semanticCompletenessVerified:false}
 d.unresolved=Math.max(0,d.parsedItems-d.admissionRejected-d.inserted-d.staged-d.duplicates-d.writeFailures)
 const codes=new Map((batch?.codes??[]).map(item=>[item.code,item.count]))
 for(const item of progress.codes??[]){const code=DIAGNOSTIC_CODES.includes(item.code)?item.code:'other-failure';codes.set(code,(codes.get(code)??0)+item.count)}
 if(errorCode){const code=DIAGNOSTIC_CODES.includes(errorCode)?errorCode:'other-failure';codes.set(code,(codes.get(code)??0)+1)}
 if(d.unresolved)codes.set('unaccounted',d.unresolved)
 d.codes=[...codes].map(([code,count])=>({code,count}));d.classification=classification(d)
 return normalizeCaptureDiagnostic(d)
}
/** Exact JSON or one explicit JSON fence; never mine [] out of an object or prose. */
export function parseCaptureBatch(text,maxEntries){
 if(typeof text!=='string'||!text.trim())failure('capture-empty-response')
 if(Buffer.byteLength(text)>CAPTURE_RESPONSE_BYTES)failure('capture-response-too-large')
 if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>CAPTURE_RESPONSE_ITEMS)failure('capture-invalid-entry-budget')
 const raw=text.trim();let parsed,wrapped=false
 try{parsed=JSON.parse(raw)}catch{
  if((raw.match(/```/g)??[]).length!==2)failure('capture-invalid-json')
  const fenced=/```(?:json)?\s*([\s\S]*?)```/i.exec(raw);if(!fenced)failure('capture-invalid-json')
  try{parsed=JSON.parse(fenced[1])}catch{failure('capture-invalid-json')}
  wrapped=true
 }
 if(!Array.isArray(parsed))failure('capture-invalid-envelope')
 if(parsed.length>CAPTURE_RESPONSE_ITEMS)failure('capture-too-many-items')
 const candidates=[],reasons=new Map();let rejected=0,deferred=0
 const reject=code=>{rejected++;reasons.set(code,(reasons.get(code)??0)+1)}
 for(const item of parsed){
  if(!plain(item)){reject('item-shape');continue}
  if(typeof item.type!=='string'||!TYPES.includes(item.type.trim())){reject('item-type');continue}
  if(typeof item.summary!=='string'){reject('item-summary');continue}
  const summary=normalizeText(item.summary).replace(/\s+/g,' ').trim()
  if(summary.length<4||summary.length>200){reject('item-summary');continue}
  if(item.detail!==undefined&&(typeof item.detail!=='string'||normalizeText(item.detail).trim().length>4000)){reject('item-detail');continue}
  const detail=item.detail===undefined?undefined:normalizeText(item.detail).trim()
  if(findSecrets(summary+'\n'+(detail??'')).length){reject('secret');continue}
  if(candidates.length===maxEntries){deferred++;continue}
  const candidate={type:item.type.trim(),summary:escapeFraming(summary),detail:detail===undefined?undefined:escapeFraming(detail)}
  for(const key of ['scope','basis','evidence','supersedes','revisionMode','expires','meaning'])if(item[key]!==undefined)candidate[key]=item[key]
  candidates.push(candidate)
 }
 if(deferred)reasons.set('entry-limit',deferred)
 if(wrapped)reasons.set('format-wrapper',1)
 return{candidates,responseItems:parsed.length,parsedItems:candidates.length,parserRejected:rejected,deferred,wrapped,codes:[...reasons].map(([code,count])=>({code,count}))}
}
export function captureDiagnosticOutcome(d){return ['response-error','operation-error'].includes(d.classification)?'error':['parser-rejected','admission-rejected'].includes(d.classification)?'rejected':['partial','write-failed'].includes(d.classification)?'partial':'ok'}
export function captureDiagnosticReason(d){return d.classification==='parser-rejected'?'capture-parser-rejected':d.classification==='admission-rejected'?'capture-all-rejected':d.classification==='write-failed'||d.writeFailures?'capture-write-failed':d.classification==='partial'?'capture-partial-extraction':undefined}
const counter={type:'integer'}
export const CAPTURE_DIAGNOSTIC_SCHEMA={type:'object',additionalProperties:false,required:fields,properties:{schema:counter,classification:{type:'string',enum:classes},responseValid:{type:'boolean'},...Object.fromEntries(numeric.map(key=>[key,counter])),wrapped:{type:'boolean'},codes:{type:'array',items:{type:'object',additionalProperties:false,required:['code','count'],properties:{code:{type:'string',enum:DIAGNOSTIC_CODES},count:counter}}},semanticCompletenessVerified:{type:'boolean'}}}
