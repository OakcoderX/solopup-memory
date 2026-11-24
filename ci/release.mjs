import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'

const repo='OakcoderX/solopup-memory', registry='https://registry.npmjs.org'
const json=file=>JSON.parse(readFileSync(file,'utf8'))
const run=(bin,args,options={})=>execFileSync(bin,args,{encoding:'utf8',...options})
const hash=(bytes,kind='sha256')=>createHash(kind).update(bytes).digest(kind==='sha512'?'base64':'hex')
export function releaseIdentity(version,ref,repository=repo){
  if(repository!==repo)throw Error('unexpected release repository')
  const match=/^\d+\.\d+\.\d+(?:-(beta|rc)\.\d+)?$/.exec(version)
  if(!match)throw Error('version must be stable, beta, or a release candidate')
  if(ref!==`v${version}`)throw Error('tag must exactly match package version')
  const channel=match[1]==='beta'?'beta':match[1]==='rc'?'next':'latest'
  return {version,tag:ref,channel,filename:`solopup-memory-${version}.tgz`}
}
export function checkDigest(bytes,manifest){
  if(hash(bytes)!==manifest.sha256||`sha512-${hash(bytes,'sha512')}`!==manifest.integrity)throw Error('release archive digest mismatch')
}
export function checkFiles(files){
  if(!files.length||files.some(f=>!f.path||f.path.startsWith('/')||f.path.split('/').some(p=>p==='..')||/(^|\/)(research|node_modules|\.git|\.npmrc|\.env(?:\.[^/]+)?|MEMORY\.md|HANDOVER\.md)(\/|$)/.test(f.path)))throw Error('unexpected file in public archive')
}
export function checkLongHistory(receipt, manifest) {
  if (!receipt?.passed || receipt.pluginVersion !== manifest.version || receipt.archiveSha256 !== manifest.sha256) {
    throw Error('matching DSH long-history receipt is required for publication')
  }
}
export function checkDesktopAcceptance(receipt,manifest){
  const required=['upgrade_readback','rollback_readback','fresh_rule_and_exception','withdrawal_and_scope','delivery_positive_and_negative']
  if(receipt?.passed!==true||receipt.pluginVersion!==manifest.version||receipt.archiveSha256!==manifest.sha256||
     typeof receipt.hostVersion!=='string'||!receipt.hostVersion||typeof receipt.model!=='string'||!receipt.model||
     !Number.isInteger(receipt.modelCalls)||receipt.modelCalls<1||required.some(check=>receipt.checks?.[check]!==true)){
    throw Error('matching real desktop acceptance receipt is required for stable publication')
  }
}
export function maySubmit(event,attempt,confirmedUnsubmitted=false){
  return event==='push'&&Number(attempt)===1||event==='workflow_dispatch'&&confirmedUnsubmitted
}
function output(name,value){if(process.env.GITHUB_OUTPUT)writeFileSync(process.env.GITHUB_OUTPUT,`${name}=${value}\n`,{flag:'a'})}
function loadArtifact(){
  const m=json('release/manifest.json'),id=releaseIdentity(m.version,m.tag)
  if(m.filename!==id.filename||m.channel!==id.channel)throw Error('unexpected archive identity')
  const bytes=readFileSync(join('release',m.filename));checkDigest(bytes,m)
  return {m,bytes}
}
async function prepare(){
  const p=json('package.json'),dry=process.env.RELEASE_DRY_RUN==='true'
  const id=releaseIdentity(p.version,dry?`v${p.version}`:process.env.RELEASE_REF,process.env.GITHUB_REPOSITORY??repo)
  const commit=run('git',['rev-parse','HEAD']).trim()
  if(!dry){
    if(run('git',['rev-parse',`refs/tags/${id.tag}^{commit}`]).trim()!==commit)throw Error('checkout does not match the release tag')
    run('git',['fetch','origin','main','--no-tags'])
    if(id.channel==='latest'){
      const branch=`refs/heads/release/${id.version}`
      const [stagedCommit]=run('git',['ls-remote','--exit-code','origin',branch]).trim().split(/\s+/)
      if(stagedCommit!==commit)throw Error('stable tag must match the staged release branch')
      const alreadyOnMain=spawnSync('git',['merge-base','--is-ancestor',commit,'origin/main']).status===0
      if(!alreadyOnMain)run('git',['merge-base','--is-ancestor','origin/main',commit])
    }else run('git',['merge-base','--is-ancestor',commit,'origin/main'])
  }
  mkdirSync('release',{recursive:true})
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',resolve('release')]))[0]
  if(packed.filename!==id.filename)throw Error('unexpected packed filename');checkFiles(packed.files)
  const bytes=readFileSync(join('release',id.filename)),root=mkdtempSync(join(tmpdir(),'solopup-release-'))
  let total
  try{
    if(id.channel==='latest'&&!dry){
      const receipt=json(join('release-evidence',`${id.version}.json`))
      checkDesktopAcceptance(receipt,{...id,sha256:hash(bytes)})
      writeFileSync('release/desktop-acceptance.json',JSON.stringify(receipt,null,2)+'\n')
    }
    run('tar',['-xzf',resolve('release',id.filename),'-C',root])
    const pkg=json(join(root,'package/package.json')),args=pkg.scripts.test.split(/\s+/)
    if(args[0]!=='node'||args[1]!=='--test'||args.slice(2).some(a=>!a.endsWith('.mjs')&&!/^--test-concurrency=[1-9]\d*$/.test(a)))throw Error('unsupported archive test command')
    const result=run(process.execPath,args.slice(1),{cwd:join(root,'package'),timeout:300000,maxBuffer:16*1024*1024})
    total=Number(/(?:ℹ|#) tests (\d+)/.exec(result)?.[1]);if(!total)throw Error('archive test count missing')
    console.log(result.slice(-1800))
    if (process.env.GITHUB_ACTIONS || process.env.DSH_CLI) {
      const host = join(root, 'dsh-host')
      const cli = process.env.DSH_CLI ?? join(host, 'node_modules', '.bin', 'dsh')
      if (!process.env.DSH_CLI) {
        run('npm', ['install', '--prefix', host, '--ignore-scripts', '--no-audit', '--no-fund', '@deepseek-ai/dsh@0.2.2-rc.1'], { timeout: 180000 })
      }
      const history = run(process.execPath, ['scripts/probe-long-history.mjs', '--tgz', resolve('release',id.filename)], {
        cwd: join(root,'package'), env: { ...process.env, DSH_CLI: cli }, timeout: 120000,
      })
      checkLongHistory(JSON.parse(history), { ...id, sha256: hash(bytes) })
      writeFileSync('release/long-history.json', history)
    }
  }finally{rmSync(root,{recursive:true,force:true})}
  const gates=[];const collect=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())collect(path);else if(e.name.endsWith('.json'))gates.push(json(path))}};if(existsSync('source-gates'))collect('source-gates')
  if(process.env.GITHUB_ACTIONS&&(!gates.some(g=>g.platform==='darwin'&&g.passed&&g.regressionPassed)||!gates.some(g=>g.platform==='linux'&&g.passed&&g.correctnessPassed&&g.regressionPassed)))throw Error('required source gate receipts missing')
  const manifest={...id,commit,repository:repo,engines:p.engines,sourceGates:gates,sha256:hash(bytes),integrity:`sha512-${hash(bytes,'sha512')}`,files:packed.files.length,packagedTests:total,node:process.version,npm:run('npm',['--version']).trim(),scope:'mechanical archive checks and fixed-beta.3 same-runner regression; stable desktop acceptance is a separate receipt'}
  writeFileSync('release/manifest.json',JSON.stringify(manifest,null,2)+'\n');writeFileSync('release/SHA256SUMS',`${manifest.sha256}  ${id.filename}\n`)
  const changelog=readFileSync('CHANGELOG.md','utf8'),start=changelog.indexOf(`## ${p.version}`),end=start<0?-1:changelog.indexOf('\n## ',start+1)
  if(id.channel==='latest'&&start<0)throw Error('stable release needs a changelog entry')
  const notes=start<0?'Public text-memory preview.':changelog.slice(start,end<0?undefined:end).trim()
  const acceptance=id.channel==='latest'
    ? 'See the attached desktop acceptance and archive receipts for the tested release scope.'
    : 'This is a preview. The attached receipts describe archive integrity and mechanical checks.'
  writeFileSync('release/notes.md',`${notes}\n\nPublished through the repository's npm trusted publisher (OIDC). ${acceptance}\n`)
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
        if(r.ok){
          const bytes=Buffer.from(await r.arrayBuffer())
          checkDigest(bytes,m)
          const tags=await fetchJson(`${registry}/-/package/solopup-memory/dist-tags?verify=${Date.now()}`)
          if(tags?.[m.channel]===m.version)return {version:m.version,tarball:url.href,sha256:m.sha256,integrity:m.integrity,publicDownloadVerified:true,tagVerified:m.channel}
        }
      }
    }catch(e){if(/differs|digest|unexpected/.test(e.message))throw e;console.log(`Registry propagation attempt ${n+1}: ${e.message}`)}
    if(n+1<attempts)await new Promise(r=>setTimeout(r,20000))
  }
  throw Error('public registry propagation did not complete within the bounded wait; do not republish')
}
async function publish(){
  const {m}=loadArtifact()
  checkLongHistory(json('release/long-history.json'),m)
  if(m.channel==='latest')checkDesktopAcceptance(json('release/desktop-acceptance.json'),m)
  if(run('git',['rev-parse','HEAD']).trim()!==m.commit)throw Error('checkout does not match tested source')
  if(!process.env.ACTIONS_ID_TOKEN_REQUEST_URL||!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw Error('GitHub OIDC identity is required; no long-lived-token fallback')
  const existing=await fetchJson(`${registry}/solopup-memory/${m.version}?preflight=${Date.now()}`)
  if(existing){if(existing.dist?.integrity!==m.integrity)throw Error('immutable public version differs from tested archive');console.log('Identical version already public; verifying without republishing')}
  else{
    if(!maySubmit(process.env.GITHUB_EVENT_NAME,process.env.GITHUB_RUN_ATTEMPT,process.env.RELEASE_CONFIRM_UNSUBMITTED==='true'))throw Error('Prior submission outcome must be inspected before another publish; a public 404 does not prove a version was never submitted')
    writeFileSync('release/submission.json',JSON.stringify({version:m.version,sha256:m.sha256,phase:'attempting',at:new Date().toISOString()})+'\n')
    run('npm',['publish','./'+join('release',m.filename),'--tag',m.channel,'--access','public','--ignore-scripts','--registry',registry],{stdio:'inherit',timeout:180000})
    writeFileSync('release/submission.json',JSON.stringify({version:m.version,sha256:m.sha256,phase:'accepted-by-cli',at:new Date().toISOString()})+'\n')
  }
  const verified=await verifyPublic(m),receipt={...m,...verified,publisher:'GitHub Actions OIDC',runUrl:`https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,publishedAt:new Date().toISOString()}
  writeFileSync('release/npm-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(verified))
}
async function finalize(){
  const {m}=loadArtifact(),receipt=json('release/npm-receipt.json')
  if(receipt.sha256!==m.sha256||!receipt.publicDownloadVerified||receipt.tagVerified!==m.channel)throw Error('verified public receipt required')
  const release=spawnSync('gh',['release','view',m.tag,'--json','tagName'],{encoding:'utf8'})
  checkLongHistory(json('release/long-history.json'),m)
  const filenames=[m.filename,'SHA256SUMS','manifest.json','npm-receipt.json','long-history.json']
  if(m.channel==='latest'){
    checkDesktopAcceptance(json('release/desktop-acceptance.json'),m)
    run('git',['fetch','origin',`refs/tags/${m.tag}:refs/tags/${m.tag}`])
    if(run('git',['rev-parse',`refs/tags/${m.tag}^{commit}`]).trim()!==m.commit)throw Error('stable tag moved after publication')
    run('git',['merge','--ff-only',m.commit])
    filenames.push('desktop-acceptance.json')
  }
  const assets=filenames.map(f=>join('release',f))
  const flags=m.channel==='latest'?['--latest']:['--prerelease','--latest=false']
  if(release.status!==0)run('gh',['release','create',m.tag,...assets,'--verify-tag',...flags,'--title',`SoloPup Memory ${m.version}`,'--notes-file','release/notes.md'],{stdio:'inherit'})
  else{
    const root=mkdtempSync(join(tmpdir(),'solopup-existing-release-'))
    try{run('gh',['release','download',m.tag,'--pattern',m.filename,'--dir',root]);checkDigest(readFileSync(join(root,m.filename)),m)}finally{rmSync(root,{recursive:true,force:true})}
  }
  const index=json('market/index.json'),entry=index.plugins.find(p=>p.name==='solopup-memory')
  if(!entry)throw Error('market entry missing')
  if(m.channel==='next'||(m.channel==='beta'&&entry.versions.some(v=>/^\d+\.\d+\.\d+$/.test(v.version))))return
  const version={version:m.version,publishTimestamp:Math.floor(Date.parse(receipt.publishedAt)/1000),engines:m.engines?.dsh?{dsh:m.engines.dsh}:{},source:{type:'npm',registry:registry+'/'}}
  if(!entry.versions.some(v=>v.version===m.version))entry.versions.unshift(version)
  if(m.channel==='latest'){
    index.description={en:'SoloPup Memory for DeepSeek Harness.',zh:'面向 DeepSeek Harness 的 SoloPup Memory。'}
    entry.description={en:'Source-linked project text memory for DeepSeek Harness.',zh:'保留原话来源、项目边界和修改历史的文字记忆。'}
    entry.metadata.labels=entry.metadata.labels.filter(label=>label!=='beta')
  }
  writeFileSync('market/index.json',JSON.stringify(index,null,2)+'\n')
  run('git',['config','user.name','github-actions[bot]']);run('git',['config','user.email','41898282+github-actions[bot]@users.noreply.github.com']);run('git',['add','market/index.json'])
  if(spawnSync('git',['diff','--cached','--quiet']).status!==0)run('git',['commit','-m',`Publish market entry for ${m.version}`])
  if(run('git',['rev-parse','HEAD']).trim()!==run('git',['rev-parse','origin/main']).trim())run('git',['push','origin','HEAD:main'],{stdio:'inherit'})
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const command=process.argv[2];if(!['prepare','publish','finalize'].includes(command))throw Error('expected prepare, publish, or finalize')
  await ({prepare,publish,finalize}[command])()
}
