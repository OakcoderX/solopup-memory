import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stageCandidate, listCandidates, rejectCandidate, withdrawSource, pruneCandidates } from './candidates.mjs'
import { writeSafely } from './security.mjs'

const modulePath = fileURLToPath(new URL('./candidates.mjs', import.meta.url))
const cli = fileURLToPath(new URL('./scripts/candidates.mjs', import.meta.url))
const fixture = (n = 0) => ({ type: 'user', scope: 'project', summary: `本项目可能偏好低反差方案 ${n}`,
  sessionId: 'session-test', indexRevision: 'a'.repeat(64),
  evidence: [{ messageId: `message-${n}`, hash: 'b'.repeat(64), quote: '这次我选低反差的那一张图' }] })
function box(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-candidates-'))
  try { return run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('空候选箱只读查询不创建文件或目录', () => box((dir) => {
  const path = join(dir, 'absent')
  assert.deepEqual(listCandidates(path), { revision: 0, total: 0, records: [], truncated: false })
  assert.equal(existsSync(path), false)
}))
test('候选持久化，版本递增，逐字重复不膨胀', () => box((dir) => {
  const a = stageCandidate(dir, fixture())
  assert.equal(a.status, 'pending')
  assert.equal(stageCandidate(dir, fixture()).duplicate, true)
  const state = listCandidates(dir)
  assert.equal(state.total, 1)
  assert.equal(state.revision, 1)
  assert.equal(state.records[0].evidence[0].quote, fixture().evidence[0].quote)
  assert.equal(statSync(join(dir, '.candidates.json')).mode & 0o777, 0o600)
  assert.equal(existsSync(join(dir, 'MEMORY.md')), false)
}))
test('拒绝保持正文可审阅，同候选不会再次变 pending', () => box((dir) => {
  const { id } = stageCandidate(dir, fixture())
  assert.equal(rejectCandidate(dir, id).status, 'rejected')
  assert.equal(stageCandidate(dir, fixture()).status, 'rejected')
  assert.equal(listCandidates(dir).total, 0)
  assert.equal(listCandidates(dir, { status: 'rejected' }).records[0].summary, fixture().summary)
}))
test('来源撤回同时清除多候选正文，并拒绝同源改写重新进入', () => box((dir) => {
  stageCandidate(dir, fixture())
  stageCandidate(dir, { ...fixture(), summary: '可能偏好的其实是人物空间纵深' })
  assert.equal(withdrawSource(dir, 'session-test', 'message-0').withdrawn, 2)
  assert.equal(withdrawSource(dir, 'session-test', 'message-0').duplicate, true)
  assert.equal(stageCandidate(dir, { ...fixture(), summary: '再次换个说法试图重入候选' }).status, 'withdrawn')
  const raw = readFileSync(join(dir, '.candidates.json'), 'utf8')
  assert.ok(!raw.includes('低反差'))
  assert.ok(!raw.includes('空间纵深'))
  assert.equal(listCandidates(dir).total, 0)
  assert.equal(listCandidates(dir, { status: 'withdrawn' }).total, 2)
}))
test('空箱先撤回来源，后到达的异步候选也不得入箱', () => box((dir) => {
  withdrawSource(dir, 'session-test', 'message-0')
  assert.equal(stageCandidate(dir, fixture()).status, 'withdrawn')
  assert.equal(listCandidates(dir, { status: 'all' }).total, 0)
}))
test('撤回不牵连另一会话的同名消息', () => box((dir) => {
  withdrawSource(dir, 'session-test', 'message-0')
  assert.equal(stageCandidate(dir, { ...fixture(), sessionId: 'other-session' }).status, 'pending')
}))
for (const [name, patch] of [
  ['凭据', { detail: `sk-${'a'.repeat(32)}` }],
  ['缺证据', { evidence: [] }], ['坏哈希', { indexRevision: 'invalid' }],
  ['项目越界', { type: 'project', scope: 'global' }], ['超长摘要', { summary: '字'.repeat(201) }],
]) test(`候选拒绝：${name}`, () => box((dir) => {
  assert.throws(() => stageCandidate(dir, { ...fixture(), ...patch }))
  assert.equal(existsSync(join(dir, '.candidates.json')), false)
}))
test('损坏 JSON 不清空重建；原文件保留', () => box((dir) => {
  const p = join(dir, '.candidates.json'); writeFileSync(p, 'corrupt')
  assert.throws(() => stageCandidate(dir, fixture()), /corrupt-json/)
  assert.equal(readFileSync(p, 'utf8'), 'corrupt')
}))
test('文件符号链接被拒绝，不读写目标', () => box((dir) => {
  const target = join(dir, 'target'); writeFileSync(target, 'sentinel')
  symlinkSync(target, join(dir, '.candidates.json'))
  assert.throws(() => listCandidates(dir))
  assert.throws(() => stageCandidate(dir, fixture()))
  assert.equal(readFileSync(target, 'utf8'), 'sentinel')
}))
test('容量满有明确失败，不自动删除旧候选', () => box((dir) => {
  for (let i = 0; i < 200; i += 1) stageCandidate(dir, fixture(i))
  const before = readFileSync(join(dir, '.candidates.json'), 'utf8')
  assert.throws(() => stageCandidate(dir, fixture(201)), /store-full/)
  assert.equal(readFileSync(join(dir, '.candidates.json'), 'utf8'), before)
  assert.equal(listCandidates(dir, { limit: 50 }).total, 200)
  const first = listCandidates(dir).records[0]
  rejectCandidate(dir, first.id)
  assert.equal(pruneCandidates(dir).applied, false)
  assert.equal(pruneCandidates(dir, { apply: true }).removed, 1)
  assert.equal(stageCandidate(dir, fixture(201)).status, 'pending')
  const old = fixture(Number(first.evidence[0].messageId.replace('message-', '')))
  assert.equal(stageCandidate(dir, old).status, 'rejected')
}))
test('清理保留来源撤回标记，默认 dry-run 不修改文件', () => box((dir) => {
  stageCandidate(dir, fixture())
  withdrawSource(dir, 'session-test', 'message-0')
  const file = join(dir, '.candidates.json'); const before = readFileSync(file, 'utf8')
  assert.equal(pruneCandidates(dir).removed, 1)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(pruneCandidates(dir, { apply: true }).removed, 1)
  assert.equal(stageCandidate(dir, fixture()).status, 'withdrawn')
  assert.equal(pruneCandidates(dir, { apply: true }).removed, 0)
}))
test('可预测旧临时文件链接不能劫持原子写入', () => box((dir) => {
  const target = join(dir, 'sentinel'); writeFileSync(target, 'untouched')
  const dest = join(dir, 'data.json')
  symlinkSync(target, `${dest}.tmp-${process.pid}`)
  writeSafely(dest, 'new-state')
  assert.equal(readFileSync(target, 'utf8'), 'untouched')
  assert.equal(readFileSync(dest, 'utf8'), 'new-state')
}))
test('原子替换失败时不遗留含正文的临时文件', () => box((dir) => {
  const target = join(dir, 'occupied'); mkdirSync(target)
  assert.throws(() => writeSafely(target, 'private candidate text'))
  assert.deepEqual(readdirSync(dir), ['occupied'])
}))
test('进程退出后候选依然可读取，CLI list 无写入', () => box((dir) => {
  const worker = `import {stageCandidate} from ${JSON.stringify(modulePath)};stageCandidate(process.argv[1],JSON.parse(process.argv[2]));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker, join(dir, 'memory'), JSON.stringify(fixture())], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
  const file = join(dir, 'memory', '.candidates.json')
  const before = readFileSync(file, 'utf8')
  const cliResult = spawnSync(process.execPath, [cli, 'list', '--scope', 'global'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: dir }, timeout: 5000 })
  assert.equal(cliResult.status, 0, cliResult.stderr)
  assert.equal(JSON.parse(cliResult.stdout).total, 1)
  assert.equal(readFileSync(file, 'utf8'), before)
}))
test('跨进程并发更新不丢候选或版本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-candidates-race-'))
  try {
    const worker = `import {stageCandidate} from ${JSON.stringify(modulePath)};for(let i=0;i<4;i++){const n=Number(process.argv[2])*4+i;const p=JSON.parse(process.argv[3]);p.summary+=' '+n;p.evidence[0].messageId+='-'+n;stageCandidate(process.argv[1],p)}`
    const outcomes = await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, dir, `${i}`, JSON.stringify(fixture())], { stdio: ['ignore', 'ignore', 'pipe'] })
      let error = ''; child.stderr.on('data', (s) => error += s)
      child.on('error', (e) => resolve({ code: -1, error: e.message }))
      child.on('exit', (code) => resolve({ code, error }))
    })))
    for (const result of outcomes) assert.equal(result.code, 0, result.error)
    assert.equal(listCandidates(dir).total, 16)
    assert.equal(listCandidates(dir).revision, 16)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
