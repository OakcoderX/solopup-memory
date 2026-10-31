import {realpathSync} from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageCandidate, listCandidates, pruneCandidates, withdrawSource } from './candidates.mjs'
import { adoptCandidate, withdrawManagedSource, recoverMemoryPublication, writeMemory, storeRevision, indexLine, searchStore, lookupLinks, statusOf, forgetMemory, apply } from './index.mjs'

function box(run) { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-withdrawal-'))); try { return run(dir) } finally { rmSync(dir, { recursive: true, force: true }) } }
function adopted(dir, detail = '唯一细节：只用于室内对白镜头。', source = 'source-1') {
  const payload = { type: 'user', scope: 'project', summary: '唯一判断：柔和低反差光线', detail, sessionId: source,
    indexRevision: storeRevision(dir), evidence: [{ messageId: 'message-1', hash: 'b'.repeat(64), quote: '这个项目的夜戏采用低反差光线' }] }
  const item = stageCandidate(dir, payload)
  const view = adoptCandidate(dir, item.id)
  const result = adoptCandidate(dir, item.id, { apply: true, reviewedIndex: view.reviewedIndex, candidateRevision: view.candidateRevision })
  return { payload, id: item.id, memoryId: result.memoryId }
}
function withdrawalOptions(dir, source = 'source-1') {
  const preview = withdrawManagedSource(dir, source, 'message-1')
  return { apply: true, reviewedIndex: preview.reviewedIndex, candidateRevision: preview.candidateRevision }
}

test('来源撤回默认预览，不改候选、主题或索引', () => box((dir) => {
  adopted(dir)
  const before = new Map(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]))
  const view = withdrawManagedSource(dir, 'source-1', 'message-1')
  assert.equal(view.effectiveRemoved, 1)
  assert.equal(view.applied, false)
  for (const [name, raw] of before) assert.equal(readFileSync(join(dir, name), 'utf8'), raw)
}))
test('撤回清除受管索引、标记细节、候选原文与审计历史正文，保留无关内容', () => box((dir) => {
  const item = adopted(dir)
  writeMemory({ type: 'project', dir, line: indexLine('project', '其他有效决定保持使用横屏构图'), detail: '另一项细节保持有效。' })
  const result = withdrawManagedSource(dir, 'source-1', 'message-1', withdrawalOptions(dir))
  assert.equal(result.effectiveRemoved, 1)
  for (const name of ['MEMORY.md', 'user.md', '.candidates.json', '.audit.jsonl', '.history.jsonl']) {
    const raw = readFileSync(join(dir, name), 'utf8')
    assert.ok(!raw.includes(item.payload.summary), name)
    assert.ok(!raw.includes(item.payload.detail), name)
    assert.ok(!raw.includes(item.payload.evidence[0].quote), name)
  }
  assert.match(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /其他有效决定/)
  assert.equal(listCandidates(dir, { status: 'withdrawn' }).total, 1)
  assert.equal(lookupLinks(dir, { id: item.memoryId }).found, false)
}))
test('撤回后恢复旧索引、主题和历史，检索/关系/注入仍隐藏撤回内容', () => box((dir) => {
  const item = adopted(dir)
  const copies = ['MEMORY.md', 'user.md', '.history.jsonl', '.audit.jsonl'].map((name) => [name, readFileSync(join(dir, name), 'utf8')])
  withdrawManagedSource(dir, 'source-1', 'message-1', withdrawalOptions(dir))
  pruneCandidates(dir, { apply: true })
  for (const [name, raw] of copies) writeFileSync(join(dir, name), raw)
  assert.equal(searchStore(dir, '低反差').hits.length, 0)
  assert.equal(searchStore(dir, '唯一细节').hits.length, 0)
  assert.equal(searchStore(dir, '低反差', { mode: 'ranked' }).hits.length, 0)
  assert.equal(lookupLinks(dir, { id: item.memoryId }).found, false)
  assert.doesNotMatch(JSON.stringify(statusOf(dir).recent), /唯一判断|唯一细节|低反差/)
  const oldHome = process.env.DSH_HOME
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-withdraw-provider-')))
  try {
    cpSync(dir, join(home, 'memory'), { recursive: true })
    process.env.DSH_HOME = home
    let context
    apply({ systemPrompt: { context: (c) => context = c }, workingDirectory: { get: () => dir }, tools: { register() {} } }, { autoCapture: { enabled: false } })
    const rendered = context.text({ agent: { session: {} } })
    assert.match(rendered, /memory-store/)
    assert.doesNotMatch(rendered, /唯一判断|唯一细节/)
  } finally { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; rmSync(home, { recursive: true, force: true }) }
}))
test('后续写入不会把恢复旧文件中的撤回条目重新复制为新记忆或关系', () => box((dir) => {
  adopted(dir)
  const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8'), topic = readFileSync(join(dir, 'user.md'), 'utf8')
  withdrawManagedSource(dir, 'source-1', 'message-1', withdrawalOptions(dir))
  writeFileSync(join(dir, 'MEMORY.md'), index)
  writeFileSync(join(dir, 'user.md'), topic)
  const fresh = writeMemory({ type: 'user', dir, line: indexLine('user', '另一个来源的新独立约定'), detail: '新的主题细节保留' })
  assert.doesNotMatch(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), /唯一判断/)
  assert.doesNotMatch(readFileSync(join(dir, 'user.md'), 'utf8'), /唯一细节/)
  assert.doesNotMatch(JSON.stringify(lookupLinks(dir, { id: fresh.id })), /唯一判断|唯一细节/)
}))
test('撤回对包含伪日期条目的多行细节也完全生效', () => box((dir) => {
  adopted(dir, '唯一细节第一段\n- 2026-10-29｜唯一细节第二段不能泄漏')
  const topic = readFileSync(join(dir, 'user.md'), 'utf8')
  withdrawManagedSource(dir, 'source-1', 'message-1', withdrawalOptions(dir))
  writeFileSync(join(dir, 'user.md'), topic)
  assert.equal(searchStore(dir, '唯一细节').hits.length, 0)
}))
test('伪造已撤回候选的标记，不得让无关正文被当成权威撤回块', () => box((dir) => {
  const item = adopted(dir)
  withdrawManagedSource(dir, 'source-1', 'message-1', withdrawalOptions(dir))
  writeFileSync(join(dir, 'user.md'), `# user\n\n- 2026-10-29｜[candidate:${item.id}]\n无关正文必须保持可检索\n`)
  assert.equal(searchStore(dir, '无关正文').hits.length, 1)
}))
test('同根晚到写入被拒绝；新根经显式审核可重新确认同一判断', () => box((dir) => {
  const item = adopted(dir)
  withdrawManagedSource(dir, 'source-1', 'message-1', withdrawalOptions(dir))
  assert.throws(() => writeMemory({ type: 'user', dir, line: indexLine('user', '旧来源换个措辞重新写入'), provenance: { sessionId: 'source-1', evidence: item.payload.evidence } }), /source-withdrawn/)
  assert.equal(stageCandidate(dir, { ...item.payload, summary: '旧根再次改写也不应进入候选' }).status, 'withdrawn')
  assert.throws(() => writeMemory({ type: 'user', dir, line: indexLine('user', item.payload.summary) }), /withdrawn-content/)
  const fresh = adopted(dir, item.payload.detail, 'fresh-owner-message')
  assert.equal(searchStore(dir, item.payload.summary).hits.length, 1)
  assert.equal(listCandidates(dir, { status: 'adopted' }).records[0].id, fresh.id)
}))
test('轮转的超过512KiB日志也清除来源原文', () => box((dir) => {
  const item = adopted(dir)
  const filler = (JSON.stringify({ op: 'unrelated', note: 'x'.repeat(100) }) + '\n').repeat(5000)
  for (const name of ['.audit.jsonl', '.history.jsonl']) writeFileSync(join(dir, name + '.1'), filler + readFileSync(join(dir, name), 'utf8'))
  withdrawManagedSource(dir, 'source-1', 'message-1', withdrawalOptions(dir))
  for (const name of ['.audit.jsonl.1', '.history.jsonl.1']) assert.ok(!readFileSync(join(dir, name), 'utf8').includes(item.payload.summary))
}))
test('旧版无标记细节不能假装被追踪并静默清除', () => box((dir) => {
  adopted(dir)
  writeFileSync(join(dir, 'user.md'), '# user\n\n- 2026-10-29｜唯一细节：只用于室内对白镜头。\n')
  assert.throws(() => withdrawManagedSource(dir, 'source-1', 'message-1'), /untracked-detail/)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
}))
test('同一有效文本还有独立采纳来源时，不静默删除它', () => box((dir) => {
  adopted(dir)
  forgetMemory(dir, '唯一判断')
  adopted(dir, '另一个独立来源的细节', 'independent-source')
  assert.throws(() => withdrawManagedSource(dir, 'source-1', 'message-1'), /shared-effective-memory/)
  assert.equal(searchStore(dir, '唯一判断').hits.length, 1)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 2)
}))
test('旧自动捕获有审计来源且仅有摘要时可以撤回，无来源细节则拒绝', () => box((dir) => {
  const evidence = [{ messageId: 'message-1', hash: 'b'.repeat(64), quote: '这句用户原话用于核对来源' }]
  writeMemory({ type: 'project', dir, line: indexLine('project', '旧自动捕获的唯一摘要'), provenance: { sessionId: 'source-1', evidence, via: 'auto-capture' } })
  withdrawManagedSource(dir, 'source-1', 'message-1', withdrawalOptions(dir))
  assert.equal(searchStore(dir, '唯一摘要').hits.length, 0)
}))
test('已经只撤回候选入口的来源，仍可继续清理有效摘要', () => box((dir) => {
  const evidence = [{ messageId: 'message-1', hash: 'b'.repeat(64), quote: '这条来源同时产生摘要与候选' }]
  writeMemory({ type: 'project', dir, line: indexLine('project', '这个旧摘要也必须被有效撤回'), provenance: { sessionId: 'source-1', evidence } })
  withdrawSource(dir, 'source-1', 'message-1')
  const options = withdrawalOptions(dir)
  assert.equal(withdrawManagedSource(dir, 'source-1', 'message-1', options).effectiveRemoved, 1)
  assert.equal(searchStore(dir, '旧摘要').hits.length, 0)
}))
test('无法追踪旧自动捕获的主题细节时拒绝，不把部分清理当完成', () => box((dir) => {
  const evidence = [{ messageId: 'message-1', hash: 'b'.repeat(64), quote: '这条旧来源没有受管细节标记' }]
  writeMemory({ type: 'project', dir, line: indexLine('project', '旧捕获包含未标记细节'), detail: '不能凭猜测删除的原始细节', provenance: { sessionId: 'source-1', evidence } })
  assert.throws(() => withdrawManagedSource(dir, 'source-1', 'message-1'), /untracked-detail/)
  assert.equal(searchStore(dir, '未标记细节').hits.length, 1)
}))
test('旧写入只有会话但没有消息来源时，不声称已清完该来源', () => box((dir) => {
  writeMemory({ type: 'project', dir, line: indexLine('project', '缺少原消息定位的历史决定'), provenance: { sessionId: 'source-1', via: 'auto-capture' } })
  assert.throws(() => withdrawManagedSource(dir, 'source-1', 'message-1'), /missing-source-lineage/)
  assert.equal(searchStore(dir, '历史决定').hits.length, 1)
}))
for (const at of ['journal', 0, 1, 2, 3, 4]) test(`撤回在 ${at} 中断后可恢复且不能读取半撤回内容`, () => box((dir) => {
  adopted(dir)
  const options = withdrawalOptions(dir)
  assert.throws(() => withdrawManagedSource(dir, 'source-1', 'message-1', { ...options, publicationFault: (e) => { if (e.phase === at || e.phase === 'file' && e.index === at) throw new Error('interrupted') } }), /interrupted/)
  assert.throws(() => searchStore(dir, '低反差'), /needs-recovery/)
  recoverMemoryPublication(dir, { apply: true })
  assert.equal(searchStore(dir, '低反差').hits.length, 0)
  assert.equal(withdrawManagedSource(dir, 'source-1', 'message-1', options).duplicate, true)
}))
test('外部修改、坏日志或过期预览均不被强行覆盖', () => box((dir) => {
  adopted(dir)
  const options = withdrawalOptions(dir)
  writeMemory({ type: 'project', dir, line: indexLine('project', '刚刚新增的一项独立决定') })
  assert.throws(() => withdrawManagedSource(dir, 'source-1', 'message-1', options), /stale-index/)
  writeFileSync(join(dir, '.audit.jsonl'), 'invalid JSON')
  assert.throws(() => withdrawManagedSource(dir, 'source-1', 'message-1'), /corrupt-log/)
  assert.equal(listCandidates(dir, { status: 'adopted' }).total, 1)
}))
