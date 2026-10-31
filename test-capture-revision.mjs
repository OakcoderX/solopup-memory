import {applyWithValidationFixture as apply} from './fixture-host.mjs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,existsSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {captureRevision} from './capture-revision.mjs'
import {parseCandidates} from './capture-llm.mjs'
import {indexLine, lookupLinks, storeDirFor} from './index.mjs'
import {prepareMountedFixture,writeFixtureMemory} from './fixture-host.mjs'
import {listCandidates} from './candidates.mjs'

const oldSummary='个人长期默认配色使用 violet-4826',newSummary='个人长期默认配色使用 silver-5937',otherSummary='日常答复保持简洁且先给结论'
const oldLine=indexLine('user',oldSummary),target='[global] '+oldLine
test('replacement binds one exact same-scope row; an absent request is append-compatible',()=>{
 assert.equal(captureRevision({},[]),undefined)
 assert.equal(captureRevision({scope:'global',meaning:{kind:'claim'},basis:'explicit',supersedes:target},[target]),oldLine)
})
test('replacement refuses substrings, other scopes, missing or ambiguous targets and malformed metadata',()=>{
 for(const [patch,lines]of [
  [{supersedes:oldSummary},[target]], [{scope:'project'},[target]], [{meaning:{kind:'claim'},basis:'inferred'},[target]],
  [{},[]], [{},[target,target]], [{supersedes:null},[target]], [{supersedes:{}},[target]],
  [{supersedes:'[global] '+'x'.repeat(4097)},[target]],
 ])assert.throws(()=>captureRevision({scope:'global',meaning:{kind:'claim'},basis:'explicit',supersedes:target,...patch},lines),/capture-invalid-replacement/)
})
test('candidate parsing preserves replacement metadata for explicit identity validation instead of dropping it',()=>{
 const candidate={type:'user',summary:newSummary,scope:'global',meaning:{kind:'claim'},basis:'explicit',supersedes:target}
 assert.equal(parseCandidates(JSON.stringify([candidate]))[0].supersedes,target)
 assert.equal(parseCandidates(JSON.stringify([{...candidate,supersedes:42}]))[0].supersedes,42)
})
async function scenario(mode){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'dsh-capture-revision-'))),home=join(base,'home'),cwd=join(base,'project'),previous=process.env.DSH_HOME
 mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home
 try{
  const root=join(home,'memory')
  writeFixtureMemory({type:'user',scope:'global',dir:root,line:oldLine,meaning:{kind:'claim'}})
  writeFixtureMemory({type:'user',scope:'global',dir:root,line:indexLine('user',otherSummary)})
  const observedOldLine=readFileSync(join(root,'MEMORY.md'),'utf8').split('\n').find(line=>line.includes(oldSummary)).trim(),observedTarget='[global] '+observedOldLine
  prepareMountedFixture()
  const handlers=[],tools=[],session={id:'replacement-'+mode}
  let calls=0
  const llm={async listProviders(){return[{provider:'fixture',model:'fixture'}]},async prepareCall(){return{config:{},async *stream(request){
   calls++
   const prompt=request.messages[0].content[0].text
   assert.ok(prompt.includes(observedTarget),'The replacement target must actually be in this extraction input')
   const message=prompt.split('\n').flatMap(line=>{try{const item=JSON.parse(line);return item.role==='user'?[item]:[]}catch{return[]}}).at(-1)
   if(mode==='stale')writeFixtureMemory({type:'user',scope:'global',dir:root,line:indexLine('user','独立新来源喜欢可读的步骤说明')})
   const candidate={type:'user',meaning:{kind:'claim'},summary:newSummary,scope:mode==='wrong-scope'?'project':'global',basis:mode==='inferred'?'inferred':'explicit',supersedes:mode==='substring'?oldSummary:observedTarget,evidence:[{messageId:message.id,quote:message.text}]}
   yield{type:'text-delta',text:JSON.stringify([candidate])};yield{type:'finish',reason:{kind:'stop'}}
  }}}}
  const ctx={llm,systemPrompt:{context(){}},workingDirectory:{get(){return cwd}},tools:{register(tool){tools.push(tool)}},on(name,handler){handlers.push([name,handler])}}
  apply(ctx,{autoCapture:{everyTurns:1}})
  const emit=(event)=>{for(const [name,handler]of handlers)if(name==='session/event')handler(session,event)}
  emit({type:'user/message',data:{message:{source:{kind:'user'},content:[{type:'text',text:'更正我的长期默认配色，现在改为 silver-5937，取代旧的 violet-4826。'}]}}})
  emit({type:'step/end',data:{}})
  const stateFile=join(root,'.capture-state.json'),until=Date.now()+4000
  let state
  while(Date.now()<until){state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile)):undefined;if(state?.lastCaptureAt&&!state.running)break;await new Promise(resolve=>setTimeout(resolve,20))}
  assert.equal(calls,1);assert.equal(state?.running,false)
  const index=readFileSync(join(root,'MEMORY.md'),'utf8')
  assert.ok(index.includes(otherSummary),'Unrelated accepted memory must survive the replacement')
  if(mode==='valid'){
   assert.equal(state.lastOutcome,'ok');assert.equal(index.includes(oldSummary),false);assert.ok(index.includes(newSummary))
   const result=lookupLinks(root,{match:newSummary});assert.equal(result.supersedesLine,observedOldLine)
   assert.ok(readFileSync(join(root,'.history.jsonl'),'utf8').includes('"op":"supersede"'))
  }else{
   assert.ok(index.includes(oldSummary));assert.equal(index.includes(newSummary),false)
   if(mode==='inferred'){assert.equal(state.lastOutcome,'rejected');assert.equal(listCandidates(root,{scope:'global',status:'pending'}).total,0)}
   else if(mode==='stale'){assert.equal(state.lastOutcome,'error');assert.equal(state.lastError,'capture-input-source-changed')}
   else{assert.equal(state.lastOutcome,'rejected');assert.equal(state.diagnostic.classification,'admission-rejected');assert.equal(state.diagnostic.admissionRejected,1);assert.equal(state.diagnostic.writeFailures,0);assert.equal(state.diagnostic.inserted,0)}
   if(mode==='stale')assert.ok(index.includes('独立新来源喜欢可读的步骤说明'))
   const project=storeDirFor('project',cwd),projectFile=join(project,'MEMORY.md')
   assert.equal(existsSync(projectFile)&&readFileSync(projectFile,'utf8').includes(newSummary),false)
  }
 }finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(base,{recursive:true,force:true})}
}
for(const mode of ['valid','wrong-scope','substring','stale','inferred'])test('auto-capture replacement integration: '+mode,()=>scenario(mode))
