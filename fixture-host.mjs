/** Test-only native input/call simulation. Product enforcement is never disabled. */
import {randomUUID,createHash} from 'node:crypto'
import {readdirSync,lstatSync,realpathSync} from 'node:fs'
import {join,resolve,relative} from 'node:path'
import {tmpdir} from 'node:os'
import {apply as applyProduct,initializeManagedMemory,managedMemoryStatus,writeMemory,summaryOf,indexLine} from './index.mjs'
import {candidateSnapshot} from './candidates.mjs'
import {VALIDATION_FIELDS} from './capture-validation-contract.mjs'
/** Explicit test setup for integration cases that seed old data before mounting.
 * New default-startup tests use apply directly and do not invoke this helper.
 * This performs real reviewed registration; no product guard is disabled.
 */
export function prepareMountedFixture({empty=false}={}){
 if(!process.env.DSH_HOME)return
 const home=resolve(process.env.DSH_HOME),temp=realpathSync(tmpdir()),part=relative(temp,home)
 if(part==='..'||part.startsWith('../')||part.startsWith('/'))throw Error('fixture-home-must-be-temporary')
 const root=join(home,'memory');let entries
 try{entries=readdirSync(root)}catch(error){if(error.code==='ENOENT')return;throw error}
 if(!entries.length&&!empty)return
 const status=managedMemoryStatus(root),rows=status.registered?status.stores.map(({name,role,scope})=>({name,role,scope})):[{name:'.',role:'global'}]
 try{for(const name of readdirSync(join(root,'projects'))){if(name.startsWith('.'))continue;const relativeName='projects/'+name;if(rows.some(row=>row.name===relativeName))continue;const path=join(root,relativeName),stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('fixture-unsafe-project');let scope='project';try{candidateSnapshot(path,scope)}catch(error){if(error.message!=='candidate-review-scope-mismatch')throw error;candidateSnapshot(path,'global');scope='global'};rows.push({name:relativeName,role:scope==='project'&&/^v2-[a-f0-9]{64}$/.test(name)?'project':'legacy-copy',scope})}}catch(error){if(error.code!=='ENOENT')throw error}
 if(status.registered&&rows.length===status.stores.length)return
 const plan=initializeManagedMemory(root,rows,{importLegacy:true});initializeManagedMemory(root,rows,{importLegacy:true,apply:true,reviewed:plan.review})
}
/** A synthetic source-aware seed, not native execution or human confirmation. */
export function writeFixtureMemory(input){
 const source=randomUUID(),summary=input.summary??summaryOf(input.line),scope=input.scope??(/[/\\]projects[/\\]/.test(input.dir)?'project':'global')
 const expires=input.expires??/ \(exp:(\d{4}-\d\d-\d\d)\)$/.exec(input.line??'')?.[1],line=indexLine(input.type,summary,expires,typeof input.detail==='string'&&input.detail.trim().length>0)
 return writeMemory({...input,line,expires,summary,scope,provenance:input.provenance??{basis:'tool-context',sessionId:'synthetic-seed-'+source,callHash:createHash('sha256').update(source).digest('hex'),evidence:[{messageId:'seed-root',hash:createHash('sha256').update(summary).digest('hex'),quote:'Synthetic explicit fixture seed '+summary}]}})
}
export function applyWithOwnerFixture(ctx,config){
 if(typeof ctx?.systemPrompt?.context!=='function')return applyProduct(ctx,config)
 prepareMountedFixture()
 const handlers=[],register=ctx.tools?.register;let sequence=0,turn=0
 const injected=typeof ctx.llm?.prepareCall!=='function'
 const host={...ctx,llm:injected?scriptedNativeValidationLlm():withValidationFixture(ctx.llm),on(name,handler){handlers.push([name,handler]);return ctx.on?.(name,handler)}}
 if(injected)config={...config,autoCapture:{enabled:false,provider:'fixture',model:'fixture',...config?.autoCapture}}
 if(ctx.tools)host.tools={...ctx.tools,register(definition){
  if(definition.name!=='memory_write')return register.call(ctx.tools,definition)
  const execute=definition.execute
  register.call(ctx.tools,{...definition,async execute(args,exec={}){
   // Legacy mechanics fixtures explicitly describe their synthetic source as an unverified claim. Product code never supplies a default.
   args={meaning:{kind:'claim'},...args}
   const session=exec.agent?.session??{},agent=exec.agent??{session}
   if(!session.id)session.id='synthetic-fixture-session-'+randomUUID()
   const callId=exec.callId??randomUUID(),rootCallId=exec.rootCallId??callId,position=++turn,message={id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Synthetic owner fixture request: '+String(args.summary??'validate this tool call')} ]}
   for(const [name,handler] of handlers)if(name==='agent/pre-step')await handler({agent,turn:position,step:1,messages:[message]},()=>Promise.resolve({kind:'enter',messages:[message]}))
   const admitted={type:'user/message',seq:++sequence,data:message};for(const [name,handler] of handlers)if(name==='session/event')handler(session,admitted)
   const call={type:'tool/call',seq:++sequence,data:{callId:rootCallId,name:'memory_write',turn:position,step:1}};for(const [name,handler] of handlers)if(name==='session/event')handler(session,call)
   return execute.call(definition,args,{...exec,agent,callId,rootCallId})
  }})
 }}
 return applyProduct(host,config)
}

/** Scripted transport for native mechanics only; it does not judge semantic quality. */
export function scriptedNativeValidationLlm(state='supported'){
 return {async prepareCall(config){return{config,async*stream(request){
  if(request.purpose!=='memory-validation')throw Error('fixture-only-supports-validation')
  const input=JSON.parse(request.messages[0].content[0].text)
  const checks=input.candidates.map(r=>({candidateId:r.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(k=>[k,state])),evidence:state==='uncertain'?[]:r.value.evidence.map(({messageId,quote})=>({messageId,quote}))}))
  yield{type:'text-delta',text:JSON.stringify({checks})};yield{type:'finish',reason:{kind:'stop'}}
 }}}}
}

/** Mechanics fixtures explicitly script the new validation phase. This is not semantic-quality evidence. */
const validationFixtureServices=new WeakMap()
function withValidationFixture(llm){
 if(!llm||typeof llm!=='object'||typeof llm.prepareCall!=='function')return llm
 if(validationFixtureServices.has(llm))return validationFixtureServices.get(llm)
 const proxy=new Proxy(llm,{get(target,key){
  if(key!=='prepareCall')return Reflect.get(target,key,target)
  return async(...args)=>{
   const call=await target.prepareCall(...args)
   return{...call,async*stream(request){
    if(request.purpose!=='memory-validation'){yield*call.stream.call(call,request);return}
    const input=JSON.parse(request.messages[0].content[0].text)
    const checks=input.candidates.map(r=>{
     const evidence=r.value.evidence.map(({messageId,quote})=>({messageId,quote})),available=evidence.every(e=>input.ownerMessages.some(m=>m.id===e.messageId&&m.text.includes(e.quote)))
     return{candidateId:r.candidateId,fields:Object.fromEntries(VALIDATION_FIELDS.map(k=>[k,available?'supported':'uncertain'])),evidence:available?evidence:[]}
    })
    yield{type:'text-delta',text:JSON.stringify({checks})};yield{type:'finish',reason:{kind:'stop'}}
   }}
  }
 }})
 validationFixtureServices.set(llm,proxy);return proxy
}
export function applyWithValidationFixture(ctx,config){
 const proxy=new Proxy(ctx,{get(target,key){
  if(key==='llm')return withValidationFixture(target.llm)
  if(key==='get'&&typeof target.get==='function')return name=>{const value=target.get(name);return name==='llm'?withValidationFixture(value):value}
  if(key==='reflect'&&typeof target.reflect?.get==='function')return{...target.reflect,get(name){const value=target.reflect.get(name);return name==='llm'?withValidationFixture(value):value}}
  return Reflect.get(target,key,target)
 }})
 return applyProduct(proxy,config)
}
