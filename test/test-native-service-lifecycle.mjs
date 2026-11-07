/** Reproduces the real Cordis per-access proxy contract; optional frozen source proves the old failure. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const source=process.env.DSH_NATIVE_SERVICE_SOURCE?pathToFileURL(resolve(process.env.DSH_NATIVE_SERVICE_SOURCE)+'/'):new URL('../',import.meta.url)
const {apply}=await import(new URL('index.mjs',source)),{candidateSnapshot}=await import(new URL('candidates.mjs',source)),{scriptedNativeValidationLlm}=await import(new URL('fixture-host.mjs',source))
for(const mode of ['stable-owner-fresh-proxies','owner-disappears','owner-replaced'])test('native service lifecycle: '+mode,async()=>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'native-service-generation-'))),home=join(base,'home'),old=process.env.DSH_HOME;mkdirSync(home);process.env.DSH_HOME=home
 const handlers=[],tools=[],cleanups=[];let activate,drop,streams=0
 const baseLlm=scriptedNativeValidationLlm(),llm={async prepareCall(...args){const call=await baseLlm.prepareCall(...args);return{...call,async*stream(req){streams++;if(mode!=='stable-owner-fresh-proxies'){drop();if(mode==='owner-replaced')activate()}yield*call.stream(req)}}}}
 const view=()=>new Proxy(llm,{get:(target,key)=>typeof target[key]==='function'?target[key].bind(target):target[key]})
 const ctx={get:name=>name==='llm'?view():ctx[name],systemPrompt:{context(){}},workingDirectory:{get:()=>base},tools:{register:t=>tools.push(t)},on:(name,fn)=>handlers.push([name,fn]),effect:fn=>{const d=fn();if(typeof d==='function')cleanups.push(d)},inject(names,fn){assert.deepEqual(names,['llm']);activate=()=>{const disposals=[];fn({get:()=>view(),effect:effect=>disposals.push(effect())});drop=()=>disposals.forEach(d=>d?.())};activate()}}
 try{
  assert.notEqual(ctx.get('llm'),ctx.get('llm'));apply(ctx,{autoCapture:{enabled:false}})
  const session={id:'synthetic-service-proxy-'+mode},agent={session,options:{provider:'fixture',model:'fixture'}},message={id:'owner',role:'user',source:{kind:'user'},content:[{type:'text',text:'Across all projects, future feedback lists two issues then fixes.'}]}
  for(const[name,fn]of handlers)if(name==='agent/pre-step')fn({agent,turn:1,step:1,messages:[message]},()=>{})
  for(const event of [{type:'user/message',seq:10,data:message},{type:'tool/call',seq:11,data:{callId:'save',name:'memory_write',turn:1,step:1}}])for(const[name,fn]of handlers)if(name==='session/event')fn(session,event)
  const operation=()=>tools.find(t=>t.name==='memory_write').execute({type:'user',scope:'global',summary:'Long-term feedback: two issues then fixes',meaning:{kind:'preference'}},{agent,callId:'save'})
  if(mode==='stable-owner-fresh-proxies'){assert.equal((await operation()).status,'recorded');assert.equal(streams,1)}
  else{await assert.rejects(operation,/source-unavailable|cancelled/);assert.equal(streams,1);assert.equal(candidateSnapshot(join(home,'memory'),'global').records.length,0)}
 }finally{for(const dispose of cleanups.reverse())dispose();if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;rmSync(base,{recursive:true,force:true})}
})
