/** Source-linked meaning. Models describe hypotheses; they cannot grant truth or authority. */
import {normalizeText,escapeFraming,findSecrets} from './security.mjs'
import {observationView,OBSERVATION_VIEW_SCHEMA} from './tool-observations.mjs'
import {assessBelief,revisionLabel,REVISION_SCHEMA} from './belief-revision.mjs'
export const MEANING_KINDS=['preference','decision','claim','belief','value','reference','episode']
const fail=code=>{const error=new Error('memory-meaning-'+code);error.code=error.message;throw error}
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
const clean=(value,max)=>{if(typeof value!=='string')fail('invalid-text');const text=normalizeText(value).trim();if(!text||text.length>max||findSecrets(text).length)fail('invalid-text');return escapeFraming(text)}
const dimension=value=>{if(typeof value!=='string'||!(/^[a-z][a-z0-9_-]{0,39}$/).test(value))fail('invalid-dimension');return value}
function terms(input){
 if(input===undefined)return[]
 if(!Array.isArray(input)||input.length>4)fail('invalid-conditions')
 const seen=new Set(),result=input.map(term=>{
  if(!plain(term)||Object.keys(term).sort().join('|')!=='dimension|value')fail('invalid-conditions')
  const key=dimension(term.dimension);if(seen.has(key))fail('duplicate-dimension');seen.add(key)
  return{dimension:key,value:clean(term.value,100)}
 })
 return result.sort((a,b)=>a.dimension.localeCompare(b.dimension,'en'))
}
function sentences(value){if(value===undefined)return[];if(!Array.isArray(value)||value.length>3)fail('invalid-hypotheses');return[...new Set(value.map(item=>clean(item,160)))]}
function relations(value,kind){
 if(value===undefined)return[]
 if(!['claim','episode'].includes(kind)||!Array.isArray(value)||value.length>3)fail('invalid-relations')
 const seen=new Set()
 return value.map(relation=>{
  if(!plain(relation)||Object.keys(relation).sort().join('|')!=='stance|target'||typeof relation.target!=='string'||!(/^[a-f0-9]{64}$/).test(relation.target)||!['supports','contradicts'].includes(relation.stance)||seen.has(relation.target))fail('invalid-relations')
  seen.add(relation.target);return{target:relation.target,stance:relation.stance}
 }).sort((a,b)=>a.target.localeCompare(b.target,'en'))
}
export function normalizeMeaning(input){
 if(input===undefined)return undefined
 if(!plain(input)||Object.keys(input).some(key=>!['kind','conditions','except','alternatives','falsifiedBy','relations'].includes(key))||!MEANING_KINDS.includes(input.kind))fail('invalid-shape')
 const result={kind:input.kind,conditions:terms(input.conditions),except:terms(input.except),alternatives:sentences(input.alternatives),falsifiedBy:sentences(input.falsifiedBy)}
 const links=relations(input.relations,input.kind);if(links.length)result.relations=links
 if(Buffer.byteLength(JSON.stringify(result))>2048)fail('too-large')
 return result
}
/** New-write admission only. Historical normalization and record identities stay readable. */
export function assertMeaningSatisfiable(input){
 const value=normalizeMeaning(input)
 if(value?.conditions.some(required=>value.except.some(excluded=>required.dimension===excluded.dimension&&required.value===excluded.value)))fail('contradictory-conditions')
 return value
}
export function meaningForScope(input,scope){const value=normalizeMeaning(input);if(value?.kind==='decision'&&scope!=='project')fail('project-decision-needs-project');return value}
export function normalizeContext(input){
 if(input===undefined)return{}
 if(!plain(input)||Object.keys(input).length>8)fail('invalid-context')
 return Object.fromEntries(Object.entries(input).map(([key,value])=>[dimension(key),clean(value,100)]))
}
export function normalizeTask(input){
 if(input===undefined)return{affectsDecision:false,experimentPossible:false}
 if(!plain(input)||Object.keys(input).some(key=>!['affectsDecision','experimentPossible'].includes(key))||typeof input.affectsDecision!=='boolean'||input.experimentPossible!==undefined&&typeof input.experimentPossible!=='boolean')fail('invalid-task')
 return{affectsDecision:input.affectsDecision,experimentPossible:input.experimentPossible===true}
}
/** Three-valued matching. Unknown exception dimensions never silently mean "no exception". */
export function applicability(meaning,context={}){
 const missing=new Set()
 for(const term of meaning.conditions){if(!Object.hasOwn(context,term.dimension))missing.add(term.dimension);else if(context[term.dimension]!==term.value)return{state:'not-applicable',missing:[]}}
 for(const term of meaning.except){if(!Object.hasOwn(context,term.dimension))missing.add(term.dimension);else if(context[term.dimension]===term.value)return{state:'not-applicable',missing:[]}}
 return{state:missing.size?'unknown':'applicable',missing:[...missing].sort()}
}
const epistemic={preference:'source-linked-preference',decision:'reported-decision',claim:'reported-not-verified',belief:'tentative-belief',value:'value-not-fact',reference:'source-pointer',episode:'reported-episode'}
/** Advisory only: this function never executes, sends, buys, or authorizes anything. */
export function memoryAdvice(meaning,match,task){
 if(match.state==='not-applicable')return{action:'skip',reason:'conditions-do-not-apply',authority:'none'}
 if(!task.affectsDecision)return{action:'continue',reason:'no-decision-impact-declared',authority:'none'}
 // Missing context of an external claim calls for checking evidence/context,
 // not treating the human as the default oracle for unverified world facts.
 if(match.state==='unknown'&&['claim','belief','reference','episode'].includes(meaning.kind))return{action:'verify',reason:'check-factual-evidence-and-applicability',authority:'none'}
 if(match.state==='unknown')return{action:'ask-context',reason:'missing-applicability-context',authority:'none'}
 if(meaning.kind==='belief'&&meaning.alternatives.length&&meaning.falsifiedBy.length&&task.experimentPossible)return{action:'propose-experiment',reason:'discriminating-observation-needed',authority:'none'}
 if(['claim','belief','reference','episode'].includes(meaning.kind))return{action:'verify',reason:'source-link-is-not-independent-verification',authority:'none'}
 return{action:'use',reason:meaning.kind==='value'?'objective-only-not-truth-or-permission':'applicable-source-linked-rule',authority:'none'}
}
export function meaningView(record,context,task,records){
 const meaning=normalizeMeaning(record.meaning),match=applicability(meaning,context)
 const observation=observationView(record)
 const revision=records?assessBelief(record,records,context,applicability):undefined
 const advice=memoryAdvice(meaning,match,task)
 if(revision&&task.affectsDecision&&['challenged','conflicted'].includes(revision.state)&&match.state!=='not-applicable'){advice.action='verify';advice.reason='reported-counterevidence-needs-resolution'}
 return{...meaning,...record.id?{recordId:record.id}:{},epistemic:epistemic[meaning.kind],applicability:match.state,missing:match.missing,sourceOrigin:record.origin??'reviewed-adoption',sourceRoots:new Set(record.sources).size,advice,...revision?{revision}:{},...observation?{observation}:{}}

}
const labels={preference:'偏好',decision:'项目决定',claim:'事实主张（尚未独立核实）',belief:'信念（暂定，不等于事实）',value:'价值取向（不证明事实或授予权限）',reference:'查证入口',episode:'有归属的经历陈述'}
const conditionText=(terms,separator=' 且 ')=>terms.map(term=>`${term.dimension}=${term.value}`).join(separator)
export function meaningLabel(meaning){return`认识层：${labels[meaning.kind]}；适用条件：${conditionText(meaning.conditions)||'无显式条件'}；例外：${conditionText(meaning.except,' 或 ')||'无显式例外'}。缺失条件不能默认满足；来源关联不等于独立核实，记录不构成操作授权。`}
export function interpretationLabel(view){return`${meaningLabel(view)} 判定：${view.applicability}${view.missing.length?'；缺失 '+view.missing.join(','):''}；建议：${view.advice.action}（advice.action=${view.advice.action}；仅建议，无执行授权）。${view.alternatives.length?' 竞争解释：'+view.alternatives.join('；'):''}${view.falsifiedBy.length?' 待检验反证条件：'+view.falsifiedBy.join('；'):''}${view.observation?' 原生工具观察：'+view.observation.toolName+'，outcome='+view.observation.outcome+'；quoteChecked=true；当时输出引用已核对，非现实真实性证明；引用：'+view.observation.quote:''}${view.recordId?' 记录身份：'+view.recordId:''}${revisionLabel(view)}${view.relations?.length?' 观察关联（仅陈述映射）：'+view.relations.map(link=>link.stance+' '+link.target).join('；'):''}`}

/** Only active source-linked/adopted records may qualify a live projection. */
export function activeMeanings(records){return records.filter(record=>['recorded','adopted'].includes(record.status)&&record.meaning!==undefined)}
export function meaningForLine(records,line){
 const matches=records.filter(record=>(record.indexLine??`- [${record.type}] ${record.summary} — ${record.detail===undefined?'索引摘要':record.type+'.md'}`)===line.trim())
 if(!matches.length)return undefined
 const serialized=JSON.stringify(matches[0].meaning)
 if(matches.some(record=>JSON.stringify(record.meaning)!==serialized))fail('ambiguous-live-row')
 return{...matches[0],sources:[...new Set(matches.flatMap(record=>record.sources))]}
}
/** Bind canonical detailed blocks by full content, not a guessed heading boundary. */
export function detailedMeanings(records,text){
 const result=new Map()
 for(const record of records){
  if(record.detail===undefined)continue
  const needle=`[candidate:${record.id}]\n${record.detail}`,start=text.indexOf(needle)
  if(start<0){if(text.includes(`[candidate:${record.id}]`))fail('detail-diverged');continue}
  if(text.indexOf(needle,start+needle.length)>=0)fail('ambiguous-detail')
  const first=text.slice(0,start).split('\n').length,last=first+needle.split('\n').length-1
  for(let at=first;at<=last;at++){if(result.has(at)&&result.get(at).id!==record.id)fail('overlapping-detail');result.set(at,record)}
 }
 return result
}
const termSchema={type:'array',description:'最多4个不同维度的条件；维度为英文小写键，值不超过100字。限制由插件校验。',items:{type:'object',additionalProperties:false,required:['dimension','value'],properties:{dimension:{type:'string'},value:{type:'string'}}}}
export const MEANING_SCHEMA={type:'object',additionalProperties:false,required:['kind'],properties:{kind:{type:'string',enum:MEANING_KINDS},conditions:termSchema,except:termSchema,alternatives:{type:'array',description:'最多3条，每条最多160字。',items:{type:'string'}},falsifiedBy:{type:'array',description:'最多3条待检验反证条件，每条最多160字。',items:{type:'string'}},relations:{type:'array',description:'仅claim/episode：至多3条明确陈述的支持或反向观察关系。target必须为同库现行claim/belief的完整recordId；不能用8位id、猜测目标或用价值证明事实；不表示独立核实。',items:{type:'object',additionalProperties:false,required:['target','stance'],properties:{target:{type:'string'},stance:{type:'string',enum:['supports','contradicts']}}}}}}
// DSH's schema dialect requires boolean additionalProperties; normalizeContext
// performs the bounded key/value checks the public schema cannot express here.
export const CONTEXT_SCHEMA={type:'object',additionalProperties:true}
export const TASK_SCHEMA={type:'object',additionalProperties:false,required:['affectsDecision'],properties:{affectsDecision:{type:'boolean'},experimentPossible:{type:'boolean'}}}
export const INTERPRETATION_SCHEMA={type:'object',additionalProperties:false,required:[...Object.keys(MEANING_SCHEMA.properties).filter(key=>key!=='relations'),'epistemic','applicability','missing','sourceOrigin','sourceRoots','advice'],properties:{...MEANING_SCHEMA.properties,recordId:{type:'string'},observation:OBSERVATION_VIEW_SCHEMA,revision:REVISION_SCHEMA,epistemic:{type:'string'},applicability:{type:'string',enum:['applicable','not-applicable','unknown']},missing:{type:'array',items:{type:'string'}},sourceOrigin:{type:'string'},sourceRoots:{type:'integer'},advice:{type:'object',additionalProperties:false,required:['action','reason','authority'],properties:{action:{type:'string',enum:['skip','continue','ask-context','propose-experiment','verify','use']},reason:{type:'string'},authority:{type:'string',enum:['none']}}}}}
