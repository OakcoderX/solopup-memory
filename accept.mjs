#!/usr/bin/env node
/** Read-only official-profile installation checks; never claims semantic release readiness. */
import {readFileSync,existsSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {homedir} from 'node:os'
import {VERSION} from './version.mjs'
import {managedMemoryStatus} from './index.mjs'
const args=process.argv.slice(2)
if(args.length&&!(args.length===2&&args[0]==='--profile'&&/^[a-zA-Z0-9_-]+$/.test(args[1]))){console.error('Usage: node accept.mjs [--profile NAME]');process.exit(2)}
const profile=args[1]??'desktop',home=resolve(process.env.DSH_HOME??join(homedir(),'.dsh')),dir=join(home,'profiles',profile),root=join(home,'memory'),read=file=>JSON.parse(readFileSync(file,'utf8')),rows=[]
const check=(name,run)=>{try{rows.push({name,passed:true,...run()})}catch(error){rows.push({name,passed:false,reason:error.code??error.message})}}
check('official-bundle',()=>{const p=read(join(dir,'package.json'));if(p.dsh?.profile?.bundles?.filter(name=>name==='solopup-memory').length!==1)throw Error('bundle-not-selected-once');if(p.dsh.profile.bundles.includes('dsh-memory'))throw Error('old-and-new-memory-bundles-both-enabled');return{profile}})
check('installed-package',()=>{const p=read(join(dir,'node_modules','solopup-memory','package.json'));if(p.name!=='solopup-memory'||p.version!==VERSION||p.dsh?.bundle?.patch!=='./cordis.patch.yml')throw Error('installed-package-mismatch');return{version:p.version}})
check('live-runtime',()=>{const stamp=read(join(root,'.loaded.json')),required=['memory_write','memory_forget','memory_links','memory_search','memory_prune','memory_status'];if(stamp.version!==VERSION||!Number.isSafeInteger(stamp.pid)||stamp.pid<1||!required.every(name=>stamp.tools?.includes(name))||stamp.degraded?.length!==0||stamp.sourceControl?.state!=='managed'||!stamp.memoryHistory?.available||!stamp.autoCapture?.inputRecovery?.available)throw Error('live-runtime-not-ready');process.kill(stamp.pid,0);return{version:stamp.version,pid:stamp.pid,loadedAt:stamp.loadedAt,tools:required.length}})
check('managed-control',()=>{if(!existsSync(root+'.control-binding.json'))throw Error('control-binding-missing');const s=managedMemoryStatus(root);if(!s.registered||s.stores.some(row=>row.quarantined)||s.operations.some(op=>op.pending))throw Error('managed-control-needs-review-or-cleanup');return{stores:s.stores.length,pending:0}})
const passed=rows.every(row=>row.passed)
console.log(JSON.stringify({passed,scope:'read-only installation health, not natural-dialogue or stable-release acceptance',version:VERSION,profile,checks:rows},null,2))
if(!passed)process.exitCode=1
