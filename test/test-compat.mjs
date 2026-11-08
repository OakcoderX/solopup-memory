import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from '../fixture-host.mjs'
/**
 * 宿主 API 兼容与降级。跑法：node --test ~/.dsh/plugins/memory/test/test-compat.mjs
 *
 * 目的：宿主升级后能区分「插件坏了」和「宿主变了」。
 * 没有 systemPrompt.context 就没法注入 → 立刻抛错（响）；
 * 缺 workingDirectory 或 tools → 降级但要继续工作（不静默失效）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {  selfCheck, storeDirFor } from '../index.mjs'

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-compat-')))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    cwd,
    store: join(home, 'memory'),
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function fullCtx(cwd, captured) {
  return {
    systemPrompt: { context: (entry) => (captured.context = entry) },
    workingDirectory: { get: () => cwd },
    tools: { register: (definition) => captured.tools.push(definition) },
    on() {},
  }
}

test('完整宿主：自检无问题', () => {
  const captured = { tools: [] }
  const health = selfCheck(fullCtx('/tmp', captured))
  assert.deepEqual(health.fatal, [])
  assert.deepEqual(health.degrade, [])
})

test('缺 workingDirectory：降级为只注入全局库，仍然可用', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '- [user] 全局条目 — user.md\n', 'utf8')

    const captured = { tools: [] }
    const ctx = fullCtx(box.cwd, captured)
    delete ctx.workingDirectory
    apply(ctx)

    const text = captured.context.text({ agent: { session: {} } })
    assert.match(text, /全局条目/)
    assert.match(text, /global（跨项目）/)
    assert.doesNotMatch(text, /project（当前项目）/, '没有 cwd 就不该注入项目库')
  } finally {
    box.cleanup()
  }
})

test('缺 tools：不注册工具，但注入照常', () => {
  const box = sandbox()
  try {
    const dir = storeDirFor('global', box.cwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), '- [user] 仍然可读 — user.md\n', 'utf8')

    const captured = { tools: [] }
    const ctx = fullCtx(box.cwd, captured)
    delete ctx.tools
    apply(ctx)

    assert.equal(captured.tools.length, 0)
    assert.match(captured.context.text({ agent: { session: {} } }), /仍然可读/)
  } finally {
    box.cleanup()
  }
})

test('缺 systemPrompt.context：抛出可读错误，而不是静默不动', () => {
  const captured = { tools: [] }
  const ctx = fullCtx('/tmp', captured)
  ctx.systemPrompt = {}
  assert.throws(() => apply(ctx), /宿主 API 不匹配/)
  assert.throws(() => apply(ctx), /COMPATIBILITY\.md/)
})

test('selfCheck 把缺 systemPrompt 归为 fatal，其余归为 degrade', () => {
  assert.deepEqual(selfCheck({}).fatal, ['systemPrompt.context 不是函数'])
  assert.equal(selfCheck({ systemPrompt: { context() {} } }).degrade.length, 2)
})

test('缺 workingDirectory 时，工具给出可读错误而不是 TypeError', async () => {
  const box = sandbox()
  try {
    const captured = { tools: [] }
    const ctx = fullCtx(box.cwd, captured)
    delete ctx.workingDirectory
    apply(ctx)

    const write = captured.tools.find((item) => item.name === 'memory_write')
    await assert.rejects(
      () => write.execute({ type: 'user', summary: 'x', scope: 'project' }, { agent: { session: {} } }),
      /未提供 workingDirectory/,
    )
    // global 仍然可用
    const ok = await write.execute({ type: 'user', summary: '全局可用', scope: 'global' }, { agent: { session: {} } })
    assert.match(ok.indexLine, /全局可用/)
  } finally {
    box.cleanup()
  }
})
