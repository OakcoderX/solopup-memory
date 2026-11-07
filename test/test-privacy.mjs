import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {apply,searchStore,lookupLinks} from '../index.mjs'
import {writeFixtureMemory} from '../fixture-host.mjs'
import {memoryPrivacy,privateMemory,publicMemoryRecords,publicMemoryIndex} from '../privacy.mjs'

test('actual background extractor receives no unrelated saved private source or summary',async()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'memory-private-background-'))),old=process.env.DSH_HOME;process.env.DSH_HOME=home
  const cwd=join(home,'project'),handlers=[],effects=[];mkdirSync(cwd);let requestText,finished=false
  const llm={async prepareCall(config){return{config,async*stream(request){requestText=JSON.stringify(request);yield{type:'text-delta',text:'[]'};yield{type:'finish',reason:{kind:'stop'}};finished=true}}}}
  try{
    apply({llm,systemPrompt:{context(){}},workingDirectory:{get:()=>cwd},tools:{register(){}},on:(name,fn)=>handlers.push([name,fn]),effect:fn=>effects.push(fn())},
      {autoCapture:{everyTurns:1,provider:'fixture',model:'fixture'}})
    writeFixtureMemory({dir:join(home,'memory'),type:'user',scope:'global',summary:'个人档案：出生于1993年4月16日，女性',meaning:{kind:'claim'}})
    const session={id:'synthetic-unrelated-work'},emit=e=>{for(const [n,f]of handlers)if(n==='session/event')f(session,e)}
    emit({type:'user/message',seq:1,data:{source:{kind:'user'},content:[{type:'text',text:'本项目以后交付字幕时固定先检查断句。'}]}})
    emit({type:'step/end',seq:2})
    for(let i=0;i<100&&!finished;i++)await new Promise(r=>setTimeout(r,5))
    assert.equal(finished,true)
    assert.doesNotMatch(requestText,/1993|4月16|个人档案：/)
  }finally{for(const f of effects.reverse())if(typeof f==='function')f();if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;rmSync(home,{recursive:true,force:true})}
})

test('known personal categories default to on-demand, including evidence-only private data',()=>{
  for(const text of ['生日是1993年4月16日','个人档案：女性','病史与用药资料','亲密关系与伴侣','家庭住址','[private:personal] opaque','birthday is April 16'])assert.equal(privateMemory(text),true)
  assert.equal(privateMemory({summary:'工作反馈先给结论',evidence:[{quote:'我的生日是1993年4月16日，我希望先给结论。'}]}),true)
  assert.equal(memoryPrivacy('字幕交付先检查中英断句').exposure,'automatic')
  assert.equal(privateMemory('工具失败的原生记录仅用于诊断'),false)
})
test('background projections and pointers omit private evidence without changing originals',()=>{
  const secret={indexLine:'- [user] 个人档案：出生于1993年4月16日 — user.md',summary:'个人档案：出生于1993年4月16日',evidence:[]}
  const mixed={indexLine:'- [user] 回答先给结论 — user.md',summary:'回答先给结论',evidence:[{quote:'我的生日是1993年4月16日，回答先给结论'}]}
  const safe={indexLine:'- [feedback] 字幕保留断句 — feedback.md',summary:'字幕保留断句',evidence:[]}
  const records=[secret,mixed,safe],before=JSON.stringify(records)
  assert.deepEqual(publicMemoryRecords(records),[safe])
  assert.deepEqual(publicMemoryIndex(records.map(r=>r.indexLine),records),[safe.indexLine])
  assert.equal(JSON.stringify(records),before)
})
test('real plugin render and both current/history search hide private records by default',()=>{
  const home=realpathSync(mkdtempSync(join(tmpdir(),'memory-privacy-'))),old=process.env.DSH_HOME;process.env.DSH_HOME=home
  const cwd=join(home,'project'),providers=[],tools=[];mkdirSync(cwd)
  try{
    apply({systemPrompt:{context:p=>providers.push(p)},workingDirectory:{get:()=>cwd},tools:{register:t=>tools.push(t),schemas:()=>[{name:'memory_write'}]},on(){},effect(){}},{autoCapture:{enabled:false}})
    const dir=join(home,'memory'),secret='固定个人档案：出生于1993年4月16日，女性。'
    const privateWrite=writeFixtureMemory({dir,type:'user',scope:'global',summary:secret,detail:'私人资料分行\n1993-04-16\n女性',meaning:{kind:'claim'}})
    writeFixtureMemory({dir,type:'feedback',scope:'global',summary:'字幕验收先看断句',meaning:{kind:'preference'}})
    const before=readFileSync(join(dir,'MEMORY.md'),'utf8')
    const rendered=providers.find(p=>p.name==='memory:index').text({agent:{session:{}}})
    assert.doesNotMatch(rendered,/1993|女性|固定个人档案/)
    assert.match(rendered,/字幕验收先看断句/)
    assert.match(providers.find(p=>p.name==='memory:protocol').text({agent:{session:{}}}),/includePrivate=true/)
    assert.equal(searchStore(dir,'1993',{mode:'exact'}).hits.length,0)
    assert.ok(searchStore(dir,'1993',{mode:'exact',includePrivate:true}).hits.length>0)
    assert.equal(lookupLinks(dir,{id:privateWrite.id}).found,false)
    assert.equal(lookupLinks(dir,{match:'个人档案'}).found,false)
    assert.equal(searchStore(dir,'1993',{mode:'exact',view:'history',scope:'global'}).hits.length,0)
    assert.ok(searchStore(dir,'1993',{mode:'exact',view:'history',scope:'global',includePrivate:true}).hits.length>0)
    assert.throws(()=>searchStore(dir,'1993',{includePrivate:'true'}),/private-option/)
    assert.equal(readFileSync(join(dir,'MEMORY.md'),'utf8'),before)
    assert.ok(tools.find(t=>t.name==='memory_search').parameters.properties.includePrivate)
  }finally{if(old===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=old;rmSync(home,{recursive:true,force:true})}
})
