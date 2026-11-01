import {spawnSync} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
export function classifyGate(status,stdout,platform){
  const failures=stdout.split('\n').filter(l=>l.startsWith('[FAIL]'))
  const timingOnly=failures.length===1&&failures[0]==='[FAIL] C 渲染中位数 < 5 ms'
  const timingRequired=platform!=='linux'
  return {passed:status===0||status===1&&platform==='linux'&&timingOnly,correctnessPassed:status===0||status===1&&timingOnly,timingPassed:status===0,timingRequired,failures}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const r=spawnSync(process.execPath,['eval/run-eval.mjs','--check'],{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
  process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'')
  const report={...classifyGate(r.status,r.stdout??'',process.platform),platform:process.platform,scope:'The 5ms rendering budget is required on the macOS reference runner. Linux timing is reported, not performance-certified.',measurements:(r.stdout??'').split('\n').filter(l=>l.includes('渲染中位='))}
  mkdirSync('release-gates',{recursive:true});writeFileSync(`release-gates/${process.platform}.json`,JSON.stringify(report,null,2)+'\n')
  if(report.passed&&!report.timingPassed)console.log('::warning title=Linux timing not calibrated::The measured rendering median exceeds the Mac reference 5ms budget. This is recorded as a timing failure; Linux is not performance-certified. All correctness checks remain required.')
  if(!report.passed)process.exitCode=1
}
