/** Synthetic regression cases, including bytes produced by the frozen old writer. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {assertMeaningSatisfiable,normalizeMeaning,applicability} from './meaning.mjs'
import {assessCandidate} from './capture-evidence.mjs'
import {writeFixtureMemory} from './fixture-host.mjs'
import {candidateSnapshot,stageCandidate} from './candidates.mjs'
import {adoptCandidate,storeRevision} from './index.mjs'
import {prepareValidationPrompt,ValidationSubmission} from './capture-validation.mjs'
import {VALIDATION_FIELDS} from './capture-validation-contract.mjs'
const contradictory={kind:'preference',conditions:[{dimension:'document_kind',value:'exploratory_draft'}],except:[{dimension:'document_kind',value:'exploratory_draft'}]}
const valid={...contradictory,except:[{dimension:'document_kind',value:'final'}]}
const owner={id:'synthetic-owner',role:'user',hash:'a'.repeat(64),text:'长期处理探索性草稿时先确认试验目标。'}
const candidate={type:'user',scope:'global',basis:'explicit',summary:'探索性草稿先确认试验目标',meaning:contradictory,evidence:[{messageId:owner.id,quote:owner.text}]}
function box(run){const dir=realpathSync(mkdtempSync(join(tmpdir(),'rule-admission-')));try{return run(dir)}finally{rmSync(dir,{recursive:true,force:true})}}
test('new admission rejects canonical equality between a required and excluded term',()=>{
 assert.throws(()=>assertMeaningSatisfiable(contradictory),{code:'memory-meaning-contradictory-conditions'})
 assert.throws(()=>assertMeaningSatisfiable({...contradictory,conditions:[{dimension:'document_kind',value:'  exploratory_draft  '}]}),/contradictory-conditions/)
 assert.equal(assessCandidate(candidate,[owner],false).reason,'invalid-meaning')
})
test('different excluded values and independent exclusions still allow useful contexts',()=>{
 const meaning=assertMeaningSatisfiable(valid)
 assert.equal(applicability(meaning,{document_kind:'exploratory_draft'}).state,'applicable')
 assert.equal(applicability(assertMeaningSatisfiable({...valid,except:[{dimension:'audience',value:'adults'}]}),{document_kind:'exploratory_draft',audience:'children'}).state,'applicable')
 assert.equal(assessCandidate({...candidate,meaning:valid},[owner],false).status,'eligible')
})
test('direct publication rejects impossible meaning before creating a data directory',()=>box(dir=>{
 const target=join(dir,'not-created');assert.throws(()=>writeFixtureMemory({dir:target,type:'user',scope:'global',summary:candidate.summary,meaning:contradictory}),/contradictory-conditions/)
 assert.equal(existsSync(target),false)
}))
test('reviewed adoption cannot publish an impossible pending candidate or change its ledger',()=>box(dir=>{
 const pending=stageCandidate(dir,{...candidate,sessionId:'synthetic-review',indexRevision:storeRevision(dir),evidence:[{messageId:owner.id,hash:owner.hash,quote:owner.text}]})
 const preview=adoptCandidate(dir,pending.id,{scope:'global'}),before=readFileSync(join(dir,'.candidates.json'),'utf8')
 assert.throws(()=>adoptCandidate(dir,pending.id,{apply:true,scope:'global',reviewedIndex:preview.reviewedIndex,candidateRevision:preview.candidateRevision}),/contradictory-conditions/)
 assert.equal(readFileSync(join(dir,'.candidates.json'),'utf8'),before);assert.equal(existsSync(join(dir,'MEMORY.md')),false)
}))
test('old effective self-excluding records retain their identities and remain readable without rewriting',()=>box(dir=>{
 const fixture=JSON.parse(readFileSync(new URL('./corpus/legacy-self-excluding-dev36.json',import.meta.url)))
 for(const[name,content]of Object.entries(fixture.files))writeFileSync(join(dir,name),content)
 const records=candidateSnapshot(dir,'global').records;assert.equal(records.length,1);assert.equal(records[0].status,'recorded')
 assert.deepEqual(normalizeMeaning(records[0].meaning),normalizeMeaning(contradictory))
 assert.equal(applicability(records[0].meaning,{document_kind:'exploratory_draft'}).state,'not-applicable')
 for(const[name,content]of Object.entries(fixture.files))assert.equal(readFileSync(join(dir,name),'utf8'),content)
}))
test('a scripted all-supported model vote cannot certify structurally impossible applicability',()=>{
 const prepared=prepareValidationPrompt([owner],[candidate]),r=prepared.records[0]
 const batch=new ValidationSubmission(prepared).batch(JSON.stringify({checks:[{candidateId:r.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(k=>[k,'supported'])),evidence:candidate.evidence}]}))
 assert.equal(batch.verdicts[0].status,'rejected');assert.deepEqual(batch.verdicts[0].unsupportedFields,['applicability'])
})
