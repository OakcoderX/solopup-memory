import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {validateReceipt,assertLatestUnchanged,assertBetaNotOlder,syncReleaseFiles} from './release-sync.mjs'

const repo='OakcoderX/solopup-memory', registry='https://registry.npmjs.org'
const json=file=>JSON.parse(readFileSync(file,'utf8'))
const run=(bin,args,options={})=>execFileSync(bin,args,{encoding:'utf8',...options})
const hash=(bytes,kind='sha256')=>createHash(kind).update(bytes).digest(kind==='sha512'?'base64':'hex')
export function releaseIdentity(version,ref,repository=repo){
  if(repository!==repo)throw Error('unexpected release repository')
  if(!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version))throw Error('automatic publishing is limited to beta versions')
  if(ref!==`v${version}`)throw Error('tag must exactly match package version')
  return {version,tag:ref,filename:`solopup-memory-${version}.tgz`}
}
export function checkDigest(bytes,manifest){
  if(hash(bytes)!==manifest.sha256||`sha512-${hash(bytes,'sha512')}`!==manifest.integrity)throw Error('release archive digest mismatch')
}
export function checkFiles(files){
  if(!files.length||files.some(f=>!f.path||f.path.startsWith('/')||f.path.split('/').some(p=>p==='..')||/(^|\/)(research|node_modules|\.git|\.npmrc|\.env(?:\.[^/]+)?|MEMORY\.md|HANDOVER\.md)(\/|$)/.test(f.path)))throw Error('unexpected file in public archive')
}
export function maySubmit(event,attempt,confirmedUnsubmitted=false){
  return event==='push'&&Number(attempt)===1||event==='workflow_dispatch'&&confirmedUnsubmitted
}
function output(name,value){if(process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,`${name}=${value}\n`,{flag:'a'})}
function loadArtifact(){
  const m=json('release/manifest.json');releaseIdentity(m.version,m.tag)
  if(m.filename!==`solopup-memory-${m.version}.tgz`)throw Error('unexpected archive filename')
  const bytes=readFileSync(join('release',m.filename));checkDigest(bytes,m)
  return {m,bytes}
}
async function prepare(){
  const p=json('package.json'),dry=process.env.RELEASE_DRY_RUN==='true'
  const id=releaseIdentity(p.version,dry?`v${p.version}`:process.env.RELEASE_REF,process.env.GITHUB_REPOSITORY??repo)
  const commit=run('git',['rev-parse','HEAD']).trim()
  if(!dry){run('git',['fetch','origin','main','--no-tags']);run('git',['merge-base','--is-ancestor',commit,'origin/main'])}
  mkdirSync('release',{recursive:true})
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',resolve('release')]))[0]
  if(packed.filename!==id.filename)throw Error('unexpected packed filename');checkFiles(packed.files)
  const bytes=readFileSync(join('release',id.filename)),root=mkdtempSync(join(tmpdir(),'solopup-release-'))
  let total
  try{
    run('tar',['-xzf',resolve('release',id.filename),'-C',root])
    const pkg=json(join(root,'package/package.json')),args=pkg.scripts.test.split(/\s+/)
    if(args[0]!=='node'||args[1]!=='--test'||args.slice(2).some(a=>!a.endsWith('.mjs')&&!/^--test-concurrency=[1-9]\d*$/.test(a)))throw Error('unsupported archive test command')
    const result=run(process.execPath,args.slice(1),{cwd:join(root,'package'),timeout:300000,maxBuffer:16*1024*1024})
    total=Number(/(?:ℹ|#) tests (\d+)/.exec(result)?.[1]);if(!total)throw Error('archive test count missing')
    console.log(result.slice(-1800))
  }finally{rmSync(root,{recursive:true,force:true})}
  const gates=[];const collect=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())collect(path);else if(e.name.endsWith('.json'))gates.push(json(path))}};if(existsSync('source-gates'))collect('source-gates')
  if(process.env.GITHUB_ACTIONS&&(!gates.some(g=>g.platform==='darwin'&&g.passed&&g.regressionPassed)||!gates.some(g=>g.platform==='linux'&&g.passed&&g.correctnessPassed&&g.regressionPassed)))throw Error('required source gate receipts missing')
  const manifest={...id,commit,repository:repo,channel:'beta',engines:p.engines,sourceGates:gates,sha256:hash(bytes),integrity:`sha512-${hash(bytes,'sha512')}`,files:packed.files.length,packagedTests:total,node:process.version,npm:run('npm',['--version']).trim(),scope:'mechanical archive checks; fixed-beta.3 same-runner regression required; hosted absolute 5ms not certified; not stable semantic or real DSH host acceptance'}
  writeFileSync('release/manifest.json',JSON.stringify(manifest,null,2)+'\n');writeFileSync('release/SHA256SUMS',`${manifest.sha256}  ${id.filename}\n`)
  const changelog=readFileSync('CHANGELOG.md','utf8'),start=changelog.indexOf(`## ${p.version}`),end=start<0?-1:changelog.indexOf('\n## ',start+1)
  const notes=start<0?'Public text-memory beta.':changelog.slice(start,end<0?undefined:end).trim()
  writeFileSync('release/notes.md',`${notes}\n\nPublished through the repository's npm trusted publisher (OIDC). This is a public beta, not stable semantic acceptance. Release receipts record mechanical checks and archive integrity; private data and historical copies are not erased.\n`)
  output('version',p.version);output('tag',id.tag);console.log(JSON.stringify(manifest))
}
async function fetchJson(url){
  const r=await fetch(url,{signal:AbortSignal.timeout(20000),redirect:'error'})
  if(r.status===404)return undefined
  if(!r.ok)throw Error(`registry HTTP ${r.status}`)
  return r.json()
}
async function verifyPublic(m,attempts=45){
  for(let n=0;n<attempts;n++){
    try{
      const v=await fetchJson(`${registry}/solopup-memory/${m.version}?verify=${Date.now()}`)
      if(v){
        if(v.dist?.integrity!==m.integrity)throw Error('immutable public version differs from tested archive')
        const url=new URL(v.dist.tarball)
        if(url.origin!==registry||url.pathname!==`/solopup-memory/-/${m.filename}`)throw Error('unexpected registry tarball URL')
        const r=await fetch(url,{signal:AbortSignal.timeout(20000),redirect:'error'})
        if(r.ok){const bytes=Buffer.from(await r.arrayBuffer());checkDigest(bytes,m);return {version:m.version,tarball:url.href,sha256:m.sha256,integrity:m.integrity,publicDownloadVerified:true}}
      }
    }catch(e){if(/differs|digest|unexpected/.test(e.message))throw e;console.log(`Registry propagation attempt ${n+1}: ${e.message}`)}
    if(n+1<attempts)await new Promise(r=>setTimeout(r,20000))
  }
  throw Error('public registry propagation did not complete within the bounded wait; do not republish')
}
async function publish(){
  const {m}=loadArtifact()
  if(run('git',['rev-parse','HEAD']).trim()!==m.commit)throw Error('checkout does not match tested source')
  if(!process.env.ACTIONS_ID_TOKEN_REQUEST_URL||!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw Error('GitHub OIDC identity is required; no long-lived-token fallback')
  const latestBefore=(await fetchJson(`${registry}/solopup-memory/latest`))?.version
  if(typeof latestBefore!=='string')throw Error('cannot snapshot npm latest; stop before publishing')
  const betaBefore=(await fetchJson(`${registry}/solopup-memory/beta`))?.version
  const existing=await fetchJson(`${registry}/solopup-memory/${m.version}?preflight=${Date.now()}`)
  if(existing){if(existing.dist?.integrity!==m.integrity)throw Error('immutable public version differs from tested archive');console.log('Identical version already public; verifying without republishing')}
  else{
    assertBetaNotOlder(m.version,betaBefore)
    if(!maySubmit(process.env.GITHUB_EVENT_NAME,process.env.GITHUB_RUN_ATTEMPT,process.env.RELEASE_CONFIRM_UNSUBMITTED==='true'))throw Error('Prior submission outcome must be inspected before another publish; a public 404 does not prove a version was never submitted')
    writeFileSync('release/submission.json',JSON.stringify({version:m.version,sha256:m.sha256,phase:'attempting',at:new Date().toISOString()})+'\n')
    run('npm',['publish','./'+join('release',m.filename),'--tag','beta','--access','public','--ignore-scripts','--registry',registry],{stdio:'inherit',timeout:180000})
    writeFileSync('release/submission.json',JSON.stringify({version:m.version,sha256:m.sha256,phase:'accepted-by-cli',at:new Date().toISOString()})+'\n')
  }
  const verified=await verifyPublic(m)
  const latestAfter=(await fetchJson(`${registry}/solopup-memory/latest`))?.version
  assertLatestUnchanged(latestBefore,latestAfter)
  const receipt={...m,...verified,latestBefore,latestAfter,publisher:'GitHub Actions OIDC',runUrl:`https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,publishedAt:new Date().toISOString()}
  writeFileSync('release/npm-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(verified))
}
async function finalize(){
  const {m}=loadArtifact(),receipt=json('release/npm-receipt.json')
  validateReceipt(m,receipt)
  // An old workflow replay must not replace the current public-beta guidance.
  const currentBeta=(await fetchJson(`${registry}/solopup-memory/beta`))?.version
  if(currentBeta!==m.version)throw Error('release is not the current npm beta; inspect before synchronizing current documentation')
  if(receipt.latestAfter!==undefined)assertLatestUnchanged(receipt.latestAfter,(await fetchJson(`${registry}/solopup-memory/latest`))?.version)
  const release=spawnSync('gh',['release','view',m.tag,'--json','tagName'],{encoding:'utf8'})
  const assets=[m.filename,'SHA256SUMS','manifest.json','npm-receipt.json'].map(f=>join('release',f))
  if(release.status!==0)run('gh',['release','create',m.tag,...assets,'--verify-tag','--prerelease','--latest=false','--title',`SoloPup Memory ${m.version}`,'--notes-file','release/notes.md'],{stdio:'inherit'})
  else{
    const root=mkdtempSync(join(tmpdir(),'solopup-existing-release-'))
    try{run('gh',['release','download',m.tag,'--pattern',m.filename,'--dir',root]);checkDigest(readFileSync(join(root,m.filename)),m)}finally{rmSync(root,{recursive:true,force:true})}
  }
  const plan=syncReleaseFiles(m,receipt)
  run('git',['config','user.name','github-actions[bot]']);run('git',['config','user.email','41898282+github-actions[bot]@users.noreply.github.com']);run('git',['add',...Object.keys(plan.files)])
  // A concurrent main update rejects this ordinary push. Never force, reset, or
  // replay a whole README over newer work; a recovery starts from fresh main.
  if(spawnSync('git',['diff','--cached','--quiet']).status!==0){run('git',['commit','-m',`Synchronize verified beta ${m.version}`]);run('git',['push','origin','HEAD:main'],{stdio:'inherit'})}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const command=process.argv[2];if(!['prepare','publish','finalize'].includes(command))throw Error('expected prepare, publish, or finalize')
  await ({prepare,publish,finalize}[command])()
}
