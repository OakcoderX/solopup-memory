import {spawnSync,execFileSync} from 'node:child_process'
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {tmpdir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
export function classifyGate(status,stdout){
  const failures=stdout.split('\n').filter(l=>l.startsWith('[FAIL]'))
  const timingOnly=failures.length===1&&failures[0]==='[FAIL] C 渲染中位数 < 5 ms'
  return {correctnessPassed:status===0||status===1&&timingOnly,timingPassed:status===0,failures}
}
export function compareTiming(baseline,candidate){
  const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)]
  if(baseline.length!==3||candidate.length!==3||[...baseline,...candidate].some(n=>!Number.isFinite(n)||n<=0))throw Error('three valid paired timing samples required')
  const before=median(baseline),after=median(candidate),limit=Math.max(before*1.25,before+0.25)
  return {regressionPassed:after<=limit,baselineMedianMs:before,candidateMedianMs:after,limitMs:limit,policy:'same-runner median of 3 paired runs; maximum 25 percent regression or 0.25ms scheduling allowance'}
}
function evaluate(cwd){
 const r=spawnSync(process.execPath,['eval/run-eval.mjs','--check'],{cwd,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
 const out=r.stdout??'',state=classifyGate(r.status,out),time=Number(/N=\s*300.*?渲染中位=([\d.]+)\s*ms/.exec(out)?.[1])
 return {out,error:r.stderr??'',...state,time}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const current=evaluate(process.cwd());process.stdout.write(current.out);process.stderr.write(current.error)
 const report={...classifyGate(current.correctnessPassed?(current.timingPassed?0:1):2,current.out),platform:process.platform,passed:false,measurements:current.out.split('\n').filter(l=>l.includes('渲染中位='))}
 if(process.env.GITHUB_ACTIONS==='true'&&current.correctnessPassed){
  const root=mkdtempSync(join(tmpdir(),'solopup-performance-reference-'))
  try{
   const response=await fetch('https://registry.npmjs.org/solopup-memory/-/solopup-memory-0.21.0-beta.3.tgz',{signal:AbortSignal.timeout(20000),redirect:'error'});if(!response.ok)throw Error('performance reference unavailable')
   const bytes=Buffer.from(await response.arrayBuffer()),sha=createHash('sha256').update(bytes).digest('hex')
   if(sha!=='6ab129df42e3220832a06e840640e38b3e0e8ee340a9684d047744b6b89b8a5e')throw Error('performance reference digest mismatch')
   const archive=join(root,'reference.tgz');writeFileSync(archive,bytes);execFileSync('tar',['-xzf',archive,'-C',root])
   const baseline=[],candidate=[current.time];let absolutePassed=current.timingPassed
   for(let i=0;i<3;i++){
    const runBase=()=>{const r=evaluate(join(root,'package'));if(!r.correctnessPassed)throw Error('reference correctness gate failed');baseline.push(r.time)}
    const runCandidate=()=>{const r=evaluate(process.cwd());if(!r.correctnessPassed)throw Error('candidate correctness gate failed');candidate.push(r.time);absolutePassed&&=r.timingPassed}
    if(i===0)runBase();else if(i%2){runBase();runCandidate()}else{runCandidate();runBase()}
   }
   Object.assign(report,compareTiming(baseline,candidate),{baselineVersion:'0.21.0-beta.3',baselineSha256:sha,baselineSamples:baseline,candidateSamples:candidate,timingPassed:absolutePassed,scope:'Hosted CI enforces correctness and a fixed-release same-runner performance comparison. Absolute 5ms is reported, not certified on shared hardware; the separate local Mac gate is unchanged.'})
   report.passed=report.correctnessPassed&&report.regressionPassed
   if(!absolutePassed)console.log('::warning title=Hosted absolute timing::At least one sample exceeds the local Mac 5ms reference budget. Raw measurements are retained; same-runner regression is evaluated separately.')
  }catch(e){report.error=e.message}finally{rmSync(root,{recursive:true,force:true})}
 }else{report.passed=current.correctnessPassed&&current.timingPassed;report.scope='Local original correctness and 5ms timing gate; unchanged threshold.'}
 mkdirSync('release-gates',{recursive:true});writeFileSync(`release-gates/${process.platform}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
}
