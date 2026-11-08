import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { claimCaptureJob, assertCaptureClaim, finishCaptureJob, listCaptureJobs, recoverCaptureJobs, abandonCaptureJob, retryBusyWrite } from '../capture-jobs.mjs'
import { withLock } from '../security.mjs'

const modulePath = fileURLToPath(new URL('../capture-jobs.mjs', import.meta.url))
const hash = (v) => createHash('sha256').update(String(v)).digest('hex')
const options = { now: 1000, leaseMs: 1000 }
const file = (dir) => join(dir, '.capture-jobs.json')
function box(run) { const dir = mkdtempSync(join(tmpdir(), 'dsh-jobs-')); try { return run(dir) } finally { rmSync(dir, { recursive: true, force: true }) } }

test('作业只读查看不创建账本或缺失库', () => box((dir) => {
  const missing = join(dir, 'missing')
  assert.deepEqual(listCaptureJobs(missing), { revision: 0, jobs: [] })
  assert.equal(existsSync(missing), false)
}))
test('调用前原子保存身份、租约和令牌；列表不暴露令牌', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('input'), options)
  assert.equal(job.claimed, true)
  assert.equal(listCaptureJobs(dir, { now: 1001 }).jobs[0].status, 'running')
  assert.equal(listCaptureJobs(dir, { now: 1001 }).jobs[0].token, undefined)
  assert.equal(statSync(file(dir)).mode & 0o777, 0o600)
  assert.doesNotThrow(() => assertCaptureClaim(dir, job, { now: 1001 }))
}))
test('重启或并发同指纹不会重复领取、成功后也不重复调模型', () => box((dir) => {
  const first = claimCaptureJob(dir, hash('same'), options)
  assert.equal(claimCaptureJob(dir, hash('same'), options).claimed, false)
  finishCaptureJob(dir, first, { outcome: 'ok', counts: { proposed: 0 } }, { now: 1500 })
  const later = claimCaptureJob(dir, hash('same'), { now: 2500 })
  assert.equal(later.claimed, false)
  assert.equal(later.status, 'succeeded')
}))
test('租约过期后标未决；不重发、不允许旧工作者发布或完成', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('unknown'), options)
  const before = readFileSync(file(dir), 'utf8')
  assert.equal(listCaptureJobs(dir, { now: 2000 }).jobs[0].status, 'uncertain')
  assert.equal(readFileSync(file(dir), 'utf8'), before)
  assert.deepEqual(recoverCaptureJobs(dir, { now: 2000 }), { expired: 1, uncertain: 1 })
  assert.throws(() => assertCaptureClaim(dir, job, { now: 2001 }), /stale-claim/)
  assert.throws(() => finishCaptureJob(dir, job, { outcome: 'ok' }, { now: 2001 }), /stale-claim/)
  assert.equal(claimCaptureJob(dir, hash('unknown'), { now: 2001 }).claimed, false)
}))
test('错误令牌与回拨时间不能完成别人的作业', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('token'), options)
  assert.throws(() => assertCaptureClaim(dir, { ...job, token: '0'.repeat(36) }, { now: 1500 }), /stale-claim/)
  assert.throws(() => finishCaptureJob(dir, job, { outcome: 'ok' }, { now: 500 }), /stale-claim/)
  assert.equal(listCaptureJobs(dir, { now: 1500 }).jobs[0].status, 'running')
}))
test('错误与部分写入明确终结，异常正文不能存入调用账本', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('failure'), options)
  finishCaptureJob(dir, job, { outcome: 'partial', reason: 'private provider body', counts: { inserted: 1 } }, { now: 1500 })
  const result = listCaptureJobs(dir, { now: 1501 }).jobs[0]
  assert.equal(result.status, 'failed'); assert.equal(result.outcome, 'partial')
  assert.equal(result.reason, 'capture-failed'); assert.equal(result.counts.inserted, 1)
  assert.doesNotMatch(readFileSync(file(dir), 'utf8'), /private provider body|token/)
}))
test('未知输入、结果和凭据样式指纹均拒绝，不创建正文账本', () => box((dir) => {
  for (const fingerprint of ['sk-' + 'a'.repeat(32), ['a'.repeat(64)], 'bad']) assert.throws(() => claimCaptureJob(dir, fingerprint, options), /invalid-claim/)
  assert.equal(existsSync(file(dir)), false)
  const job = claimCaptureJob(dir, hash('validation'), options)
  for (const counts of [{ text: 'secret' }, { proposed: -1 }, []]) assert.throws(() => finishCaptureJob(dir, job, { outcome: 'ok', counts }, { now: 1500 }), /invalid-result/)
}))
test('损坏和带多余正文的账本保留现场并拒绝新调用', () => box((dir) => {
  claimCaptureJob(dir, hash('valid'), options)
  const state = JSON.parse(readFileSync(file(dir)))
  state.jobs[0].prompt = 'must not persist'
  const text = JSON.stringify(state); writeFileSync(file(dir), text)
  assert.throws(() => claimCaptureJob(dir, hash('next'), options), /corrupt/)
  assert.equal(readFileSync(file(dir), 'utf8'), text)
}))
test('账本符号链接不能让新调用改写目标', () => box((dir) => {
  const target = join(dir, 'outside'); writeFileSync(target, 'unchanged')
  symlinkSync(target, file(dir))
  assert.throws(() => claimCaptureJob(dir, hash('link'), options), /corrupt/)
  assert.equal(readFileSync(target, 'utf8'), 'unchanged')
}))
test('满额时保留全部未决任务，不丢队列来腾容量', () => box((dir) => {
  for (let i = 0; i < 256; i++) claimCaptureJob(dir, hash(i), options)
  assert.throws(() => claimCaptureJob(dir, hash(257), { now: 2500 }), /full/)
  assert.equal(listCaptureJobs(dir, { now: 2500 }).jobs.length, 256)
  assert.ok(listCaptureJobs(dir, { now: 2500 }).jobs.every((job) => job.status === 'uncertain'))
}))
test('仅已知终态记录可按容量老化，不删除未决记录', () => box((dir) => {
  const first = claimCaptureJob(dir, hash('terminal'), options)
  finishCaptureJob(dir, first, { outcome: 'ok' }, { now: 1500 })
  for (let i = 0; i < 255; i++) claimCaptureJob(dir, hash(i), options)
  assert.equal(claimCaptureJob(dir, hash('new'), { now: 1600 }).claimed, true)
  const rows = listCaptureJobs(dir, { now: 1601 }).jobs
  assert.equal(rows.length, 256); assert.ok(!rows.some((job) => job.id === first.id))
}))
test('真实进程在领取后 SIGKILL，重开账本保留未决状态且不重新领取', () => box((dir) => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {claimCaptureJob} from ${JSON.stringify(modulePath)}; claimCaptureJob(process.env.JOB_DIR, ${JSON.stringify(hash('crash'))}, {now:1000,leaseMs:1000}); process.kill(process.pid,'SIGKILL');`],
    { env: { ...process.env, JOB_DIR: dir }, encoding: 'utf8', timeout: 5000 })
  assert.equal(child.signal, 'SIGKILL')
  assert.deepEqual(recoverCaptureJobs(dir, { now: 2001 }), { expired: 1, uncertain: 1 })
  assert.equal(claimCaptureJob(dir, hash('crash'), { now: 2001 }).claimed, false)
}))

test('两个真实进程并发领取同一快照，只有一个领取成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jobs-concurrent-'))
  try {
    const start = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import {claimCaptureJob} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(claimCaptureJob(process.env.JOB_DIR, ${JSON.stringify(hash('concurrent'))})));`],
        { env: { ...process.env, JOB_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''; let err = ''
      child.stdout.on('data', (chunk) => { out += chunk }); child.stderr.on('data', (chunk) => { err += chunk })
      child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)))
    })
    const results = await Promise.all([start(), start()])
    assert.equal(results.filter((result) => result.claimed).length, 1)
    assert.equal(listCaptureJobs(dir).jobs.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('诊断 CLI 默认只读；recover --apply 只标未决，不执行模型请求', () => box((dir) => {
  const script = fileURLToPath(new URL('../scripts/capture-jobs.mjs', import.meta.url))
  const env = { ...process.env, DSH_HOME: dir }
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(run().status, 0); assert.equal(existsSync(join(dir, 'memory')), false)
  const store = join(dir, 'memory'); claimCaptureJob(store, hash('cli'), options)
  const before = readFileSync(file(store), 'utf8')
  const preview = run('recover'); assert.equal(preview.status, 0)
  assert.equal(JSON.parse(preview.stdout).jobs[0].status, 'uncertain')
  assert.equal(readFileSync(file(store), 'utf8'), before)
  const applied = run('recover', '--apply'); assert.equal(applied.status, 0)
  assert.equal(JSON.parse(applied.stdout).expired, 1)
  assert.doesNotMatch(run().stdout, /token/)
  assert.equal(run('list', '--apply').status, 1)
}))

test('仅锁前占用错误可有界重试；临界区已执行的普通错误不重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-busy-write-'))
  try {
    const lock = join(dir, '.write.lock'); writeFileSync(lock, '{}')
    let guards = 0; let writes = 0
    const result = await retryBusyWrite(() => withLock(dir, () => { writes += 1; return 'written' }, { timeoutMs: 1 }),
      { delayMs: 0, beforeAttempt: () => { guards += 1; if (guards === 2) unlinkSync(lock) } })
    assert.equal(result, 'written'); assert.equal(guards, 2); assert.equal(writes, 1)
    let unknownAttempts = 0
    await assert.rejects(retryBusyWrite(() => withLock(dir, () => { unknownAttempts += 1; throw new Error('unknown-after-write') })), /unknown-after-write/)
    assert.equal(unknownAttempts, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('占用重试前重新检查租约/版本，失败即停止；持续占用最多三次', async () => {
  let attempts = 0; let guard = 0
  await assert.rejects(retryBusyWrite(() => { attempts += 1; throw Object.assign(new Error('busy'), { code: 'memory-lock-busy' }) },
    { delayMs: 0, beforeAttempt: () => { if (++guard === 2) throw new Error('revision-or-lease-changed') } }), /revision-or-lease-changed/)
  assert.equal(attempts, 1)
  attempts = 0
  await assert.rejects(retryBusyWrite(() => { attempts += 1; throw Object.assign(new Error('busy'), { code: 'memory-lock-busy' }) }, { delayMs: 0 }), /busy/)
  assert.equal(attempts, 3)
})

test('未决处置预览只读，包括过期但尚未落盘的租约', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('preview'), options)
  const before = readFileSync(file(dir), 'utf8')
  const preview = abandonCaptureJob(dir, job.id, { now: 2000 })
  assert.equal(preview.applied, false); assert.equal(preview.job.status, 'uncertain')
  assert.equal(preview.revision, 1); assert.equal(preview.externalOutcome, 'unknown')
  assert.equal(preview.job.token, undefined)
  assert.equal(readFileSync(file(dir), 'utf8'), before)
}))

test('未决处置须携带已查看的账本版本；明确放弃等待不伪造调用结果', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('close-waiting'), options)
  const before = readFileSync(file(dir), 'utf8')
  assert.throws(() => abandonCaptureJob(dir, job.id, { apply: true, now: 2001 }), /review-required/)
  assert.equal(readFileSync(file(dir), 'utf8'), before)
  const preview = abandonCaptureJob(dir, job.id, { now: 2001 })
  const done = abandonCaptureJob(dir, job.id, { apply: true, expectedRevision: preview.revision, now: 2002 })
  assert.equal(done.applied, true); assert.equal(done.revision, 2)
  assert.equal(done.job.status, 'abandoned'); assert.equal(done.job.reason, 'operator-abandoned')
  assert.equal(done.externalOutcome, 'unknown'); assert.equal(done.modelRequestResent, false)
  assert.equal(done.publishedMemoryRolledBack, false)
  assert.equal(done.job.outcome, undefined); assert.equal(done.job.counts, undefined)
  assert.equal(done.job.token, undefined)
  assert.doesNotMatch(readFileSync(file(dir), 'utf8'), /close-waiting|prompt|token/)
}))

test('并发状态变化使处置预览失效，拒绝时不改写账本', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('stale-review'), options)
  const review = abandonCaptureJob(dir, job.id, { now: 2001 })
  claimCaptureJob(dir, hash('other'), { now: 2002 })
  const before = readFileSync(file(dir), 'utf8')
  assert.throws(() => abandonCaptureJob(dir, job.id, { apply: true, expectedRevision: review.revision, now: 2003 }), /review-stale/)
  assert.equal(readFileSync(file(dir), 'utf8'), before)
}))

test('运行中和成功/失败记录不能伪装成未决；无效定位与回拨时间无副作用', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('state-guards'), options)
  const invalid = [undefined, 'short', 'sk-' + 'a'.repeat(32)]
  for (const id of invalid) assert.throws(() => abandonCaptureJob(dir, id, { now: 1001 }), /invalid-abandon/)
  assert.throws(() => abandonCaptureJob(dir, hash('missing'), { now: 1001 }), /not-found/)
  for (const apply of [false, true]) assert.throws(() => abandonCaptureJob(dir, job.id, { apply, expectedRevision: 1, now: 1001 }), /not-uncertain/)
  finishCaptureJob(dir, job, { outcome: 'ok' }, { now: 1500 })
  const before = readFileSync(file(dir), 'utf8')
  assert.throws(() => abandonCaptureJob(dir, job.id, { now: 2500 }), /not-uncertain/)
  assert.equal(readFileSync(file(dir), 'utf8'), before)
  const failed = claimCaptureJob(dir, hash('failed'), { now: 2500 })
  finishCaptureJob(dir, failed, { outcome: 'error' }, { now: 2600 })
  assert.throws(() => abandonCaptureJob(dir, failed.id, { now: 2700 }), /not-uncertain/)
}))

test('已放弃调用在保留期内不重领，旧令牌不能发布或标成功，重做处置不写盘', () => box((dir) => {
  const input = hash('retained-identity'); const job = claimCaptureJob(dir, input, options)
  abandonCaptureJob(dir, job.id, { apply: true, expectedRevision: 1, now: 2001 })
  assert.equal(claimCaptureJob(dir, input, { now: 2002 }).status, 'abandoned')
  assert.throws(() => assertCaptureClaim(dir, job, { now: 2002 }), /stale-claim/)
  assert.throws(() => finishCaptureJob(dir, job, { outcome: 'ok' }, { now: 2002 }), /stale-claim/)
  const before = readFileSync(file(dir), 'utf8')
  const revision = listCaptureJobs(dir, { now: 2002 }).revision
  assert.equal(abandonCaptureJob(dir, job.id, { apply: true, expectedRevision: revision, now: 2003 }).applied, false)
  assert.equal(readFileSync(file(dir), 'utf8'), before)
  assert.throws(() => abandonCaptureJob(dir, job.id, { now: 2000 }), /invalid-time/)
}))

test('满额未决账本只在明确放弃一个记录后允许新调用，其余未决全部保留', () => box((dir) => {
  for (let i = 0; i < 256; i++) claimCaptureJob(dir, hash(i), options)
  const before = readFileSync(file(dir), 'utf8')
  assert.throws(() => claimCaptureJob(dir, hash('next'), { now: 2001 }), /full/)
  assert.equal(readFileSync(file(dir), 'utf8'), before)
  const review = listCaptureJobs(dir, { now: 2001 })
  const target = review.jobs[42]
  abandonCaptureJob(dir, target.id, { apply: true, expectedRevision: review.revision, now: 2001 })
  assert.equal(claimCaptureJob(dir, hash('next'), { now: 2002 }).claimed, true)
  const after = listCaptureJobs(dir, { now: 2003 }).jobs
  assert.equal(after.length, 256); assert.equal(after.filter(j => j.status === 'uncertain').length, 255)
  assert.equal(after.some(j => j.id === target.id), false)
}))

test('损坏的放弃状态、伪造已知结果、符号链接均不能通过处置改写', () => box((dir) => {
  const job = claimCaptureJob(dir, hash('tamper'), options)
  const original = JSON.parse(readFileSync(file(dir)))
  for (const patch of [{ status: 'abandoned' }, { status: 'abandoned', reason: 'operator-abandoned', token: undefined, outcome: 'ok' }, { reason: 'operator-abandoned' }]) {
    const state = structuredClone(original); Object.assign(state.jobs[0], patch)
    const text = JSON.stringify(state); writeFileSync(file(dir), text)
    assert.throws(() => abandonCaptureJob(dir, job.id, { apply: true, expectedRevision: 1, now: 2001 }), /corrupt/)
    assert.equal(readFileSync(file(dir), 'utf8'), text)
  }
  unlinkSync(file(dir)); const outside = join(dir, 'unrelated'); writeFileSync(outside, 'untouched'); symlinkSync(outside, file(dir))
  assert.throws(() => abandonCaptureJob(dir, job.id, { apply: true, expectedRevision: 1, now: 2001 }), /corrupt/)
  assert.equal(readFileSync(outside, 'utf8'), 'untouched')
}))

test('进程领取后被杀，另一进程可明确放弃未决而不重领或暴露令牌', () => box((dir) => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {claimCaptureJob} from ${JSON.stringify(modulePath)};claimCaptureJob(process.env.JOB_DIR,${JSON.stringify(hash('killed-before-close'))},{now:1000,leaseMs:1000});process.kill(process.pid,'SIGKILL');`],
    { env: { ...process.env, JOB_DIR: dir }, encoding: 'utf8', timeout: 5000 })
  assert.equal(child.signal, 'SIGKILL')
  const state = listCaptureJobs(dir, { now: 2001 })
  const closed = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {abandonCaptureJob} from ${JSON.stringify(modulePath)};console.log(JSON.stringify(abandonCaptureJob(process.env.JOB_DIR,${JSON.stringify(state.jobs[0].id)},{apply:true,expectedRevision:1,now:2001})));`],
    { env: { ...process.env, JOB_DIR: dir }, encoding: 'utf8', timeout: 5000 })
  assert.equal(closed.status, 0, closed.stderr)
  assert.equal(JSON.parse(closed.stdout).job.status, 'abandoned'); assert.doesNotMatch(closed.stdout, /token/)
  assert.equal(claimCaptureJob(dir, hash('killed-before-close'), { now: 2002 }).claimed, false)
}))

test('两个真实进程对同一预览并发处置，仅一次生效，另一方获得过期提示', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-jobs-abandon-race-'))
  try {
    const job = claimCaptureJob(dir, hash('close-race'), options)
    const start = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import {abandonCaptureJob} from ${JSON.stringify(modulePath)};try{console.log(JSON.stringify(abandonCaptureJob(process.env.JOB_DIR,${JSON.stringify(job.id)},{apply:true,expectedRevision:1,now:2001})))}catch(e){console.log(JSON.stringify({error:e.message}))}`],
        { env: { ...process.env, JOB_DIR: dir }, stdio: ['ignore','pipe','pipe'] })
      let out='';let err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c)
      child.once('error',reject);child.once('exit',code=>{try{code===0?resolve(JSON.parse(out)):reject(new Error(err))}catch(e){reject(e)}})
    })
    const settled = await Promise.allSettled([start(),start()])
    for(const row of settled)if(row.status==='rejected')throw row.reason
    const values=settled.map(row=>row.value)
    assert.equal(values.filter(row=>row.applied).length,1)
    assert.equal(values.filter(row=>row.error==='capture-jobs-review-stale').length,1)
    assert.equal(listCaptureJobs(dir,{now:2002}).revision,2)
  } finally { rmSync(dir, { recursive:true, force:true }) }
})

test('处置 CLI 默认预览，缺版本/未知参数/过期版本不修改记录，明确应用后仍为未知结果', () => box((dir) => {
  const script = fileURLToPath(new URL('../scripts/capture-jobs.mjs', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, DSH_HOME: dir }, encoding: 'utf8', timeout: 5000 })
  const job = claimCaptureJob(join(dir, 'memory'), hash('cli-close'), options)
  const before = readFileSync(file(join(dir,'memory')),'utf8')
  const preview = run('abandon',job.id); assert.equal(preview.status,0,preview.stderr)
  const revision = String(JSON.parse(preview.stdout).revision)
  for(const args of [['abandon',job.id,'--apply'],['abandon',job.id,'--revision',revision],['abandon',job.id,'--apply','--revision','1e0'],['abandon',job.id,'--apply','--revision','0'],['abandon',job.id,'--apply','--revision',revision,'--apply']])assert.equal(run(...args).status,1)
  assert.equal(readFileSync(file(join(dir,'memory')),'utf8'),before)
  const done=run('abandon',job.id,'--apply','--revision',revision);assert.equal(done.status,0,done.stderr)
  assert.equal(JSON.parse(done.stdout).externalOutcome,'unknown')
  assert.equal(JSON.parse(run().stdout).jobs[0].status,'abandoned')
  assert.doesNotMatch(run().stdout,/token/)
}))
