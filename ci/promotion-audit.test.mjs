import test from 'node:test'
import assert from 'node:assert/strict'
import {readPublic,inspectChannel,auditChannels,renderReport} from './promotion-audit.mjs'
const v='0.24.0-beta.2'
test('discussion parser does not confuse metadata or replies with the original install target',()=>{
  const text='<head>solopup-memory@'+v+'</head><div class="comment-body markdown-body">dsh plugin --profile desktop add solopup-memory@0.21.0-beta.2 --ignore-scripts</div><h2 id="discussion-comment-count">Replies</h2>dsh plugin --profile desktop add solopup-memory@'+v
  const r=inspectChannel({kind:'discussion'},text,v)
  assert.equal(r.status,'needs_review');assert.deepEqual(r.installTargets,['solopup-memory@0.21.0-beta.2'])
  assert.equal(inspectChannel({kind:'discussion'},text.replace('@0.21.0-beta.2','@beta'),v).status,'current')
  assert.equal(inspectChannel({kind:'discussion'},'unknown page',v).status,'unknown')
})
test('catalog archive and npm default channel are reported separately',()=>{
  const entry={url:'https://github.com/OakcoderX/solopup-memory',tarball:`https://github.com/OakcoderX/solopup-memory/releases/download/v${v}/solopup-memory-${v}.tgz`}
  assert.equal(inspectChannel({kind:'catalog'},JSON.stringify(entry),v).status,'archive_current_npm_route_separate')
  assert.equal(inspectChannel({kind:'catalog'},JSON.stringify({...entry,tarball:'old'}),v).status,'needs_update')
})
test('1024 manifest new version alone does not pass the npm target check',()=>{
  const entry={manifest:{version:v},installMethods:[{kind:'github',target:'github:OakcoderX/solopup-memory'}]}
  assert.equal(inspectChannel({kind:'1024'},JSON.stringify(entry),v).status,'needs_review')
  entry.installMethods=[{kind:'npm',target:'solopup-memory@'+v}]
  assert.equal(inspectChannel({kind:'1024'},JSON.stringify(entry),v).status,'current')
})
test('no PR is a stopped permission block, not permission to resubmit',()=>{
  assert.equal(inspectChannel({kind:'pull-requests'},'[]',v).status,'not_submitted_prior_permission_block')
})
test('HTTP denial, rate limit and missing pages are distinct from success',async()=>{
  for(const code of [401,403,429,404,500]){
    let calls=0;const r=await readPublic('https://github.com/test',{fetcher:async()=>{calls++;return new Response('',{status:code})}})
    assert.equal(calls,1);assert.equal(r.httpStatus,code);assert.equal(r.status,[401,403,429].includes(code)?'blocked':'unknown')
  }
})
test('unapproved redirect and oversize responses stop without following or retrying',async()=>{
  let calls=0
  const a=await readPublic('https://github.com/test',{fetcher:async()=>{calls++;return new Response('',{status:302,headers:{location:'https://private.example/'}})}})
  assert.equal(a.status,'unknown');assert.equal(calls,1)
  const b=await readPublic('https://github.com/test',{limit:2,fetcher:async()=>new Response('oversize')})
  assert.equal(b.status,'unknown')
})
test('network failure or malformed schema is unknown, never stale/current',async()=>{
  assert.equal((await readPublic('https://github.com/test',{fetcher:async()=>{throw Error('offline')}})).status,'unknown')
  const rows=await auditChannels([{id:'public',url:'https://github.com/test',kind:'1024'}],v,async()=>({status:'read',text:'not json'}))
  assert.equal(rows[0].status,'unknown')
})
test('reports omit raw third-party bodies and private user fields',async()=>{
  const channel={id:'https://github.com/imsai-sh/dsh-1024store/issues/36',url:'https://api.github.com/repos/imsai-sh/dsh-1024store/issues/36',kind:'issue',nextAction:'Check existing issue'}
  const rows=await auditChannels([channel],v,async()=>({status:'read',text:JSON.stringify({html_url:channel.id,state:'open',comments:0,updated_at:'2026-11-14',body:'PRIVATE_SENTINEL',user:{email:'secret@example.com'}})}))
  const report=renderReport({checkedAt:'now',expectedVersion:v,channels:rows})
  assert.doesNotMatch(report,/PRIVATE_SENTINEL|secret@example.com/);assert.equal(rows[0].status,'tracked_request')
})
test('public reader only makes GET without credentials or an authorization header',async()=>{
  await readPublic('https://github.com/test',{fetcher:async(url,options)=>{assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,undefined);assert.equal(options.credentials,undefined);return new Response('ok')}})
})
