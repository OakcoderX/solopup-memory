#!/usr/bin/env node
/**
 * 机械指标表：只测「不需要模型」的那几行。
 *
 *   node eval/mechanical-table.mjs [--json]
 *
 * 对齐 LongMemEval 那套评估表里可以离线算的部分：
 *   上下文税、检索可见性（H@1 的近似）、重复率、冲突率、过期残留、写入闸误记。
 * 测不了的行（捕获召回、五种能力、编造率）在表里标 N/A 并写明原因——
 * 空着比编一个数诚实。
 */

import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  apply,
  checkIndexBudget,
  pruneStore,
  indexLine,
  searchStore,
  similarity,
  statusOf,
  storeDirFor,
  writeMemory,
  forgetMemory,
} from '../index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIMIT_BYTES = 25 * 1024
const INSTRUCTION_BUDGET = 64 * 1024

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mech-'))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    cwd,
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function mount(cwd) {
  const captured = { cwd, tools: [] }
  apply({
    systemPrompt: { context: (e) => (captured.context = e) },
    workingDirectory: { get: () => captured.cwd },
    tools: { register: (definition) => captured.tools.push(definition) },
    on() {},
  })
  return captured
}

const render = (captured) => captured.context.text({ agent: { session: {} } })

// ── 1. 上下文税 ────────────────────────────────────────────────────────────
function contextTax() {
  const rows = []
  for (const size of [10, 50, 150, 200, 300, 500]) {
    const box = sandbox()
    try {
      const dir = storeDirFor('global', box.cwd)
      mkdirSync(dir, { recursive: true })
      const lines = []
      for (let i = 0; i < size - 1; i += 1) lines.push(`- [user] 条目 ${i} 的一句话摘要 — user.md`)
      lines.splice(Math.floor(lines.length / 2), 0, '- [reference] 目标条目 TARGET — reference.md')
      writeFileSync(join(dir, 'MEMORY.md'), `# 索引\n\n## user\n\n${lines.join('\n')}\n`, 'utf8')
      const text = render(mount(box.cwd))
      const bytes = Buffer.byteLength(text, 'utf8')
      rows.push({
        size,
        bytes,
        pctOfIndexCap: Number(((bytes / LIMIT_BYTES) * 100).toFixed(1)),
        pctOfInstructionBudget: Number(((bytes / INSTRUCTION_BUDGET) * 100).toFixed(1)),
      })
    } finally {
      box.cleanup()
    }
  }
  return rows
}

// ── 2. 位置可见性（H@1 的机械近似）────────────────────────────────────────
function positionVisibility() {
  const size = 300
  const positions = [1, 50, 100, 150, 200, 201, 250, 300]
  const results = []
  for (const position of positions) {
    const box = sandbox()
    try {
      const dir = storeDirFor('global', box.cwd)
      mkdirSync(dir, { recursive: true })
      const lines = []
      for (let i = 0; i < size; i += 1) {
        lines.push(i + 1 === position ? '- [reference] 目标条目 TARGET — reference.md' : `- [user] 条目 ${i} — user.md`)
      }
      writeFileSync(join(dir, 'MEMORY.md'), `# 索引\n\n## user\n\n${lines.join('\n')}\n`, 'utf8')
      const text = render(mount(box.cwd))
      results.push({ position, visible: text.includes('TARGET') })
    } finally {
      box.cleanup()
    }
  }
  return results
}

// ── 3. 重复率：按相似度分档看闸门行为 ──────────────────────────────────────
function duplicateByBand() {
  const base = 'E01 全链路已跑完，下一步 S3 场景卡'
  const candidates = [
    { label: '完全相同', text: base },
    { label: '仅差句号', text: `${base}。` },
    { label: '改一个词', text: 'E01 全链路已跑完，接下来 S3 场景卡' },
    { label: '换说法', text: '第一步先把场景卡做完再进稿子' },
  ]
  const rows = []
  for (const candidate of candidates) {
    const box = sandbox()
    try {
      const dir = storeDirFor('global', box.cwd)
      writeMemory({ type: 'project', dir, line: indexLine('project', base) })
      let outcome
      try {
        const r = writeMemory({ type: 'project', dir, line: indexLine('project', candidate.text) })
        outcome = r.duplicate ? 'duplicate（幂等，不入库）' : r.warning ? 'warning（入库但提示）' : 'accepted（当作新条目）'
      } catch (error) {
        outcome = /相似/.test(error.message) ? 'rejected（相似度闸）' : `error:${error.message.slice(0, 20)}`
      }
      rows.push({
        label: candidate.label,
        similarity: Number(similarity(base, candidate.text).toFixed(3)),
        outcome,
      })
    } finally {
      box.cleanup()
    }
  }
  return rows
}

// ── 4. 冲突率：同一事实两个值 ──────────────────────────────────────────────
function conflictRate() {
  const cases = [
    ['集数', '剧本定为 26 集', '剧本定为 24 集'],
    ['场次', 'E01 是 16 场', 'E01 是 12 场'],
    ['模型', '写手用 deepseek-flash', '写手用 gemini-4-argon'],
  ]
  const rows = []
  for (const [name, a, b] of cases) {
    const box = sandbox()
    try {
      const dir = storeDirFor('global', box.cwd)
      writeMemory({ type: 'project', dir, line: indexLine('project', a) })
      let outcome
      try {
        const r = writeMemory({ type: 'project', dir, line: indexLine('project', b) })
        outcome = r.duplicate ? 'duplicate' : /冲突/.test(r.warning ?? '') ? '⚠ 冲突警告' : r.warning ? 'warning' : 'accepted（未察觉）'
      } catch (error) {
        outcome = /相似/.test(error.message) ? 'rejected（疑似同一条）' : 'error'
      }
      const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8')
      rows.push({
        name,
        similarity: Number(similarity(a, b).toFixed(3)),
        outcome,
        bothPresent: index.includes(a) && index.includes(b),
      })
    } finally {
      box.cleanup()
    }
  }
  return rows
}

// ── 5. 过期与取代的残留 ────────────────────────────────────────────────────
function staleResidual() {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    // 取代：旧值应完全消失
    writeMemory({ type: 'project', dir, line: indexLine('project', '剧本定为 26 集') })
    writeMemory({ type: 'project', dir, line: indexLine('project', '剧本定为 24 集'), supersedes: '26 集' })
    const afterSupersede = render(mount(box.cwd))

    // 过期：到期条目不应出现
    const yesterday = new Date(Date.now() - 2 * 86400000)
    const stamp = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
    writeMemory({ type: 'project', dir, line: indexLine('project', '限期条目 EXPIRE-ME', stamp) })
    const afterExpiry = render(mount(box.cwd))

    // 删除：删掉的不能残留
    const forgetTarget = indexLine('project', '临时条目 DELETE-ME')
    writeMemory({ type: 'project', dir, line: forgetTarget })
    forgetMemory(dir, 'DELETE-ME')
    const afterForget = render(mount(box.cwd))

    return {
      supersedeOldGone: !afterSupersede.includes('26 集'),
      supersedeNewPresent: afterSupersede.includes('24 集'),
      expiredHidden: !afterExpiry.includes('EXPIRE-ME'),
      expiryNotice: afterExpiry.includes('已隐藏'),
      deletedGone: !afterForget.includes('DELETE-ME'),
    }
  } finally {
    box.cleanup()
  }
}

// ── 6. 写入闸的误记率（闸门行为，不是模型的判断）───────────────────────────
async function gateRejections() {
  // 走真实工具入口：参数校验在 resolveTarget 里，直接调 writeMemory 会绕过它
  const box = sandbox()
  try {
    const captured = mount(box.cwd)
    const tool = captured.tools.find((item) => item.name === 'memory_write')
    const exec = { agent: { session: { id: 'mech' }, options: { model: 'mech' } } }
    const traps = [
      ['凭据（sk-…）', { type: 'user', summary: `sk-${'a'.repeat(32)}`, scope: 'global' }],
      ['超长摘要（260 字）', { type: 'user', summary: 'x'.repeat(260), scope: 'global' }],
      ['空摘要', { type: 'user', summary: '   ', scope: 'global' }],
      ['非法 type', { type: 'nope', summary: 'x', scope: 'global' }],
    ]
    const results = []
    for (const [name, args] of traps) {
      try {
        await tool.execute(args, exec)
        results.push({ name, caught: false })
      } catch {
        results.push({ name, caught: true })
      }
    }
    return results
  } finally {
    box.cleanup()
  }
}

// ── 7. 写入死路率（U1）────────────────────────────────────────────────────
function deadEnds() {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 400; i += 1) lines.push(`- [project] 占位${String.fromCharCode(97 + (i % 26))}${i} — project.md`)
    writeFileSync(join(dir, 'MEMORY.md'), `${lines.join('\n')}\n`, 'utf8')

    let rejected = 0
    let recovered = 0
    try {
      writeMemory({ type: 'project', dir, line: indexLine('project', '满库时的新条目') })
    } catch (error) {
      rejected += 1
      // 报错里必须给出可执行的下一步
      const actionable = /memory_prune/.test(error.message)
      if (actionable) {
        pruneStore(dir, { apply: true })
        try {
          writeMemory({ type: 'project', dir, line: indexLine('project', '满库时的新条目') })
          recovered = 1
        } catch {
          recovered = 0
        }
      }
    }
    return { rejected, recovered }
  } finally {
    box.cleanup()
  }
}

// ── 8. 截断召回率（U2）────────────────────────────────────────────────────
function truncationRecall() {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 400; i += 1) {
      lines.push(i === 5 ? '- [project] 被截断的稀有事实 ZEBRA — project.md' : `- [project] 条目${i} — project.md`)
    }
    writeFileSync(join(dir, 'MEMORY.md'), `${lines.join('\n')}\n`, 'utf8')

    const injected = render(mount(box.cwd))
    const visibleInContext = injected.includes('ZEBRA')
    const found = searchStore(dir, 'ZEBRA').hits.length
    return { visibleInContext, foundBySearch: found }
  } finally {
    box.cleanup()
  }
}

// ── 9. 压缩效果（U3）───────────────────────────────────────────────────────
function compactionEffect() {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    const lines = ['# 索引', '', '## project', '']
    for (let i = 0; i < 340; i += 1) {
      const suffix = i < 40 ? ' (exp:2020-01-01)' : ''
      lines.push(`- [project] 占位${String.fromCharCode(97 + (i % 26))}${i} — project.md${suffix}`)
    }
    lines.push('- [project] 剧本定为26集 — project.md')
    writeFileSync(join(dir, 'MEMORY.md'), `${lines.join('\n')}\n`, 'utf8')

    const before = statusOf(dir)
    const plan = pruneStore(dir, { apply: true })
    const after = statusOf(dir)
    return {
      beforeLines: before.index.lines,
      afterLines: after.index.lines,
      expired: plan.removed.expired,
      overCap: plan.removed.overCap,
      underLimit: after.index.lines <= 300,
    }
  } finally {
    box.cleanup()
  }
}

const report = {
  at: new Date().toISOString(),
  contextTax: contextTax(),
  positionVisibility: positionVisibility(),
  duplicateByBand: duplicateByBand(),
  conflictRate: conflictRate(),
  staleResidual: staleResidual(),
  gateRejections: await gateRejections(),
  deadEnds: deadEnds(),
  truncationRecall: truncationRecall(),
  compactionEffect: compactionEffect(),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

// 门禁：只卡可用性三条（U1/U2/U3），不卡"数字好不好看"
if (process.argv.includes('--check')) {
  const checks = []
  const deadEndFree = report.deadEnds.rejected === 0 || report.deadEnds.recovered === 1
  checks.push(['U1 满库压缩后恢复可写', deadEndFree])
  checks.push(['U2 截断条目可检索', report.truncationRecall.foundBySearch > 0])
  checks.push(['U3 压缩后不超上限', report.compactionEffect.underLimit])
  let failed = 0
  for (const [label, ok] of checks) {
    if (!ok) failed += 1
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

const lines = []
lines.push(`# 机械指标表（对照评估表里可离线算的行）`)
lines.push('')
lines.push(`生成时间：${report.at}`)
lines.push('')
lines.push('## 1. 上下文税')
lines.push('')
lines.push('| 库规模 | 注入字节 | 占索引上限 25 KB | 占 DSH 指令预算 64 KiB |')
lines.push('|---|---|---|---|')
for (const row of report.contextTax) {
  lines.push(`| ${row.size} 条 | ${row.bytes} B | ${row.pctOfIndexCap}% | ${row.pctOfInstructionBudget}% |`)
}
lines.push('')
lines.push('## 2. 位置可见性（H@1 的机械近似：目标是否出现在注入里）')
lines.push('')
lines.push('| 目标位置（共 300 条） | 出现在注入里 |')
lines.push('|---|---|')
for (const row of report.positionVisibility) {
  lines.push(`| 第 ${row.position} 条 | ${row.visible ? '是' : '否'} |`)
}
lines.push('')
lines.push('## 3. 重复率（按相似度分档看闸门行为）')
lines.push('')
lines.push('| 情形 | 相似度 | 结果 |')
lines.push('|---|---|---|')
for (const row of report.duplicateByBand) lines.push(`| ${row.label} | ${row.similarity} | ${row.outcome} |`)
lines.push('')
lines.push('## 4. 冲突率（同一事实两个值）')
lines.push('')
lines.push('| 事实 | 相似度 | 结果 | 两条都入库 |')
lines.push('|---|---|---|---|')
for (const row of report.conflictRate) {
  lines.push(`| ${row.name} | ${row.similarity} | ${row.outcome} | ${row.bothPresent ? '是' : '否'} |`)
}
lines.push('')
lines.push('## 5. 过期与取代的残留')
lines.push('')
const residual = report.staleResidual
lines.push(`| 检查 | 结果 |`)
lines.push('|---|---|')
lines.push(`| 取代后旧值消失 | ${residual.supersedeOldGone ? '是' : '否'} |`)
lines.push(`| 取代后新值在场 | ${residual.supersedeNewPresent ? '是' : '否'} |`)
lines.push(`| 过期条目被隐藏 | ${residual.expiredHidden ? '是' : '否'} |`)
lines.push(`| 过期有提示 | ${residual.expiryNotice ? '是' : '否'} |`)
lines.push(`| 删除后无残留 | ${residual.deletedGone ? '是' : '否'} |`)
lines.push('')
lines.push('## 6. 写入闸（这是闸门行为，不是模型判断）')
lines.push('')
lines.push('| 陷阱 | 是否被拦 |')
lines.push('|---|---|')
for (const row of report.gateRejections) lines.push(`| ${row.name} | ${row.caught ? '是' : '否'} |`)
lines.push('')
lines.push('## 7. 可用性（U1–U3）')
lines.push('')
lines.push('| 指标 | 实测 | 验收线 |')
lines.push('|---|---|---|')
lines.push(`| 写入死路率 | ${report.deadEnds.rejected === 0 ? 0 : ((report.deadEnds.rejected - report.deadEnds.recovered) / report.deadEnds.rejected) * 100}% | 0% |`)
lines.push(`| 满库一次压缩后恢复可写 | ${report.deadEnds.recovered === 1 ? '是' : '否'} | 是 |`)
lines.push(`| 截断条目可检索 | ${report.truncationRecall.foundBySearch > 0 ? '是' : '否'}（注入中${report.truncationRecall.visibleInContext ? '可见' : '不可见'}） | 是 |`)
lines.push(`| 压缩后索引行数 | ${report.compactionEffect.beforeLines} → ${report.compactionEffect.afterLines} | ≤300 |`)
lines.push('')
lines.push('## 8. 这张表覆盖不到的行（需要活体 agent）')
lines.push('')
lines.push('| 评估表的行 | 为什么测不了 |')
lines.push('|---|---|')
lines.push('| 捕获召回率 | 要模型自己决定「什么值得记」，插件只提供写入闸 |')
lines.push('| 五种能力（提取/跨会话/时间/更新/拒答） | 每题都要新会话里由模型作答 |')
lines.push('| 编造率 / 错误自信率 | 同上，且判分需要盲评 |')
lines.push('| 检索首次命中率（真正意义上的） | 需要数「第几次工具调用命中」，不是「是否在注入里」 |')
lines.push('| 净收益（时间） | 需要真实任务计时 |')

// ── 结论：从数据里算出来，不手写数字 ──
const visiblePositions = report.positionVisibility.filter((row) => row.visible).map((row) => row.position)
const maxVisible = visiblePositions.length > 0 ? Math.max(...visiblePositions) : 0
const hiddenPositions = report.positionVisibility.filter((row) => !row.visible).map((row) => row.position)
const conflictLeaked = report.conflictRate.filter((row) => row.bothPresent).length
const paraphrase = report.duplicateByBand.find((row) => row.label === '改一个词')
const verbatim = report.duplicateByBand.find((row) => row.label === '完全相同')

lines.push('## 9. 这张表暴露的问题')
lines.push('')
// 方向从数据里判断，不写死：隐藏位置全在可见位置之前 = 保最新；之后 = 保最旧
const direction =
  hiddenPositions.length === 0
    ? '没有条目被丢弃'
    : Math.max(...hiddenPositions) < Math.min(...visiblePositions)
      ? '丢弃的是**最早的**（保最新）'
      : Math.min(...hiddenPositions) > Math.max(...visiblePositions)
        ? '丢弃的是**最新的**（保最旧）'
        : '丢弃的是**中间段**'
lines.push(`1. **有效容量 ${maxVisible} 条**（第 ${hiddenPositions.join('、')} 条不可见）。丢弃方向：${direction}。`)
const warned = report.conflictRate.filter((row) => /冲突/.test(row.outcome)).length
lines.push(
  `2. **冲突会被提示，但不会被拦。** ${report.conflictRate.length} 组「同一事实两个值」里 ${warned} 组给出了警告，` +
    `${conflictLeaked} 组两条都入库。这是刻意的：文本规则分不清「改口」和「枚举」，拦截会误伤后者，` +
    `所以把判断交给看到上下文的人。`,
)
lines.push(`3. **同义改写会被当成新条目。** 逐字重复能挡住（${verbatim.outcome}），但相似度 ${paraphrase.similarity} 的改写直接入库——索引会被同一件事的多种说法慢慢稀释。`)
lines.push('')
lines.push('这三条都不是"安全漏洞"，是**质量上限**：机械指标能测出来，说明它们可修；')
lines.push('修之前，任何基于这张表的横向比较都会把这三个缺陷一起带进去。')
lines.push('')

const markdown = `${lines.join('\n')}\n`
writeFileSync(join(HERE, 'mechanical-table.md'), markdown, 'utf8')
console.log(markdown)
