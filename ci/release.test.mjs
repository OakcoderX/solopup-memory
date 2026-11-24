import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {releaseIdentity,checkDigest,checkFiles,checkLongHistory,checkDesktopAcceptance,maySubmit} from './release.mjs'
test('unknown prior submissions cannot be automatically repeated after a 404',()=>{
  assert.equal(maySubmit('push',1),true)
  assert.equal(maySubmit('push',2),false)
  assert.equal(maySubmit('workflow_dispatch',1),false)
  assert.equal(maySubmit('workflow_dispatch',1,true),true)
})
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
test('only an exact version tag in the official repository determines the npm channel',()=>{
  for(const [version,channel] of [['0.21.0-beta.4','beta'],['0.26.0-rc.1','next'],['0.26.0','latest']]){
    const id=releaseIdentity(version,`v${version}`)
    assert.equal(id.filename,`solopup-memory-${version}.tgz`)
    assert.equal(id.channel,channel)
  }
  for(const [version,ref,repo] of [['0.26.0-dev.1','v0.26.0-dev.1'],['0.21.0-beta.4','main'],['0.21.0-beta.4','v0.21.0-beta.3'],['0.21.0-beta.4','v0.21.0-beta.4','someone/else']])assert.throws(()=>releaseIdentity(version,ref,repo))
})
test('archive verification refuses modified bytes and mismatched independent digests',()=>{
  const b=Buffer.from('synthetic public archive'),m={sha256:createHash('sha256').update(b).digest('hex'),integrity:'sha512-'+createHash('sha512').update(b).digest('base64')}
  checkDigest(b,m);assert.throws(()=>checkDigest(Buffer.from('changed'),m));assert.throws(()=>checkDigest(b,{...m,integrity:'sha512-wrong'}))
})
test('history acceptance must describe the exact successful release archive', () => {
  const manifest = { version: '0.25.0-beta.1', sha256: 'example-archive-sha' }
  const receipt = { passed: true, pluginVersion: manifest.version, archiveSha256: manifest.sha256 }
  checkLongHistory(receipt, manifest)
  assert.throws(() => checkLongHistory(undefined, manifest))
  assert.throws(() => checkLongHistory({ ...receipt, passed: false }, manifest))
  assert.throws(() => checkLongHistory({ ...receipt, archiveSha256: 'different-archive' }, manifest))
})
test('stable publishing requires all real-desktop checks on the exact stable archive',()=>{
  const manifest={version:'0.26.0',sha256:'expected-archive'}
  const checks={upgrade_readback:true,rollback_readback:true,fresh_rule_and_exception:true,withdrawal_and_scope:true,delivery_positive_and_negative:true}
  const receipt={passed:true,pluginVersion:manifest.version,archiveSha256:manifest.sha256,hostVersion:'0.2.2-rc.3',model:'deepseek-flash',modelCalls:3,checks}
  checkDesktopAcceptance(receipt,manifest)
  assert.throws(()=>checkDesktopAcceptance({...receipt,modelCalls:0},manifest))
  assert.throws(()=>checkDesktopAcceptance({...receipt,pluginVersion:'0.26.0-rc.1'},manifest))
  assert.throws(()=>checkDesktopAcceptance({...receipt,archiveSha256:'another-archive'},manifest))
  assert.throws(()=>checkDesktopAcceptance({...receipt,checks:{...checks,rollback_readback:false}},manifest))
})
test('private stores, research, credentials and traversal cannot enter the release',()=>{
  checkFiles([{path:'index.mjs'},{path:'README.md'}])
  for(const path of ['../secret','/etc/passwd','research/report.json','MEMORY.md','.npmrc','.env','.env.production','x/.git/config','node_modules/other/index.js'])assert.throws(()=>checkFiles([{path}]))
  assert.throws(()=>checkFiles([]))
})
