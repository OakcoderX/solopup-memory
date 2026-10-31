import {observationIdentity} from './tool-observations.mjs'
/** Reported evidence changes the assessment, never the truth or authority of a claim.
 * Derive on every read from live records: no stale verdict survives source withdrawal.
 */
const fail=reason=>{throw Error('memory-evidence-'+reason)}
export function assertRelationTargets(meaning,records){
 for(const relation of meaning?.relations??[]){
  const target=records.find(record=>record.id===relation.target)
  if(!target||!['belief','claim'].includes(target.meaning?.kind))fail('target-not-current-claim')
  // A derived evidence assertion cannot recursively become an independent premise.
  if(target.meaning.relations?.length)fail('target-is-derived-relation')
 }
}
/** Source-disjoint means distinct registered roots, not independent real-world events. */
export function assessBelief(target,records,context,matchEvidence){
 if(!['claim','belief'].includes(target.meaning?.kind)||target.meaning.relations?.length)return undefined
 const rootSet=new Set(target.sources),selected=[];let unknown=0,dependent=0
 for(const record of records){
  const relation=record.meaning?.relations?.find(relation=>relation.target===target.id)
  if(!relation)continue
  const match=matchEvidence(record.meaning,context)
  if(match.state==='not-applicable')continue
  if(match.state==='unknown'){unknown++;continue}
  if(record.observation?.outcome==='error')continue
  const roots=record.observation?[observationIdentity(record.observation)]:record.sources
  if(!roots.length||roots.some(root=>rootSet.has(root))){dependent++;continue}
  selected.push({record,roots,stance:relation.stance})
 }
 // Merge all records connected by any common root, including transitive overlap.
 const parents=selected.map((_,i)=>i),find=i=>parents[i]===i?i:(parents[i]=find(parents[i])),byRoot=new Map()
 for(let i=0;i<selected.length;i++)for(const root of selected[i].roots){if(byRoot.has(root))parents[find(i)]=find(byRoot.get(root));else byRoot.set(root,i)}
 const groups=new Map()
 for(let i=0;i<selected.length;i++){const key=find(i),group=groups.get(key)??new Set();group.add(selected[i].stance);groups.set(key,group)}
 const support=selected.filter(row=>row.stance==='supports'),counter=selected.filter(row=>row.stance==='contradicts')
 const state=support.length&&counter.length?'conflicted':counter.length?'challenged':support.length?'reported-support':'unassessed'
 return{state,assessment:'source-linked-observation-relations',worldVerified:false,nativeOutputRecords:selected.filter(row=>row.record.observation).length,
  supportSourceGroups:[...groups.values()].filter(group=>group.has('supports')).length,
  counterSourceGroups:[...groups.values()].filter(group=>group.has('contradicts')).length,
  mixedSourceGroups:[...groups.values()].filter(group=>group.size>1).length,
  dependentReports:dependent,unknownApplicabilityReports:unknown,
  supportingRecords:support.slice(0,3).map(row=>row.record.id),counterRecords:counter.slice(0,3).map(row=>row.record.id),
  omittedRecords:Math.max(0,support.length-3)+Math.max(0,counter.length-3),coverage:'active-managed-records-only'}
}
export function revisionLabel(view){
 const revision=view.revision
 return revision?` 当前证据状态：${revision.state}（revision.state=${revision.state}）；支持来源组${revision.supportSourceGroups}，反向来源组${revision.counterSourceGroups}，同根依赖${revision.dependentReports}，条件未知${revision.unknownApplicabilityReports}。仅受管现行陈述关系，不是独立验证或置信度。原生输出${revision.nativeOutputRecords}条按相同工具参数/输出合并，不代表现实独立实验。`:''
}
export const REVISION_SCHEMA={type:'object',additionalProperties:false,required:['state','assessment','worldVerified','nativeOutputRecords','supportSourceGroups','counterSourceGroups','mixedSourceGroups','dependentReports','unknownApplicabilityReports','supportingRecords','counterRecords','omittedRecords','coverage'],properties:{state:{type:'string',enum:['unassessed','reported-support','challenged','conflicted']},assessment:{type:'string',enum:['source-linked-observation-relations']},worldVerified:{type:'boolean'},nativeOutputRecords:{type:'integer'},supportSourceGroups:{type:'integer'},counterSourceGroups:{type:'integer'},mixedSourceGroups:{type:'integer'},dependentReports:{type:'integer'},unknownApplicabilityReports:{type:'integer'},supportingRecords:{type:'array',items:{type:'string'}},counterRecords:{type:'array',items:{type:'string'}},omittedRecords:{type:'integer'},coverage:{type:'string',enum:['active-managed-records-only']}}}
