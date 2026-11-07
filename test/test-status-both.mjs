import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {apply,storeDirFor,managedMemoryStatus,withdrawManagedSource} from '../index.mjs'
import {writeFixtureMemory} from '../fixture-host.mjs'
import {candidateSnapshot} from '../candidates.mjs'
import {restorationJournalPath} from '../restoration-lock.mjs'
const hash=x=>createHash('sha256').update(x).digest('hex')
async function box(run){const root=realpathSync(mkdtempSync(join(tmpdir(),'status-both-'))),home=join(root,'home'),cwd=join(root,'work'),previous=process.env.DSH_HOME;mkdirSync(home);mkdirSync(cwd);writeFileSync(join(cwd,'.dsh-root'),'');process.env.DSH_HOME=home;const f={root,home,cwd,data:join(home,'memory'),tools:[],effects:[],ctx:{}};f.ctx={systemPrompt:{context(){}},workingDirectory:{get:()=>f.cwd},tools:{register:t=>f.tools.push(t)},on(){},effect(fn){f.effects.push(fn())}};apply(f.ctx,{autoCapture:{enabled:false}});f.status=f.tools.find(t=>t.name==='memory_status');f.exec={agent:{session:{id:'status-owner'}}};try{return await run(f)}finally{for(const fn of f.effects.reverse())fn?.();if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;rmSync(root,{recursive:true,force:true})}}
function seed(dir,summary,scope='global'){return writeFixtureMemory({dir,summary,type:'user',scope,detail:'Synthetic detail '+summary})}
function fingerprint(dir){const out=[];const walk=(path,prefix='')=>{for(const name of readdirSync(path).sort()){const full=join(path,name),p=prefix?prefix+'/'+name:name;try{out.push([p,hash(readFileSync(full))])}catch(e){if(e.code==='EISDIR'){out.push([p,'dir']);walk(full,p)}else throw e}}};walk(dir);return out}
test('both reports global and current project separately, never another project or an invented combined total',()=>box(async f=>{
 seed(f.data,'Global alpha4826');const current=storeDirFor('project',f.cwd);seed(current,'Current beta5937','project');seed(current,'Current gamma6048','project');const other=join(f.root,'other');mkdirSync(other);seed(storeDirFor('project',other),'Other delta6159','project');const before=fingerprint(f.data),control=managedMemoryStatus(f.data).controlRevision
 const result=await f.status.execute({scope:'both'},f.exec);assert.equal(result.scope,'both');assert.equal(result.index,undefined);assert.deepEqual(result.stores.map(r=>[r.scope,r.available,r.status.index.lines]),[['global',true,1],['project',true,2]]);assert.ok(result.stores.every(r=>!JSON.stringify(r).includes('Other delta6159')));assert.equal(result.capture.coverage,'retained-global-jobs-only');assert.equal(result.sourceControl.state,'managed');assert.deepEqual(fingerprint(f.data),before);assert.equal(managedMemoryStatus(f.data).controlRevision,control)
 const rendered=f.status.output.render({scope:'both'},result).map(r=>r.text).join('\n');assert.match(rendered,/global（跨项目）/);assert.match(rendered,/project（当前项目）/);assert.equal((rendered.match(/捕获诊断/g)??[]).length,1)
}))
test('both with no owning agent reports project unavailable, while global and its count remain explicit',()=>box(async f=>{
 seed(f.data,'Global epsilon6260');const before=fingerprint(f.data),r=await f.status.execute({scope:'both'});assert.equal(r.stores[0].status.index.lines,1);assert.deepEqual(r.stores[1],{scope:'project',available:false,reason:'no-current-project'});assert.equal(r.stores[1].status,undefined);assert.deepEqual(fingerprint(f.data),before);assert.match(f.status.output.render({},r).map(x=>x.text).join('\n'),/计数未知/)
}))
test('an unregistered current project stays unregistered after readonly both status',()=>box(async f=>{
 const before=fingerprint(f.data),control=managedMemoryStatus(f.data);const r=await f.status.execute({scope:'both'},f.exec);assert.equal(r.stores[1].available,false);assert.equal(r.stores[1].reason,'project-not-registered');assert.equal(existsSync(join(f.data,'projects')),false);assert.deepEqual(fingerprint(f.data),before);assert.deepEqual(managedMemoryStatus(f.data),control)
}))
test('single-store calls retain their old flat shape and write scopes are not widened',()=>box(async f=>{
 seed(f.data,'Global zeta6371');const dir=storeDirFor('project',f.cwd);seed(dir,'Project eta6482','project');for(const scope of ['global','project']){const r=await f.status.execute({scope},f.exec);assert.equal(r.scope,undefined);assert.equal(r.stores,undefined);assert.equal(r.index.lines,1);assert.ok(f.status.output.render({scope},r)[0].text.includes('索引'))}
 for(const name of ['memory_write','memory_forget','memory_prune'])assert.deepEqual(f.tools.find(t=>t.name===name).parameters.properties.scope.enum,['project','global'])
 await assert.rejects(f.status.execute({scope:'all'},f.exec),/scope 必须/)
}))
test('a corrupt project source ledger is unavailable rather than a fabricated empty project',()=>box(async f=>{
 seed(f.data,'Global theta6593');const dir=storeDirFor('project',f.cwd);seed(dir,'Project iota6704','project');writeFileSync(join(dir,'.candidates.json'),'Synthetic corrupt private source body');const r=await f.status.execute({scope:'both'},f.exec);assert.equal(r.stores[0].status.index.lines,1);assert.deepEqual(r.stores[1],{scope:'project',available:false,reason:'project-status-unavailable'});assert.equal(JSON.stringify(r).includes('private source body'),false)
}))
test('a corrupt capture ledger remains globally unknown and is not duplicated per-store',()=>box(async f=>{
 storeDirFor('project',f.cwd);writeFileSync(join(f.data,'.capture-jobs.json'),'Synthetic corrupt capture body');const r=await f.status.execute({scope:'both'},f.exec);assert.equal(r.capture.available,false);assert.equal(r.capture.retained,undefined);assert.ok(r.stores.every(row=>row.status.capture===undefined));const text=f.status.output.render({},r).map(x=>x.text).join('\n');assert.equal((text.match(/捕获诊断/g)??[]).length,1);assert.match(text,/账本不可用，未知/);assert.doesNotMatch(text,/Synthetic corrupt/)
}))
test('restoration guard produces only unavailable source control for either status variant',()=>box(async f=>{
 writeFileSync(restorationJournalPath(f.data),'Synthetic incomplete restoration');for(const scope of ['global','project','both']){const r=await f.status.execute({scope},f.exec);assert.equal(r.sourceControl.code,'managed-memory-restore-in-progress');assert.equal(r.stores,undefined);assert.equal(r.index,undefined);assert.match(f.status.output.render({},r)[0].text,/恢复尚未完成/)}
}))
test('both metadata never turns observation discovery into cross-session access',()=>box(async f=>{
 const before=fingerprint(f.data);await assert.rejects(f.status.execute({scope:'both',includeObservations:'yes'},f.exec),/invalid-list-option/);assert.deepEqual(fingerprint(f.data),before);await assert.rejects(f.status.execute({scope:'both',includeObservations:true},f.exec),/source-unavailable/)
}))
