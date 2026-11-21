/** Empty-home native write -> native source validation -> fresh-session search and delivery check. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname,join,resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [archiveArg,version,expectedSha,helperArg,reportArg]=process.argv.slice(2)
assert.ok(archiveArg&&version&&expectedSha&&helperArg&&reportArg,'Usage: node native-author-write.mjs ARCHIVE VERSION SHA256 PREPARE_ARM_JS REPORT_JSON')
const hash=value=>createHash('sha256').update(value).digest('hex')
const fixture=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'固定输入.json')))
const rule=fixture.deliveryRule,archive=resolve(archiveArg),reportFile=resolve(reportArg)
assert.equal(hash(readFileSync(archive)),expectedSha)
const arm=realpathSync(mkdtempSync(join(tmpdir(),'solopup-empty-author-')))
const cwd=join(arm,'checkout'),dshHome=join(arm,'home'),temp=join(arm,'tmp')
mkdirSync(cwd,{mode:0o700});execFileSync('git',['init','-q','-b','main',cwd])
execFileSync(process.execPath,[resolve(helperArg),arm,archive,expectedSha,version],{timeout:120000})
assert.equal(existsSync(join(dshHome,'memory')),false,'A project must start without memory')
const cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const provider='local-author',model='local-author',profile=join(dshHome,'profiles','coding')
const environment={HOME:dshHome,DSH_HOME:dshHome,USERPROFILE:dshHome,CFFIXED_USER_HOME:dshHome,TMPDIR:temp,TMP:temp,TEMP:temp,
  PATH:process.env.PATH,ELECTRON_RUN_AS_NODE:'1',NO_COLOR:'1',SOLOPUP_LOCAL_PAIR_TOKEN:'local-only'}
const report={archiveSha:expectedSha,version,dsh:JSON.parse(readFileSync(join(arm,'prepared.json'))).version,
  model:'localhost scripted ordinary and native validation responses',preloadedRecords:0,requests:[],observations:[],passed:false}
let stage='write',foundId,firstPid,receivedWrite=false,validations=0,errorDetail
const text=content=>typeof content==='string'?content:content.map(p=>p.text??'').join('\n')
const call=(id,name,args)=>({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
const fields=['durability','scope','wording','meaning','applicability','attribution','transition']
const server=createServer(async(req,res)=>{
  try {
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer local-only')
    const chunks=[];for await(const c of req)chunks.push(c)
    const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.model,model)
    const names=body.tools?.map(t=>t.function.name)??[]
    const userTexts=body.messages.filter(m=>m.role==='user').flatMap(m=>
      typeof m.content==='string'?[m.content]:m.content.flatMap(block=>typeof block.text==='string'?[block.text]:[]))
    const tools=body.messages.filter(m=>m.role==='tool');let delta={role:'assistant',content:'检查结束。'}
    if(names.includes('submit_memory_validation')) {
      const input=userTexts.flatMap(value=>{try{return [JSON.parse(value)]}catch{return []}}).find(value=>Array.isArray(value.candidates))
      assert.ok(input,'Validation payload not present')
      assert.equal(input.candidates.length,1);let candidate=input.candidates[0]
      assert.ok(input.ownerMessages.some(m=>m.role==='user'&&m.text===rule))
      assert.equal(candidate.value.summary,rule)
      const refs=Object.keys(candidate.requiredSourceRefs);assert.ok(refs.length)
      const checks=[{candidateId:candidate.candidateId,fields:Object.fromEntries(fields.map(key=>[key,'supported'])),taskRestriction:'none',sourceRefs:refs,evidence:[]}]
      delta=call('explicit-validation','submit_memory_validation',{checks});validations++
      report.requests.push({stage,purpose:'native-source-validation',ownerFullTextMatched:true})
    } else {
      assert.ok(names.includes('memory_write')&&names.includes('memory_check_delivery'))
      if(stage==='write' && !tools.length){
        assert.ok(userTexts.some(value=>value.trim()===rule),'Owner prompt absent from actual model request')
        delta=call('explicit-write','memory_write',{type:'project',scope:'project',summary:rule,meaning:{kind:'decision'}})
      } else if(stage==='write') {
        const output=text(tools.at(-1).content);report.writeOutcome=output.includes('已写入')?'recorded':output.slice(0,320)
        receivedWrite=report.writeOutcome==='recorded'
      } else if(!tools.length) {
        delta=call('search-current','memory_search',{query:'终稿.md',scope:'project',mode:'exact'})
      } else if(tools.length===1) {
        const result=text(tools[0].content)
        assert.ok(result.includes(rule),'The new conversation did not find the original rule')
        const id=result.match(/记录身份：([a-f0-9]{64})/)?.[1];assert.ok(id,'Search result missing record ID')
        if(foundId)assert.equal(id,foundId);foundId=id
        delta=call('check-current','memory_check_delivery',{recordId:id})
      } else {
        const result=JSON.parse(text(tools.at(-1).content));assert.equal(result.recordId,foundId)
        const expect=stage==='wrong'?'mismatch':'matched'
        assert.equal(result.status,expect);assert.equal(result.path,fixture.target)
        assert.equal(result.sha256,hash(readFileSync(join(cwd,fixture.target))))
        report.observations.push({stage,status:result.status,path:result.path,fileSha:result.sha256,searchReturnedSavedId:true})
      }
      report.requests.push({stage,purpose:delta.tool_calls?.[0].function.name??'final'})
    }
    const event=(d,finish_reason)=>'data: '+JSON.stringify({id:'author-fixture',created:1,object:'chat.completion.chunk',model,choices:[{index:0,delta:d,finish_reason}]})+'\n\n'
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(event(delta,null)+event({},delta.tool_calls?'tool_calls':'stop')+'data: [DONE]\n\n')
  }catch(error){errorDetail=error.message;res.writeHead(400);res.end('Local fixture error')}
})
server.listen(0,'127.0.0.1');await once(server,'listening')
const configs=['session-title-llm','telemetry','tool-web','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-plugin-manager','tool-skill','tool-subagent','tool-subagent-fork','tool-subagent-control','tool-agent-team','tool-workflow','tool-goal'].map(id=>({id,disabled:true}))
configs.push({id:'agent-default-model',config:{provider,model}},{id:'llm-pi-ai',config:{providers:{[provider]:{api:'openai-completions',baseURL:'http://127.0.0.1:'+server.address().port+'/v1',apiKeyEnv:'SOLOPUP_LOCAL_PAIR_TOKEN',models:[{id:model,contextWindow:128000,maxTokens:2048}]}}}},
 {id:'memory',config:{autoCapture:{enabled:false},dream:{enabled:false}}})
writeFileSync(join(profile,'cordis.patch.yml'),JSON.stringify(configs))
async function run(text){
  return new Promise((done,reject)=>{
    const child=execFile(cli,['--profile','coding','--json','--approval-policy','never','-'],{cwd,env:environment,timeout:45000,maxBuffer:2**20},(err,stdout,stderr)=>{
      if(err)return reject(Error(errorDetail??stderr.slice(-350)))
      const rows=stdout.trim().split('\n').flatMap(l=>{try{return[JSON.parse(l)]}catch{return[]}})
      const end=rows.find(r=>r.type==='final');if(end?.reason?.kind!=='completed')return reject(Error('DSH did not complete'))
      const session=rows.find(r=>r.type==='session')?.sessionId
      if(!session)return reject(Error('No native session ID'))
      if(firstPid)assert.notEqual(firstPid,session);else firstPid=session
      done()
    });child.stdin.end(text+'\n')
  })
}
try {
  await run(rule);assert.ok(receivedWrite,'User-facing memory write was not committed: '+report.writeOutcome);assert.ok(validations===1,'Native validation missing')
  for(const [phase,bytes] of [['wrong',fixture.incorrect],['right',fixture.correct]]){
    stage=phase;writeFileSync(join(cwd,fixture.target),bytes);await run('核对这份终稿里保存的末行约定。')
  }
  assert.equal(report.observations.length,2);report.passed=true
}catch(error){report.error=error.message;process.exitCode=1}
finally{server.closeAllConnections();await new Promise(r=>server.close(r));writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))}
