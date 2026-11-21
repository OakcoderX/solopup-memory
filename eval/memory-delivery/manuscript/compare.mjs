/** Compare one installed release per invocation. Only a loopback deterministic provider is used. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [packageFile, version, expectedHash, reportFile, helperPath] = process.argv.slice(2)
assert.ok(packageFile && version && expectedHash && reportFile && helperPath, 'Usage: node compare.mjs ARCHIVE VERSION SHA256 REPORT_JSON CHECKOUT/eval/memory-delivery/prepare-arm.mjs')
const sum = value => createHash('sha256').update(value).digest('hex')
const fixtureFile = join(dirname(fileURLToPath(import.meta.url)), '固定输入.json')
const inputSha = sum(readFileSync(fixtureFile))
assert.equal(inputSha, '8583470725ef4250fb3dc867fb7f66e0b47b652d2f45f4769470e053a7b9055d')
const data = JSON.parse(readFileSync(fixtureFile))
const archive = resolve(packageFile)
assert.equal(sum(readFileSync(archive)), expectedHash)
if (version === data.baseline.version) assert.equal(expectedHash, data.baseline.sha256)
const arm = realpathSync(mkdtempSync(join(tmpdir(), 'solopup-author-pair-')))
const workspace = join(arm, 'checkout')
mkdirSync(workspace, {mode: 0o700})
execFileSync('git', ['init', '-q', '-b', 'main', workspace])
execFileSync(process.execPath, [resolve(helperPath), arm, archive, expectedHash, version], {encoding:'utf8',timeout:150000})
const home = join(arm, 'home'), tmp = join(arm, 'tmp')
const profile = join(home, 'profiles', 'coding')
const installed = join(profile, 'node_modules', 'solopup-memory')
const moduleFromPackage = name => import(pathToFileURL(join(installed, name)))
const { indexLine, initializeManagedMemory, writeMemory } = await moduleFromPackage('index.mjs')
const { projectStoreDir } = await moduleFromPackage('project-stores.mjs')
const { candidateSnapshot } = await moduleFromPackage('candidates.mjs')
const root = join(home, 'memory'), store = projectStoreDir(root, workspace)
mkdirSync(store, { recursive:true,mode:0o700 })
const edition = data.editionRule
const rows = [[edition.summary, {kind:'decision', conditions:[edition.condition]}],[data.deliveryRule,{kind:'decision'}]]
for (const [i,[quote,meaning]] of rows.entries()) {
  writeMemory({type:'project',scope:'project',dir:store, line:indexLine('project',quote,undefined,false), summary:quote, meaning,
    provenance:{basis:'tool-context',via:'memory_write',sessionId:'paired-author-decisions',callHash:sum('source-'+i),
      evidence:[{messageId:'owner-'+i,hash:sum(quote),quote}]}})
}
const stores = [{name:'.',role:'global'},{name:store.slice(root.length+1),role:'project',scope:'project'}]
const plan = initializeManagedMemory(root,stores,{importLegacy:true})
initializeManagedMemory(root,stores,{importLegacy:true,apply:true,reviewed:plan.review})
const active = candidateSnapshot(store,'project').records.filter(row=>row.status==='recorded')
assert.equal(active.length,2)
const editionId=active.find(row=>row.summary===edition.summary).id
const deliveryId=active.find(row=>row.summary===data.deliveryRule).id
const prepared=JSON.parse(readFileSync(join(arm,'prepared.json')))
const report={inputSha,version,archiveSha:expectedHash,dsh:prepared.version,model:'local deterministic provider',billing:false,
  scope:'Native CLI sends ordinary user turns; project decisions preloaded equally. State inspection and file reads only.',cases:[]}
const cli='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const env={PATH:process.env.PATH, HOME:home, DSH_HOME:home, USERPROFILE:home,CFFIXED_USER_HOME:home,
  TMPDIR:tmp,TMP:tmp,TEMP:tmp,ELECTRON_RUN_AS_NODE:'1',NO_COLOR:'1', SOLOPUP_PAIR_KEY:'local-fixture-only'}
const provider='author-pair',model='author-pair'
const toolName='memory_check_delivery'
let turn
const server=createServer(async(req,res)=>{
  try {
    assert.equal(req.url,'/v1/chat/completions')
    assert.equal(req.headers.authorization,'Bearer local-fixture-only')
    const chunks=[]
    for await(const c of req)chunks.push(c)
    const body=JSON.parse(Buffer.concat(chunks)), messages=body.messages
    assert.equal(body.model,model)
    assert.ok(messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes(turn.prompt)), 'Owner prompt absent')
    const toolMessages=messages.filter(m=>m.role==='tool')
    const tools=(body.tools??[]).map(t=>t.function?.name)
    const memoryRegistered=tools.includes('memory_status')
    assert.ok(memoryRegistered,'SoloPup normal memory tool missing from native request')
    let answer={role:'assistant',content:'已记录本轮观察。'}
    if(turn.requests===0) {
      turn.toolOffered=tools.includes(toolName)
      const all=JSON.stringify(messages)
      const projected=new RegExp('\\[(适用|条件待核对)，本项目，'+editionId.slice(0,12)+'\\]').exec(all)
      turn.observedEdition=projected?.[1]==='适用'?'applicable':projected?'pending':'omitted'
    }
    turn.requests++
    assert.ok(turn.requests<=4,'Missing native tool result')
    const call=(id,name,args)=>({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]})
    if (turn.file && !toolMessages.length) {
      answer=call('paired-rule-search','memory_search',{query:'终稿.md',scope:'project',mode:'exact'})
    } else if (turn.file && toolMessages.length===1) {
      const found=JSON.stringify(toolMessages[0].content).match(/记录身份：([a-f0-9]{64})/)
      assert.equal(found?.[1],deliveryId,'Search must return the current project rule ID to the deterministic provider')
      turn.searchReturnedId=true
      if(turn.toolOffered)answer=call('paired-delivery-check',toolName,{recordId:found[1]})
    } else if (toolMessages.length>1) {
      turn.toolResult=toolMessages.at(-1).content
    }
    const frame = (delta,finish_reason) => 'data: '+JSON.stringify({id:'local-pair',object:'chat.completion.chunk',created:1,model,
      choices:[{index:0,delta,finish_reason}]})+'\n\n'
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.end(frame(answer,null)+frame({},answer.tool_calls?'tool_calls':'stop')+'data: [DONE]\n\n')
  } catch(error) { if(turn)turn.error=error.message;res.writeHead(500);res.end('Local protocol check failed') }
})
server.listen(0,'127.0.0.1'); await once(server,'listening')
const port=server.address().port
const disabled=['session-title-llm','telemetry','tool-web','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-plugin-manager','tool-skill','tool-subagent','tool-subagent-fork','tool-subagent-control','tool-agent-team','tool-workflow','tool-goal']
writeFileSync(join(profile,'cordis.patch.yml'),JSON.stringify([
  ...disabled.map(id=>({id,disabled:true})),{id:'agent-default-model',config:{provider,model}},
  {id:'llm-pi-ai',config:{providers:{[provider]:{api:'openai-completions',baseURL:'http://127.0.0.1:'+port+'/v1',apiKeyEnv:'SOLOPUP_PAIR_KEY',models:[{id:model,contextWindow:128000,maxTokens:1024}]}}}},
  {id:'memory',config:{autoCapture:{enabled:false},dream:{enabled:false}}}
]))
const runDsh=prompt=>new Promise((done,reject)=>{
  const cp=execFile(cli,['--profile','coding','--json','--approval-policy','never','-'],{cwd:workspace,env,timeout:35000,maxBuffer:2**20},(err,out,stderr)=>{
    if(err)return reject(Error('DSH failed: '+err.code+' '+stderr.slice(-600)))
    const events=out.trim().split('\n').flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
    const final=events.find(e=>e.type==='final')
    if(final?.reason?.kind!=='completed')return reject(Error('incomplete native turn: '+JSON.stringify(final??{}).slice(-400)))
    done()
  });cp.stdin.end(prompt+'\n')
})
function parseOutcome(content) {
  if(!content)return undefined
  if(Array.isArray(content))return parseOutcome(content.find(b=>b.type==='text')?.text)
  if(typeof content==='string') {try{return parseOutcome(JSON.parse(content))}catch{return undefined}}
  if(content.status)return content
  return parseOutcome(content.content)
}
async function observe(entry, state) {
  const prompt=entry.query??'请核对本项目已确认的终稿末行约定。'
  turn={file:!entry.query,prompt,requests:0}
  if(state)writeFileSync(join(workspace,data.target),data[state])
  if(entry.distractorState){const d=join(workspace,data.distractor);mkdirSync(dirname(d),{recursive:true});writeFileSync(d,data[entry.distractorState])}
  await runDsh(prompt)
  assert.ok(!turn.error,turn.error);assert.ok(turn.requests>0)
  const outcome=parseOutcome(turn.toolResult)
  const receipt={requests:turn.requests,toolOffered:turn.toolOffered,observedEdition:turn.observedEdition,
    ...(turn.file&&{searchReturnedId:turn.searchReturnedId===true})}
  if(turn.file && turn.toolOffered){
    receipt.toolResult=outcome??turn.toolResult??null
    receipt.expectedFileSha=sum(data[state])
  }
  return receipt
}
try {
  for(const entry of data.cases){
    const prior=entry.prior?await observe(entry,entry.prior):null
    const observation=await observe(entry,entry.state)
    let outcome
    if(entry.query){
      const expected=entry.expect==='inapplicable'?'omitted':entry.expect
      outcome=observation.observedEdition===expected?'correct':'wrong'
    }else if(!observation.toolOffered){outcome='unavailable'}else{
      const ok=(o,status)=>o.toolResult?.status===status && o.toolResult.sha256===o.expectedFileSha &&
        o.toolResult.path===data.target && o.toolResult.recordId===deliveryId && o.searchReturnedId
      outcome=ok(observation,entry.expect==='match'?'matched':'mismatch') && (!prior||ok(prior,'mismatch'))?'correct':'wrong'
    }
    report.cases.push({id:entry.id,outcome,...observation,...(prior?{prior}:{})})
    console.log(version,entry.id,outcome)
  }
} finally {
  server.closeAllConnections();await new Promise(r=>server.close(r))
  report.environment=arm
  writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
}
