import test from 'node:test'
import assert from 'node:assert/strict'
import {isRevisionAdmissionError} from './revision-admission.mjs'
import {compileValueRevision,normalizeFieldLineage} from './field-lineage.mjs'
import {captureRevision} from './capture-revision.mjs'
const caught=fn=>{try{fn()}catch(error){return error}assert.fail('expected a real guard refusal')}
const parent={id:'a'.repeat(64),status:'recorded',scope:'global',meaning:{kind:'preference',conditions:[{dimension:'document_kind',value:'draft'}]},sources:['b'.repeat(64),'c'.repeat(64)]}
test('real value-change and target-identity guards are preparation refusals',()=>{
 const changed=caught(()=>compileValueRevision(parent,{kind:'preference',conditions:[{dimension:'document_kind',value:'final'}]},'global'))
 assert.equal(changed.code,'memory-revision-meaning-change-needs-complete-replacement');assert.equal(isRevisionAdmissionError(changed),true)
 assert.equal(isRevisionAdmissionError(caught(()=>captureRevision({scope:'global',basis:'explicit',supersedes:'unbound fragment'},[]))),true)
})
test('a real four-root proposal remains refused; no source certificate is truncated',()=>{
 const compiled=compileValueRevision(parent,{kind:'preference'},'global'),before=structuredClone(compiled)
 const error=caught(()=>normalizeFieldLineage(compiled.fieldLineage,{scope:'global',meaning:compiled.meaning,ownSources:['d'.repeat(64),'e'.repeat(64)]}))
 assert.equal(error.code,'memory-revision-source-overflow');assert.equal(isRevisionAdmissionError(error),true);assert.deepEqual(compiled,before)
})
test('corrupt stored field certificates, disk errors and arbitrary strings never become ordinary proposal rejections',()=>{
 const c=compileValueRevision(parent,{kind:'preference'},'global');c.fieldLineage.fields.kind.valueHash='f'.repeat(64)
 const error=caught(()=>normalizeFieldLineage(c.fieldLineage,{scope:'global',meaning:c.meaning,ownSources:['d'.repeat(64)]}))
 assert.equal(error.code,'memory-revision-field-value-mismatch');assert.equal(isRevisionAdmissionError(error),false)
 for(const e of [Object.assign(Error('disk I/O failed'),{code:'EIO'}),Object.assign(Error('candidate-corrupt-state'),{code:'candidate-corrupt-state'}),TypeError('bad value'),Error('memory-revision-source-overflow'),null])assert.equal(isRevisionAdmissionError(e),false)
})
