import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {releaseIdentity,checkDigest,checkFiles} from './release.mjs'
import {classifyGate,compareTiming} from './eval-gate.mjs'
test('correctness failures and unknown exits cannot be waived as timing noise',()=>{
  const timing='[FAIL] C 渲染中位数 < 5 ms'
  assert.equal(classifyGate(1,timing).correctnessPassed,true)
  assert.equal(classifyGate(1,timing).timingPassed,false)
  assert.equal(classifyGate(1,timing+'\n[FAIL] D 无崩溃').correctnessPassed,false)
  assert.equal(classifyGate(1,'').correctnessPassed,false)
  assert.equal(classifyGate(null,timing).correctnessPassed,false)
})
test('paired performance comparison rejects regression, invalid samples and outlier cherry-picking',()=>{
  assert.equal(compareTiming([6,6.1,5.9],[6.2,6.1,6.3]).regressionPassed,true)
  assert.equal(compareTiming([6,6.1,5.9],[8,8.1,8.2]).regressionPassed,false)
  assert.equal(compareTiming([6,6.1,5.9],[1,8.1,8.2]).regressionPassed,false)
  assert.throws(()=>compareTiming([6],[6]))
  assert.throws(()=>compareTiming([6,6,6],[NaN,6,6]))
})
test('release tags must match the beta version and exact repository',()=>{
  assert.equal(releaseIdentity('0.21.0-beta.4','v0.21.0-beta.4').filename,'solopup-memory-0.21.0-beta.4.tgz')
  for(const [version,ref,repo] of [['0.21.0','v0.21.0'],['0.21.0-beta.4','main'],['0.21.0-beta.4','v0.21.0-beta.3'],['0.21.0-beta.4','v0.21.0-beta.4','someone/else']])assert.throws(()=>releaseIdentity(version,ref,repo))
})
test('archive verification refuses modified bytes and mismatched independent digests',()=>{
  const b=Buffer.from('synthetic public archive'),m={sha256:createHash('sha256').update(b).digest('hex'),integrity:'sha512-'+createHash('sha512').update(b).digest('base64')}
  checkDigest(b,m);assert.throws(()=>checkDigest(Buffer.from('changed'),m));assert.throws(()=>checkDigest(b,{...m,integrity:'sha512-wrong'}))
})
test('private stores, research, credentials and traversal cannot enter the release',()=>{
  checkFiles([{path:'index.mjs'},{path:'README.md'}])
  for(const path of ['../secret','/etc/passwd','research/report.json','MEMORY.md','.npmrc','.env','.env.production','x/.git/config','node_modules/other/index.js'])assert.throws(()=>checkFiles([{path}]))
  assert.throws(()=>checkFiles([]))
})
