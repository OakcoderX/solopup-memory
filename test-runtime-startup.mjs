import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,existsSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {apply,managedMemoryStatus,writeMemory,indexLine,withdrawManagedSource,storeDirFor,searchStore} from './index.mjs'
import {projectIdentity} from './project-stores.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
async function box(run){const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-startup-'))),home=join(root,'home'),cwd=join(root,'work'),data=join(home,'memory'),previous=process.env.DSH_HOME;mkdirSync(home);mkdirSync(cwd);process.env.DSH_HOME=home;const effects=[]
 try{return await run({root,home,cwd,data,effects})}finally{for(const effect of effects.reverse())effect?.();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(root,{recursive:true,force:true})}}
function mount(f,llm,config={autoCapture:{enabled:false}}){const tools=[],handlers=[],captured={},ctx={systemPrompt:{context:entry=>captured.provider=entry},workingDirectory:{get:()=>f.cwd},tools:{register:tool=>tools.push(tool)},llm,on(name,fn){handlers.push([name,fn])},effect(fn){const dispose=fn();if(typeof dispose==='function')f.effects.push(dispose)}};apply(ctx,config);return{tools,handlers,provider:captured.provider,emit(name,...args){for(const [event,fn]of handlers)if(event===name)fn(...args)}}}
function write(dir,scope='global',fresh=false){const summary=fresh?'Independent delivery cobalt7654':'Synthetic private palette jade9876';return writeMemory({dir,scope,type:'user',summary,detail:summary,line:indexLine('user',summary,undefined,true),provenance:{basis:'tool-context',sessionId:fresh?'fresh-owner':'withdrawn-owner',callHash:hash(summary),evidence:[{messageId:'root',hash:hash('synthetic source'),quote:summary}]}})}
const rendered=h=>h.provider.text({agent:{session:{id:'synthetic-agent'}}})
test('fresh default load creates source control and cold reload preserves the same installation',()=>box(async f=>{
 const first=mount(f);assert.equal(managedMemoryStatus(f.data).registered,true);const id=managedMemoryStatus(f.data).installationId
 assert.equal(JSON.parse(readFileSync(join(f.data,'.loaded.json'))).sourceControl.state,'managed');assert.doesNotThrow(()=>rendered(first));assert.equal(managedMemoryStatus(f.data).stores.length,2)
 const second=mount(f);assert.equal(managedMemoryStatus(f.data).installationId,id);const status=await second.tools.find(tool=>tool.name==='memory_status').execute({scope:'global'});assert.equal(status.sourceControl.state,'managed');assert.ok(status.index)
}))
test('old data and queued metadata require upgrade: no body injection, writes or capture calls',()=>box(async f=>{
 mkdirSync(f.data);const old='- [user] Synthetic private old jade9876 — 索引摘要\n',queue='synthetic old queue must remain byte-identical';writeFileSync(join(f.data,'MEMORY.md'),old);writeFileSync(join(f.data,'.capture-inputs.json'),queue);let calls=0
 const host=mount(f,{listProviders:()=>[{provider:'fixture',model:'fixture'}],prepareCall(){calls++;throw Error('must not call')}},{autoCapture:{everyTurns:1}}),text=rendered(host);assert.match(text,/需要升级/);assert.doesNotMatch(text,/jade9876/)
 const status=await host.tools.find(tool=>tool.name==='memory_status').execute({scope:'global'});assert.equal(status.sourceControl.state,'migration-required');assert.equal(status.index,undefined)
 for(const name of ['memory_search','memory_write','memory_prune','memory_forget','memory_links'])await assert.rejects(host.tools.find(tool=>tool.name===name).execute({scope:'global'}),/upgrade-required/)
 const session={id:'old-owner'};host.emit('session/event',session,{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Synthetic fresh long term request'}]}});host.emit('session/event',session,{type:'step/end'});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,0)
 assert.equal(readFileSync(join(f.data,'MEMORY.md'),'utf8'),old);assert.equal(readFileSync(join(f.data,'.capture-inputs.json'),'utf8'),queue);assert.equal(existsSync(f.data+'.control'),false);assert.equal(JSON.parse(readFileSync(join(f.data,'.loaded.json'))).autoCapture.enabled,false)
}))
test('an interrupted old publication is diagnosed before upgrade without rewriting its journal',()=>box(async f=>{
 mkdirSync(f.data);writeFileSync(join(f.data,'.publication.json'),'synthetic interrupted journal');writeFileSync(join(f.data,'MEMORY.md'),'- [user] Synthetic half-published jade9876\n');const host=mount(f),text=rendered(host)
 assert.match(text,/中断发布/);assert.doesNotMatch(text,/jade9876/);assert.equal(readFileSync(join(f.data,'.publication.json'),'utf8'),'synthetic interrupted journal');assert.equal(existsSync(f.data+'.control'),false);assert.equal((await host.tools.find(tool=>tool.name==='memory_status').execute({scope:'global'})).sourceControl.code,'managed-memory-publication-needs-recovery')
}))
test('a missing independent ledger after healthy startup produces unavailable status and is never recreated',()=>box(async f=>{
 const host=mount(f);write(f.data);rmSync(f.data+'.control',{recursive:true});assert.doesNotMatch(rendered(host),/jade9876/);assert.match(rendered(host),/暂不可用/)
 const status=await host.tools.find(tool=>tool.name==='memory_status').execute({scope:'global'});assert.equal(status.sourceControl.state,'unavailable');await assert.rejects(host.tools.find(tool=>tool.name==='memory_search').execute({scope:'global',query:'jade9876'}),/control-missing/);assert.equal(existsSync(f.data+'.control'),false)
 const next=mount(f);assert.equal(JSON.parse(readFileSync(join(f.data,'.loaded.json'))).sourceControl.state,'unavailable');assert.doesNotMatch(rendered(next),/jade9876/);assert.equal(existsSync(f.data+'.control'),false)
}))
test('removing every ownership marker after startup cannot downgrade a context read to raw data',()=>box(async f=>{
 const host=mount(f);write(f.data);
 rmSync(f.data+'.control',{recursive:true});rmSync(f.data+'.control-binding.json');rmSync(join(f.data,'.managed-policy.json'));
 const text=rendered(host);assert.match(text,/暂不可用/);assert.doesNotMatch(text,/jade9876/);assert.equal(existsSync(f.data+'.control'),false);
}))
test('first use of a fresh project inherits every existing source barrier before ordinary access',()=>box(async f=>{
 const host=mount(f);write(f.data);const view=withdrawManagedSource(f.data,'withdrawn-owner','root'),op=withdrawManagedSource(f.data,'withdrawn-owner','root',{apply:true,controlReview:view.controlReview})
 assert.equal(managedMemoryStatus(f.data).stores.length,1);rendered(host);const project=storeDirFor('project',f.cwd),status=managedMemoryStatus(f.data);assert.equal(status.stores.length,2);assert.equal(status.operations[0].pending,1)
 assert.throws(()=>write(project,'project'),/source-revoked/);write(project,'project',true);assert.ok(searchStore(project,'cobalt7654').hits.length>0);assert.equal(withdrawManagedSource(f.data,'withdrawn-owner','root',{operationId:op.id,apply:true}).cleanupComplete,true)
}))
test('an existing nonempty project target requires review without registering or injecting its old contents',()=>box(async f=>{
 const host=mount(f),project=join(f.data,'projects/v2-'+projectIdentity(f.cwd));mkdirSync(project,{recursive:true});const old='- [project] Synthetic unknown old project jade9876 — 索引摘要\n';writeFileSync(join(project,'MEMORY.md'),old)
 assert.match(rendered(host),/需要升级/);assert.doesNotMatch(rendered(host),/jade9876/);assert.equal(managedMemoryStatus(f.data).stores.length,1);assert.equal(readFileSync(join(project,'MEMORY.md'),'utf8'),old);assert.equal(existsSync(join(project,'.managed-policy.json')),false)
 const status=await host.tools.find(tool=>tool.name==='memory_status').execute({}, {agent:{session:{}}});assert.equal(status.sourceControl.state,'unavailable');assert.equal(status.index,undefined)
}))
test('a linked root is unavailable and cannot be turned into a fresh managed installation',()=>box(async f=>{
 const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'sentinel'),'Synthetic unchanged');symlinkSync(outside,f.data);const host=mount(f);assert.match(rendered(host),/暂不可用/);assert.equal(existsSync(join(outside,'.managed-policy.json')),false);assert.equal(readFileSync(join(outside,'sentinel'),'utf8'),'Synthetic unchanged');assert.equal(existsSync(f.data+'.control'),false)
}))
test('capture deduplication input excludes withdrawn index text even while the old projection remains on disk',()=>box(async f=>{
 const fresh=mount(f);write(f.data);const view=withdrawManagedSource(f.data,'withdrawn-owner','root');withdrawManagedSource(f.data,'withdrawn-owner','root',{apply:true,controlReview:view.controlReview,cleanup:false});let requestText,calls=0
 const llm={listProviders:()=>[{provider:'fixture',model:'fixture'}],async prepareCall(){calls++;return{config:{},async *stream(request){requestText=JSON.stringify(request.messages);yield{type:'text-delta',text:'[]'}}}}},host=mount(f,llm,{autoCapture:{everyTurns:1}}),session={id:'independent-capture-session'}
 host.emit('session/event',session,{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Synthetic independent lasting delivery preference cobalt7654'}]}});host.emit('session/event',session,{type:'step/end'})
 const until=Date.now()+4000;while(!requestText&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);assert.equal(typeof requestText,'string');assert.doesNotMatch(requestText,/jade9876/);assert.match(readFileSync(join(f.data,'MEMORY.md'),'utf8'),/jade9876/);assert.equal(searchStore(f.data,'jade9876').hits.length,0)
}))
for(const id of ['synthetic-fallback-owner','synthetic-\u200bfallback-owner'])test('fallback capture checks revoked owner roots before preparation; canonical identity '+JSON.stringify(id),()=>box(async f=>{
 let calls=0,streams=0,body;const llm={listProviders:()=>[{provider:'fixture',model:'fixture'}],async prepareCall(){calls++;return{config:{},async *stream(request){streams++;body=JSON.stringify(request.messages);yield{type:'text-delta',text:'[]'}}}}},host=mount(f,llm,{autoCapture:{everyTurns:1}}),session={id}
 const emit=(who,seq,text)=>host.emit('session/event',who,{type:'user/message',seq,data:{source:{kind:'user'},content:[{type:'text',text}]}})
 emit(session,1,'Synthetic revoked original quotation jade9876');const view=withdrawManagedSource(f.data,id,id+':1');withdrawManagedSource(f.data,id,id+':1',{apply:true,controlReview:view.controlReview,cleanup:false});host.emit('session/event',session,{type:'step/end',seq:2})
 const state=join(f.data,'.capture-state.json'),wait=async who=>{const until=Date.now()+4000;while(Date.now()<until){if(existsSync(state)){const value=JSON.parse(readFileSync(state));if(value.sessionId===who&&!value.running&&value.lastCaptureAt)return value}await new Promise(resolve=>setTimeout(resolve,10))}throw Error('synthetic-capture-deadline')}
 const stopped=await wait(id);assert.equal(stopped.lastError,'capture-input-source-withdrawn');assert.equal(calls,0);assert.equal(streams,0);assert.equal(existsSync(join(f.data,'MEMORY.md')),false)
 const independent={id:'synthetic-independent-'+id};emit(independent,1,'Synthetic valid independent quotation cobalt7654');host.emit('session/event',independent,{type:'step/end',seq:2});await wait(independent.id);assert.equal(calls,1);assert.equal(streams,1);assert.doesNotMatch(body,/jade9876/)
}))
