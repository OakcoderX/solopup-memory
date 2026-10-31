/** Code-owned provenance for inherited metadata. Never treats a prior interpretation as verified truth. */
import {createHash} from 'node:crypto'
import {meaningForScope} from './meaning.mjs'
export const INHERITED_FIELDS=Object.freeze(['scope','kind','conditions','except','expires'])
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...keys].sort().join('|')
const fail=code=>{const e=Error('memory-revision-'+code);e.code=e.message;throw e}
const field=(scope,meaning,name,expires)=>name==='scope'?scope:name==='expires'?(expires??null):meaning[name]
const sourceLine=parent=>parent.indexLine??`- [${parent.type}] ${parent.summary} — ${parent.detail===undefined?'索引摘要':parent.type+'.md'}${parent.expires===undefined?'':` (exp:${parent.expires})`}`
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
function roots(value){if(!Array.isArray(value)||!value.length||value.length>3||value.some(v=>!hex(v))||!same(value,[...new Set(value)].sort()))fail('invalid-field-roots');return [...value]}

export function normalizeFieldLineage(value,{scope,meaning,ownSources,observation,expires}){
 if(value===undefined)return undefined
 if(observation!==undefined||!exact(value,['schema','parentId','fields'])||value.schema!==1||!hex(value.parentId)||!exact(value.fields,INHERITED_FIELDS)||!meaning)fail('invalid-field-lineage')
 const fields={}
 for(const name of INHERITED_FIELDS){const f=value.fields[name];if(!exact(f,['valueHash','roots'])||f.valueHash!==hash(field(scope,meaning,name,expires)))fail('field-value-mismatch');fields[name]={valueHash:f.valueHash,roots:roots(f.roots)}}
 const all=[...new Set([...roots(ownSources),...Object.values(fields).flatMap(f=>f.roots)])].sort()
 if(all.length>3)fail('source-overflow')
 return{schema:1,parentId:value.parentId,fields}
}
export function inheritedRoots(value){return value?[...new Set(Object.values(value.fields).flatMap(f=>f.roots))].sort():[]}

export function revisionMode(mode,supersedes){
 if(supersedes===undefined){if(mode!==undefined)fail('mode-needs-target');return undefined}
 if(mode!==undefined&&!['value','replace'].includes(mode))fail('invalid-mode')
 return mode??'value'
}

/** The model chooses a target/mode, but never supplies its inherited certificate. */
export function prepareValueRevision(target,records,exactLine){
 const mode=revisionMode(target.revisionMode,target.supersedes)
 if(mode===undefined||mode==='replace')return{}
 const parents=records.filter(parent=>parent.scope===target.scope&&sourceLine(parent)===exactLine)
 if(parents.length!==1)fail('target-needs-complete-replacement')
 const parent=parents[0],compiled=compileValueRevision(parent,target.meaning,target.scope,target.expires)
 return{...compiled,inheritedMetadata:{parentId:parent.id,indexLine:exactLine,scope:parent.scope,meaning:compiled.meaning,expires:parent.expires??null,sourceRoots:inheritedRoots(compiled.fieldLineage),boundary:'Code-bound prior interpretation; not new owner evidence or world verification.'}}
}

/** Only stable method metadata is inherited; hypothesis/evidence content needs an explicit replacement. */
export function compileValueRevision(parent,proposedMeaning,scope,proposedExpiry){
 if(!parent||!hex(parent.id)||!['recorded','adopted'].includes(parent.status)||parent.scope!==scope||!parent.meaning||parent.observation)fail('target-needs-complete-replacement')
 const prior=meaningForScope(parent.meaning,scope),proposed=meaningForScope(proposedMeaning,scope)
 if(!prior||!proposed||!['preference','decision','claim'].includes(prior.kind)||prior.kind!==proposed.kind)fail('kind-change-needs-complete-replacement')
 if(['alternatives','falsifiedBy','relations'].some(k=>(prior[k]?.length??0)||(proposed[k]?.length??0)))fail('content-meaning-needs-complete-replacement')
 if(proposedExpiry!==undefined&&proposedExpiry!==parent.expires)fail('retention-change-needs-complete-replacement')
 for(const k of ['conditions','except'])if(proposed[k].length&&!same(proposed[k],prior[k]))fail('meaning-change-needs-complete-replacement')
 const fields={}
 for(const name of INHERITED_FIELDS){const inherited=parent.fieldLineage?.fields[name];fields[name]={valueHash:hash(field(scope,prior,name,parent.expires)),roots:roots(inherited?.roots??parent.sources)}}
 return{meaning:prior,expires:parent.expires,fieldLineage:{schema:1,parentId:parent.id,fields},inheritedFields:[...INHERITED_FIELDS],boundary:'Inherited source-linked interpretation, not independent truth verification.'}
}

/** Called inside the publication lock while the exact replaced parent is still current. */
export function assertFieldLineageParent(child,parent,supersededLine){
 if(!child.fieldLineage)return
 if(!parent||parent.id!==child.fieldLineage.parentId)fail('parent-unavailable')
 const parentLine=sourceLine(parent)
 if(parentLine!==supersededLine)fail('parent-target-mismatch')
 const expected=compileValueRevision(parent,child.meaning,child.scope,child.expires)
 if(!same(expected.meaning,child.meaning)||!same(expected.fieldLineage,child.fieldLineage))fail('parent-field-mismatch')
}
