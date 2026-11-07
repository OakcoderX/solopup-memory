import {realpathSync} from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { stageCandidate, listCandidates, rejectCandidate, withdrawSource, pruneCandidates } from '../candidates.mjs'
import { adoptCandidate, recoverMemoryPublication, writeMemory, storeRevision, indexLine, searchStore, apply } from '../index.mjs'
import { commitPublication } from '../publication.mjs'

const modulePath = fileURLToPath(new URL('../index.mjs', import.meta.url))
function fixture(dir) {
  return { type: 'user', scope: 'project', summary: '本项目偏好柔和低反差的光线', detail: '仅限本项目的夜间室内对白场景。',
    sessionId: 'review-session', indexRevision: storeRevision(dir),
    evidence: [{ messageId: 'review-message', hash: 'b'.repeat(64), quote: '这个项目的夜戏采用低反差光线' }] }
}
function box(run) { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-publication-'))); try { return run(dir) } finally { rmSync(dir, { recursive: true, force: true }) } }
function reviewed(dir) {
  const item = stageCandidate(dir, fixture(dir))
  const preview = adoptCandidate(dir, item.id)
  return { id: item.id, options: { apply: true, scope: 'project', reviewedIndex: preview.reviewedIndex, candidateRevision: preview.candidateRevision } }
}

test('采纳默认仅预览，无 index/topic 写入', () => box((dir) => {
  const item = stageCandidate(dir, fixture(dir)); const before = readFileSync(join(dir, '.candidates.json'), 'utf8')
  const preview = adoptCandidate(dir, item.id)
  assert.equal(preview.applied, false)
  assert.equal(preview.candidate.summary, fixture(dir).summary)
  assert.equal(readFileSync(join(dir, '.candidates.json'), 'utf8'), before)
  assert.equal(existsSync(join(dir, 'MEMORY.md')), false)
}))
test('采纳将索引、细节和候选状态一起发布，重复操作不再追加', () => box((dir) => {
  const { id, options } = reviewed(dir)
  assert.equal(adoptCandidate(dir, id, options).status, 'adopted')
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
  assert.equal(listCandidates(dir).total, 0)
  assert.equal(searchStore(dir, '低反差').hits.length, 1)
  assert.match(readFileSync(join(dir, 'user.md'), 'utf8'), /夜间室内/)
  const before = readFileSync(join(dir, 'user.md'), 'utf8')
  assert.equal(adoptCandidate(dir, id, options).duplicate, true)
  assert.equal(readFileSync(join(dir, 'user.md'), 'utf8'), before)
  assert.ok(!readdirSync(dir).some((name) => name.startsWith('.publication')))
  pruneCandidates(dir, { apply: true })
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
}))
test('预览后索引改变，旧审批令牌不能发布', () => box((dir) => {
  const { id, options } = reviewed(dir)
  writeMemory({ type: 'project', dir, line: indexLine('project', '新的独立项目决定需要人工复核') })
  assert.throws(() => adoptCandidate(dir, id, options), { code: 'capture-stale-revision' })
  assert.equal(listCandidates(dir).total, 1)
  assert.equal(searchStore(dir, '低反差').hits.length, 0)
}))
test('预览后候选箱改变，必须重新审阅', () => box((dir) => {
  const { id, options } = reviewed(dir)
  stageCandidate(dir, { ...fixture(dir), summary: '另一个需要独立审阅的构图判断' })
  assert.throws(() => adoptCandidate(dir, id, options), /stale-review/)
  assert.equal(existsSync(join(dir, 'MEMORY.md')), false)
}))
test('拒绝、撤回、跨范围与缺审批参数均不能采纳', () => box((dir) => {
  const { id, options } = reviewed(dir)
  assert.throws(() => adoptCandidate(dir, id, { ...options, scope: 'global' }), /scope-mismatch/)
  assert.throws(() => adoptCandidate(dir, id, { apply: true }), /stale-review/)
  rejectCandidate(dir, id)
  assert.throws(() => adoptCandidate(dir, id, options), /not-reviewable/)
  withdrawSource(dir, 'review-session', 'review-message')
  assert.throws(() => adoptCandidate(dir, id, options), /not-reviewable/)
}))
test('已采纳来源不能只撤回候选元数据，须处理有效记忆', () => box((dir) => {
  const { id, options } = reviewed(dir); adoptCandidate(dir, id, options)
  assert.throws(() => withdrawSource(dir, 'review-session', 'review-message'), /needs-effective-withdrawal/)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
}))

for (const at of ['journal', 0, 1, 2]) test(`采纳在 ${at} 中断后可恢复全部投影`, () => box((dir) => {
  const { id, options } = reviewed(dir)
  assert.throws(() => adoptCandidate(dir, id, { ...options, publicationFault: (event) => {
    if (event.phase === at || event.phase === 'file' && event.index === at) throw new Error('simulated interruption')
  } }), /simulated interruption/)
  assert.equal(recoverMemoryPublication(dir).recoverable, true)
  assert.throws(() => searchStore(dir, '低反差'), /needs-recovery/)
  assert.throws(() => listCandidates(dir), /needs-recovery/)
  assert.throws(() => writeMemory({ type: 'project', dir, line: indexLine('project', '不应插队的新条目') }), /needs-recovery/)
  assert.equal(recoverMemoryPublication(dir, { apply: true }).applied, true)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
  assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /低反差/)
  assert.match(readFileSync(join(dir, 'user.md'), 'utf8'), /夜间室内/)
  assert.equal(adoptCandidate(dir, id, options).duplicate, true)
}))
test('恢复前发现外部编辑，不强行覆写，也不清掉日志', () => box((dir) => {
  const { id, options } = reviewed(dir)
  assert.throws(() => adoptCandidate(dir, id, { ...options, publicationFault: (e) => { if (e.phase === 'journal') throw new Error('interrupt') } }))
  writeFileSync(join(dir, 'MEMORY.md'), 'human-edited-version')
  assert.equal(recoverMemoryPublication(dir).recoverable, false)
  assert.throws(() => recoverMemoryPublication(dir, { apply: true }), /conflict/)
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), 'human-edited-version')
  assert.equal(existsSync(join(dir, '.publication.json')), true)
}))
test('恢复前阶段文件损坏，不发布任意内容', () => box((dir) => {
  const { id, options } = reviewed(dir)
  assert.throws(() => adoptCandidate(dir, id, { ...options, publicationFault: (e) => { if (e.phase === 'journal') throw new Error('interrupt') } }))
  const journal = JSON.parse(readFileSync(join(dir, '.publication.json'), 'utf8'))
  writeFileSync(join(dir, journal.files[0].stage), 'changed stage')
  assert.equal(recoverMemoryPublication(dir).recoverable, false)
  assert.equal(existsSync(join(dir, 'MEMORY.md')), false)
}))
test('未恢复的半发布索引不进入真实上下文 provider', () => box((dir) => {
  const previous = process.env.DSH_HOME; process.env.DSH_HOME = dir
  try {
    const global = join(dir, 'memory'); const { id, options } = reviewed(global)
    assert.throws(() => adoptCandidate(global, id, { ...options, publicationFault: (e) => { if (e.phase === 'file' && e.index === 0) throw new Error('interrupt') } }))
    let context
    apply({ systemPrompt: { context: (c) => context = c }, workingDirectory: { get: () => dir }, tools: { register() {} } }, { autoCapture: { enabled: false } })
    const rendered = context.text({ agent: { session: {} } })
    assert.doesNotMatch(rendered, /本项目偏好柔和低反差/)
    assert.match(rendered, /中断发布/)
  } finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous }
}))
test('真实进程被强制退出后，过期残留锁与发布日志可恢复', () => box((dir) => {
  const { id, options } = reviewed(dir)
  const worker = `import {adoptCandidate} from ${JSON.stringify(modulePath)};adoptCandidate(process.argv[1],process.argv[2],{...JSON.parse(process.argv[3]),publicationFault:(e)=>{if(e.phase==='file'&&e.index===0)process.kill(process.pid,'SIGKILL')}})`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker, dir, id, JSON.stringify(options)], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.signal, 'SIGKILL', result.stderr)
  // Simulate the documented 15-second stale-lock age, without a wall-clock sleep.
  const past = new Date(Date.now() - 20000); utimesSync(join(dir, '.write.lock'), past, past)
  assert.equal(recoverMemoryPublication(dir, { apply: true }).applied, true)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
}))
test('发布路径限制阻止写出库外', () => box((dir) => {
  assert.throws(() => commitPublication(dir, [{ name: '../outside', text: 'bad' }]), /invalid-writes/)
  assert.equal(existsSync(join(dir, '.publication.json')), false)
}))
test('发布前校验失败，不提前写索引或虚构成功历史', () => box((dir) => {
  assert.throws(() => writeMemory({ type: 'user', dir, line: indexLine('user', '新的内容不应在失败后留下记录'), detail: 'x'.repeat(512 * 1024) }), /invalid-writes/)
  assert.equal(existsSync(join(dir, 'MEMORY.md')), false)
  assert.equal(existsSync(join(dir, '.history.jsonl')), false)
  assert.equal(existsSync(join(dir, '.publication.json')), false)
}))
test('已采纳记忆被移走后，重复审批不会偷偷重建它', () => box((dir) => {
  const { id, options } = reviewed(dir); adoptCandidate(dir, id, options)
  writeFileSync(join(dir, 'MEMORY.md'), '# 用户已经修改了当前索引\n')
  assert.throws(() => adoptCandidate(dir, id, options), /effective-memory-missing/)
  assert.doesNotMatch(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /低反差/)
}))
