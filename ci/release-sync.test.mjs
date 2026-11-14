import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {compareBeta,validateReceipt,assertLatestUnchanged,assertBetaNotOlder,installBlocks,managedBlock,checkManagedDocument,planReleaseSync,currentReleaseDocument} from './release-sync.mjs'
const m={version:'0.24.0-beta.10',tag:'v0.24.0-beta.10',repository:'OakcoderX/solopup-memory',commit:'a'.repeat(40),sha256:'b'.repeat(64),integrity:'sha512-'+createHash('sha512').update('fixture').digest('base64'),filename:'solopup-memory-0.24.0-beta.10.tgz',channel:'beta',engines:{dsh:'>=0.2.1-rc.0 <0.3.0'}}
const receipt={...m,publicDownloadVerified:true,tarball:'https://registry.npmjs.org/solopup-memory/-/'+m.filename,publishedAt:'2026-11-14T00:00:00Z'}
const documents=Object.fromEntries(Object.entries(installBlocks).map(([p,b])=>[p,'before\n'+managedBlock(b)+'\nafter\n']))
const index={format:1,plugins:[{name:'solopup-memory',versions:[]}]}
const plan=(overrides={})=>planReleaseSync({manifest:m,receipt,index,documents,...overrides})
test('beta ordering is numeric, arbitrary stable/tag/range input is refused',()=>{
  assert.equal(compareBeta('0.24.0-beta.9','0.24.0-beta.10'),-1)
  assert.equal(compareBeta('0.25.0-beta.1','0.24.0-beta.99'),1)
  for(const v of ['latest','0.24.0','0.24.0-beta.01','^0.24.0-beta.1'])assert.throws(()=>compareBeta(v,m.version))
  assert.throws(()=>assertBetaNotOlder('0.24.0-beta.9',m.version))
})
test('receipt binds every release identity and digest field',()=>{
  assert.equal(validateReceipt(m,receipt),receipt)
  for(const key of ['version','tag','repository','commit','sha256','integrity','filename','channel'])assert.throws(()=>validateReceipt(m,{...receipt,[key]:'changed'}))
  for(const patch of [{publicDownloadVerified:false},{tarball:'https://example.com/package.tgz'},{publishedAt:'invalid'}])assert.throws(()=>validateReceipt(m,{...receipt,...patch}))
})
test('latest guard only accepts known unchanged values',()=>{
  assert.doesNotThrow(()=>assertLatestUnchanged('0.21.0-beta.1','0.21.0-beta.1'))
  for(const values of [[undefined,undefined],['old','new'],['old',undefined]])assert.throws(()=>assertLatestUnchanged(...values))
})
test('managed docs preserve all bytes outside exact blocks and fail closed on edits',()=>{
  const body=installBlocks['README.md'],full=documents['README.md']
  assert.equal(checkManagedDocument(full,body),full)
  for(const text of ['no block',full+managedBlock(body),full.replace('@beta','@latest'),full.replace('solopup:beta-install:end','missing')])assert.throws(()=>checkManagedDocument(text,body))
  assert.equal(plan().files['README.md'],full)
})
test('same receipt is idempotent and does not modify unrelated index data',()=>{
  const first=plan(),saved=JSON.parse(first.files['market/index.json'])
  const second=plan({index:saved})
  assert.deepEqual(second,first)
  const third=plan({index:{...saved,other:'preserve'}})
  assert.equal(JSON.parse(third.files['market/index.json']).other,'preserve')
  assert.equal(saved.plugins[0].versions.length,1)
})
test('old replay preserves current docs and sorts historical versions without downgrade',()=>{
  const newer={version:'0.25.0-beta.1',source:{type:'npm',registry:'https://registry.npmjs.org/'}}
  const result=plan({index:{...index,plugins:[{name:'solopup-memory',versions:[newer]}]}})
  assert.equal(result.stale,true);assert.equal(result.currentVersion,newer.version)
  assert.deepEqual(Object.keys(result.files),['market/index.json'])
  assert.equal(JSON.parse(result.files['market/index.json']).plugins[0].versions[0].version,newer.version)
})
test('mismatched existing market source is not silently overwritten',()=>{
  assert.throws(()=>plan({index:{plugins:[{name:'solopup-memory',versions:[{version:m.version,source:{type:'git',url:'other'}}]}]}}))
  const v={version:m.version,source:{type:'npm',registry:'https://registry.npmjs.org/'}}
  assert.throws(()=>plan({index:{plugins:[{name:'solopup-memory',versions:[v,v]}]}}),/duplicate/)
})
test('fixed release document has exact install and evidence without claiming semantic acceptance',()=>{
  const doc=currentReleaseDocument(m)
  assert.ok(doc.includes('solopup-memory@'+m.version));assert.ok(doc.includes(m.sha256));assert.ok(doc.includes('not a stable release'))
  assert.ok(doc.includes('do not prove every host version was tested'))
  assert.equal(currentReleaseDocument({...m,runUrl:'changed',publishedAt:'changed'}),doc)
})
test('checked-in install blocks are synchronized',()=>{
  for(const [p,body] of Object.entries(installBlocks))assert.doesNotThrow(()=>checkManagedDocument(readFileSync(new URL('../'+p,import.meta.url),'utf8'),body))
})
test('workflow has global release serialization; audit has read-only permissions and no publish command',()=>{
  const publish=readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8')
  assert.ok(publish.includes('group: solopup-memory-beta-release'));assert.ok(publish.includes('cancel-in-progress: false'))
  assert.ok(publish.includes('needs: [publish, github-and-market]'));assert.ok(publish.includes("always() && needs.publish.result == 'success'"))
  const audit=readFileSync(new URL('../.github/workflows/version-sync.yml',import.meta.url),'utf8')
  assert.ok(audit.includes('contents: read'));assert.ok(audit.includes('persist-credentials: false'));assert.ok(audit.includes('ref: main'))
  assert.doesNotMatch(audit,/contents: write|id-token: write|npm publish|GH_TOKEN/)
  const source=readFileSync(new URL('./release.mjs',import.meta.url),'utf8')
  assert.doesNotMatch(source,/['"]--force['"]|dist-tag.*add|git reset/)
})
