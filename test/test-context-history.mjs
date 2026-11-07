import {test} from 'node:test'
import assert from 'node:assert/strict'
import {memoryContextProjection,reconcileMemoryContext,assertCurrentMemoryRequest,setupMemoryHistory,HISTORY_PROJECTION_KEY} from '../context-history.mjs'
const header='Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
const context=(id,text,extra=[])=>{const sections=[{name:'memory:index',text},...extra];return{id,role:'user',source:{kind:'runtime-context',form:'snapshot',sections},content:[{type:'text',text:header+'\n\n'+sections.map(s=>s.text).join('\n\n')}]}}
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
function fixture(messages){
 const unit=memoryContextProjection();let state=unit.init();const events=[];const nodes=[]
 const accept=(message,sourceSeq)=>{const event=freeze({type:'user/message',seq:events.length,data:structuredClone(message),...(sourceSeq===undefined?{surfaceOp:'append'}:{surfaceOp:{op:'replace',startSeq:sourceSeq,endSeq:sourceSeq},sourceEventSeqs:[sourceSeq]})});events.push(event);if(sourceSeq===undefined)nodes.push(event.seq);else{const at=nodes.indexOf(sourceSeq);assert.ok(at>=0);nodes.splice(at,1,event.seq)}state=unit.apply(state,event);return event}
 for(const m of messages)accept(m)
 return{events,get state(){return state},deriveMessages(){return nodes.map(seq=>events[seq].data)},surface:{nodes},append(type,message,opts){assert.equal(type,'user/message');assert.equal(message.role,'user');assert.deepEqual(opts.surfaceOp,{op:'replace',startSeq:opts.sourceEventSeqs[0],endSeq:opts.sourceEventSeqs[0]});assert.equal(opts.sourceEventSeqs.length,1);return accept(message,opts.sourceEventSeqs[0])},accept}
}

test('历史投影仅保存身份和序号，恢复校验不接受正文、重复身份或非法序号',()=>{
 const f=fixture([context('ctx-one','private synthetic text')]),schema=memoryContextProjection().stateSchema
 assert.deepEqual(f.state,{nodes:[{id:'ctx-one',seq:0}],overflow:false})
 assert.ok(!JSON.stringify(f.state).includes('private'))
 assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(f.state))),f.state)
 for(const value of [{...f.state,prompt:'secret'},{nodes:[{id:'one',seq:-1}],overflow:false},{nodes:[{id:'one',seq:0},{id:'one',seq:1}],overflow:false},{nodes:[{id:'one',seq:0,body:'secret'}],overflow:false}])assert.throws(()=>schema.parse(value),/invalid-checkpoint/)
})
test('一份未变化的记忆快照不重写历史或制造新事件',()=>{
 const f=fixture([context('ctx-one','current')]);assert.deepEqual(reconcileMemoryContext(f,f.state,'current'),{replaced:0});assert.equal(f.events.length,1)
})
test('变更只移除命名记忆节，保留其他插件来源、用户原话及普通消息',()=>{
 const literal='<memory-store>original owner quotation</memory-store>'
 const owner={id:'owner',source:{kind:'user'},content:[{type:'text',text:literal}]}
 const f=fixture([owner,context('old',literal,[{name:'other-provider',text:'preserve {{literal}} exactly'}])])
 const original=JSON.stringify(f.events)
 assert.equal(reconcileMemoryContext(f,f.state,'new').replaced,1)
 const active=f.deriveMessages();assert.deepEqual(active[0],owner)
 assert.deepEqual(active[1].source.sections,[{name:'other-provider',text:'preserve {{literal}} exactly'}])
 assert.equal(active[1].content[0].text,header+'\n\npreserve {{literal}} exactly')
 assert.equal(JSON.stringify(f.events.slice(0,2)),original)
 assert.equal(f.state.nodes.length,0)
})
test('整个记忆节变空仍从旧活动快照移除，保留审计原事件',()=>{
 const f=fixture([context('old','withdraw me')]);reconcileMemoryContext(f,f.state,'')
 assert.ok(!JSON.stringify(f.deriveMessages()).includes('withdraw me'))
 assert.ok(JSON.stringify(f.events[0]).includes('withdraw me'))
 assert.equal(f.deriveMessages()[0].source.kind,'runtime-context')
})
test('多个旧快照全部处理，不能只清最后一份；普通同文对话不动',()=>{
 const f=fixture([context('a','old'),{id:'assistant-quote',source:{kind:'user'},content:[{type:'text',text:'old'}]},context('b','old',[{name:'second',text:'also keep'}])])
 assert.equal(reconcileMemoryContext(f,f.state,'current').replaced,2)
 const active=f.deriveMessages();assert.equal(active[1].content[0].text,'old')
 assert.ok(active[2].content[0].text.includes('also keep'))
 assert.ok(!active[0].content[0].text.includes('\n\nold'))
})
test('无来源旧框架不猜测删除，明确拒绝；原用户引用框架不冒充可删记忆',()=>{
 const m={id:'legacy',source:{kind:'runtime-context'},content:[{type:'text',text:'<memory-store>legacy</memory-store>'}]}
 const f=fixture([m]);assert.throws(()=>reconcileMemoryContext(f,f.state,''),/unattributed-history/);assert.equal(f.events.length,1)
 assert.doesNotThrow(()=>assertCurrentMemoryRequest([{...m,source:{kind:'user'}}],''))
})
test('来源节与渲染正文不一致时在第一笔改写之前拒绝，防误删其他内容',()=>{
 const a=context('valid','old'),b=context('tampered','old');b.content[0].text+=' unrelated prose'
 const f=fixture([a,b]);assert.throws(()=>reconcileMemoryContext(f,f.state,'new'),/render-mismatch/);assert.equal(f.events.length,2)
})
test('映射缺失、非活动序号或超限状态不能猜位置改写',()=>{
 for(const state of [undefined,{nodes:[],overflow:false},{nodes:[{id:'old',seq:5}],overflow:false},{nodes:[{id:'old',seq:0}],overflow:true}]){
  const f=fixture([context('old','old')]);assert.throws(()=>reconcileMemoryContext(f,state,'new'),/history-unavailable|unmapped-history|history-limit/);assert.equal(f.events.length,1)
 }
})
test('替换失败显式阻断，不吞掉错误继续携带旧快照',()=>{
 const f=fixture([context('old','old')]);f.append=()=>{throw new Error('synthetic failure')}
 assert.throws(()=>reconcileMemoryContext(f,f.state,'new'),/rewrite-failed/)
})
test('已冻结请求只作检查；任一旧正文被拒绝，同文当前快照不因其他来源更新而误阻断',()=>{
 const messages=freeze([context('old','old')]),before=JSON.stringify(messages)
 assert.throws(()=>assertCurrentMemoryRequest(messages,'new'),/stale-request/)
 assert.equal(JSON.stringify(messages),before)
 assert.doesNotThrow(()=>assertCurrentMemoryRequest(messages,'old'))
 assert.doesNotThrow(()=>assertCurrentMemoryRequest([context('a','same'),context('b','same')],'same'))
 assert.throws(()=>assertCurrentMemoryRequest([context('a','old'),context('b','same')],'same'),/stale-request/)
})
test('压缩替换使相关投影身份退场；无关事件复用状态引用',()=>{
 const unit=memoryContextProjection(),f=fixture([context('one','x'),context('two','y')])
 const old=f.state;assert.equal(unit.apply(old,{type:'step/end'}),old)
 const next=unit.apply(old,{type:'user/message',data:{source:{kind:'user'}},surfaceOp:{op:'replace',startSeq:0,endSeq:0},sourceEventSeqs:[0]})
 assert.deepEqual(next.nodes,[{id:'two',seq:1}])
})
test('投影超过4096个仍活跃节点时保留有界状态并明确标超限',()=>{
 const unit=memoryContextProjection();let state=unit.init()
 for(let i=0;i<4097;i++)state=unit.apply(state,{type:'user/message',seq:i,data:context('id-'+i,'old')})
 assert.equal(state.nodes.length,4096);assert.equal(state.overflow,true)
})
test('宿主缺历史服务时不伪造能力；未声明服务的反射错误不会破坏旧六工具',()=>{
 const ctx={reflect:{get(){return undefined}},get sessionProjections(){throw new Error('undeclared service')}}
 const history=setupMemoryHistory(ctx,()=> '');assert.equal(history.available,false);assert.doesNotThrow(()=>history.observe({id:'x'}))
})
test('请求边界改写后继续宿主流程，发送前变更则阻断本地模型调用',()=>{
 const f=fixture([context('old','old')]);f.id='fixture-session'
 const handlers=new Map();let current='current';let calls=0;let unit
 const ctx={sessionProjections:{register(d){unit=d},stateOf(session,key){assert.equal(session,f);assert.equal(key,HISTORY_PROJECTION_KEY);return f.state}},workingDirectory:{get:()=>'/synthetic'},on(name,fn){handlers.set(name,fn)}}
 const history=setupMemoryHistory(ctx,()=>current);assert.equal(history.available,true);assert.equal(unit.wire,undefined)
 history.observe(f,'/synthetic')
 const result=handlers.get('agent/request')({agent:{session:f}},()=> 'continued')
 assert.equal(result,'continued');assert.ok(!JSON.stringify(f.deriveMessages()).includes('"text":"old"'))
 f.accept(context('new','current'))
 assert.equal(handlers.get('llm/stream')({sessionId:f.id,messages:f.deriveMessages()},()=>{calls++;return'local-stream'}),'local-stream')
 current='withdrawn'
 assert.throws(()=>handlers.get('llm/stream')({sessionId:f.id,messages:f.deriveMessages()},()=>{calls++;}),/stale-request/)
 assert.equal(calls,1)
 handlers.get('session/disposed')(f)
 assert.throws(()=>handlers.get('llm/stream')({sessionId:f.id,messages:f.deriveMessages()},()=>{}),/session-unavailable/)
})
