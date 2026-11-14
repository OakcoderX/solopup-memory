import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {repository,registry,validateReceipt} from './release-sync.mjs'

// Public GET only. No cookies, tokens, POSTs, arbitrary callbacks, or page instructions.
const hosts=new Set(['registry.npmjs.org','github.com','api.github.com','raw.githubusercontent.com','release-assets.githubusercontent.com','objects.githubusercontent.com','deepseek1024.com','duink.com'])
function safeUrl(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!hosts.has(u.hostname))throw Error('unapproved public URL');return u}
export async function readPublic(url,{fetcher=fetch,limit=3*1024*1024}={}){
  let controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000)
  try{
    let target=safeUrl(url)
    for(let redirects=0;redirects<=3;redirects++){
      const r=await fetcher(target.href,{method:'GET',redirect:'manual',signal:controller.signal,headers:{'User-Agent':'solopup-memory-version-audit','Accept':'application/json,text/html;q=0.9'}})
      if([301,302,303,307,308].includes(r.status)){
        const location=r.headers.get('location');await r.body?.cancel()
        if(!location||redirects===3)throw Error('redirect limit')
        target=safeUrl(new URL(location,target).href);continue
      }
      if(!r.ok){await r.body?.cancel();return {status:[401,403,429].includes(r.status)?'blocked':'unknown',httpStatus:r.status}}
      const chunks=[];let size=0
      for await(const chunk of r.body){size+=chunk.length;if(size>limit){controller.abort();throw Error('response too large')}chunks.push(chunk)}
      return {status:'read',text:Buffer.concat(chunks).toString('utf8')}
    }
  }catch{return {status:'unknown',reason:'read failed, redirected outside allowlist, timed out, or exceeded size limit'}}
  finally{clearTimeout(timer)}
}
function commands(text){
  const plain=text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|#160);/g,' ').replace(/\s+/g,' ')
  return [...new Set([...plain.matchAll(/dsh plugin --profile [\w-]+ add (solopup-memory(?:@[\w.-]+)?)(?=\s|[<`"']|$)/g)].map(m=>m[1]))]
}
export function inspectChannel(channel,text,version){
  const exact=`solopup-memory@${version}`
  if(channel.kind==='discussion'){
    // Restrict to the original post's rendered body, not metadata or later replies.
    const start=text.search(/class="[^"]*comment-body[^"]*"/)
    const end=text.indexOf('id="discussion-comment-count"',start)
    if(start<0||end<0)return {status:'unknown',reason:'original post boundary not recognized'}
    const targets=commands(text.slice(start,end))
    return {status:targets.length&&targets.every(t=>t===exact||t==='solopup-memory@beta')?'current':'needs_review',installTargets:targets}
  }
  if(channel.kind==='catalog'){
    const entry=JSON.parse(text),expected=`https://github.com/${repository}/releases/download/v${version}/solopup-memory-${version}.tgz`
    if(entry.url!==`https://github.com/${repository}`)throw Error('wrong catalog entry')
    return {status:entry.tarball===expected?'archive_current_npm_route_separate':'needs_update',archive:typeof entry.tarball==='string'?entry.tarball:null,npmDefault:'latest (separate from this archive)'}
  }
  if(channel.kind==='1024'){
    const raw=JSON.parse(text),entry=raw.plugin??raw.data??raw
    if(!entry||typeof entry!=='object'||!Array.isArray(entry.installMethods))throw Error('unknown 1024 schema')
    const methods=entry.installMethods.map(m=>({kind:m.kind??m.type??null,target:m.target??m.spec??null}))
    const npm=methods.filter(m=>m.kind==='npm')
    return {status:npm.some(m=>m.target===exact||m.target==='solopup-memory@beta')?'current':'needs_review',manifestVersion:entry.manifest?.version??null,installMethods:methods}
  }
  if(channel.kind==='issue'){
    const issue=JSON.parse(text)
    if(issue.html_url!==channel.id||!['open','closed'].includes(issue.state)||!Number.isInteger(issue.comments))throw Error('wrong issue')
    return {status:'tracked_request',state:issue.state,comments:issue.comments,updatedAt:issue.updated_at}
  }
  if(channel.kind==='pull-requests'){
    const prs=JSON.parse(text);if(!Array.isArray(prs))throw Error('wrong PR response')
    return {status:prs.length?'tracked_request':'not_submitted_prior_permission_block',requests:prs.map(p=>({url:p.html_url,state:p.state,mergedAt:p.merged_at,draft:p.draft}))}
  }
  if(channel.kind==='directory')return {status:'metadata_only',reason:'No version-pinned installer is asserted by this check'}
  throw Error('unsupported channel')
}
export async function auditChannels(channels,version,reader=readPublic){
  const rows=[]
  for(const c of channels){
    let finding
    try{const read=await reader(c.url);finding=read.status==='read'?inspectChannel(c,read.text,version):read}catch{finding={status:'unknown',reason:'response schema not recognized or source unavailable'}}
    rows.push({id:c.id,url:c.url,...finding,nextAction:c.nextAction})
  }
  return rows
}
export function renderReport(report){
  const lines=['# Public-beta version synchronization audit','',`Checked: ${report.checkedAt}`,`Expected beta: ${report.expectedVersion??'unverified'}`,`Observed npm beta: ${report.beta??'unknown'}; npm latest: ${report.latest??'unknown'}`,'','Read-only observations, not publication, approval, installation tests, or adoption. No automatic third-party updates or retries.','']
  if(report.error)lines.push(`Publication verification: ${report.error}`,'')
  for(const row of report.channels??[])lines.push(`## ${row.id}`,`Status: **${row.status}**`,JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k])=>!['id','url','nextAction','status'].includes(k)))),`Next: ${row.nextAction}`,'')
  return lines.join('\n')+'\n'
}
async function main(){
  const report={checkedAt:new Date().toISOString(),channels:[]}
  const json=async url=>{const r=await readPublic(url);if(r.status!=='read')throw Error(`public endpoint ${r.status}`);return JSON.parse(r.text)}
  try{
    const [b,l]=await Promise.all([json(`${registry}/solopup-memory/beta`),json(`${registry}/solopup-memory/latest`)])
    report.beta=b.version;report.latest=l.version
    if(!/^\d+\.\d+\.\d+-beta\.\d+$/.test(b.version))throw Error('beta tag is not an exact beta version')
    try{
      let m,r
      if(process.argv.length===4&&process.argv[2]==='--receipt-dir'){
        const dir=resolve(process.argv[3]);m=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));r=JSON.parse(readFileSync(join(dir,'npm-receipt.json'),'utf8'))
      }else{
        if(process.argv.length!==2)throw Error('unsupported arguments')
        const base=`https://github.com/${repository}/releases/download/v${b.version}`
        ;[m,r]=await Promise.all([json(`${base}/manifest.json`),json(`${base}/npm-receipt.json`)])
      }
      validateReceipt(m,r)
      if(m.version!==b.version||m.integrity!==b.dist?.integrity||r.tarball!==b.dist?.tarball)throw Error('registry beta differs from release evidence')
      report.expectedVersion=b.version
    }catch{report.error='Current beta receipt unavailable or mismatched. Matching page text below is not verified release synchronization.';process.exitCode=1}
    const config=JSON.parse(readFileSync(new URL('./promotion-channels.json',import.meta.url),'utf8'))
    report.channels=await auditChannels(config.channels,b.version)
    if(!report.expectedVersion)for(const row of report.channels)if(['current','archive_current_npm_route_separate'].includes(row.status))row.status='matches_registry_reference_unverified'
  }catch{report.error='Could not bind the current registry beta to its public release receipt; do not guess or publish again.';process.exitCode=1}
  const dir=resolve('release/version-sync');mkdirSync(dir,{recursive:true})
  writeFileSync(join(dir,'report.json'),JSON.stringify(report,null,2)+'\n')
  const md=renderReport(report);writeFileSync(join(dir,'report.md'),md)
  if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,md)
  console.log(md)
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main()
