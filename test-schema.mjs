import {realpathSync} from 'node:fs'
import {applyWithOwnerFixture as apply} from './fixture-host.mjs'
/**
 * 工具 schema 的静态校验。跑法：node --test ~/.dsh/plugins/memory/test-schema.mjs
 *
 * 为什么需要它：宿主在**注册时**校验 output schema，不合格会让整个插件加载失败；
 * 而单元测试直接调 tool.execute()，完全绕过那道校验。
 * 2026-10-28 就是这样：`additionalProperties: {type:'integer'}` 让插件静默不加载，
 * 272 个测试却全绿。这个文件把宿主的三条硬规则搬进测试。
 *
 * 规则（来自宿主 JsonSchemaError 的实际报错）：
 *   1. additionalProperties 必须是布尔值，不能是 schema 对象
 *   2. 每个 schema 节点必须有 type（或 oneOf/anyOf）
 *   3. required 里的字段必须在 properties 里
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function tools() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-mem-schema-')))
  const home = join(root, 'home')
  const cwd = join(root, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const captured = { tools: [] }
  apply({
    systemPrompt: { context() {} },
    workingDirectory: { get: () => cwd },
    tools: { register: (definition) => captured.tools.push(definition) },
    on() {},
  })
  return {
    list: captured.tools,
    cleanup() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function walk(node, path, problems) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, `${path}[${i}]`, problems))
    return
  }
  // Installed DSH output-schema contract rejects unsupported constraint
  // keywords instead of merely ignoring them. Keep value bounds in validators.
  const supported=new Set(['type','oneOf','anyOf','properties','required','additionalProperties','items','enum','const','description','title','default','examples'])
  for(const key of Object.keys(node))if(!supported.has(key))problems.push(`${path}.${key} 不是已核对的宿主schema关键字`)
  if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
    problems.push(`${path}.additionalProperties 必须是布尔值`)
  }
  if ('type' in node) {
    if (node.type === 'object' && node.properties !== undefined) {
      for (const key of node.required ?? []) {
        if (node.properties[key] === undefined) problems.push(`${path}.required 里的 ${key} 不在 properties`)
      }
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') {
      for (const [prop, schema] of Object.entries(value)) walk(schema, `${path}.properties.${prop}`, problems)
    } else if (['oneOf','anyOf','items'].includes(key)) {
      walk(value, `${path}.${key}`, problems)
    }
  }
}

test('所有工具的 parameters 与 output.schema 都过宿主的 schema 规则', () => {
  const { list, cleanup } = tools()
  try {
    assert.equal(list.length, 6)
    for (const tool of list) {
      const problems = []
      walk(tool.parameters, `${tool.name}.parameters`, problems)
      walk(tool.output.schema, `${tool.name}.output`, problems)
      assert.deepEqual(problems, [], `${tool.name}:\n${problems.join('\n')}`)
    }
  } finally {
    cleanup()
  }
})

test('每个工具都有 name / description / execute / render', () => {
  const { list, cleanup } = tools()
  try {
    for (const tool of list) {
      assert.equal(typeof tool.name, 'string')
      assert.ok(tool.description.length > 0)
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
      assert.equal(typeof tool.output.schema, 'object')
    }
  } finally {
    cleanup()
  }
})

function lossless(value) {
  assert.deepEqual(value, JSON.parse(JSON.stringify(value)), '工具结果必须原样往返 JSON，不能携带 undefined')
}

test('原生工具输出：首次写入省略未填写的可选字段', async () => {
  const box = tools()
  try {
    const value = await box.list.find(t => t.name === 'memory_write').execute({type:'user',scope:'global',summary:'固定使用紫罗兰色的画板'}, {})
    lossless(value)
    assert.equal(Object.hasOwn(value, 'detailPath'), false)
    assert.equal(Object.hasOwn(value, 'superseded'), false)
    assert.equal(value.duplicate, false)
  } finally { box.cleanup() }
})

test('原生工具输出：重复写入仍是有效 JSON 且不重复落盘', async () => {
  const box = tools()
  try {
    const tool = box.list.find(t => t.name === 'memory_write')
    const args = {type:'user',scope:'global',summary:'固定使用紫罗兰色的画板'}
    await tool.execute(args, {})
    const value = await tool.execute(args, {})
    lossless(value)
    assert.equal(value.duplicate, true)
    const status = await box.list.find(t => t.name === 'memory_status').execute({scope:'global'}, {})
    assert.equal(status.index.lines, 1)
  } finally { box.cleanup() }
})

test('原生工具输出：填写细节时保留有效 detailPath', async () => {
  const box = tools()
  try {
    const value = await box.list.find(t => t.name === 'memory_write').execute({type:'user',scope:'global',summary:'固定使用紫罗兰色的画板',detail:'用于后续绘画项目的稳定偏好。'}, {})
    lossless(value)
    assert.equal(typeof value.detailPath, 'string')
    assert.equal(Object.hasOwn(value, 'superseded'), false)
  } finally { box.cleanup() }
})

test('原生工具输出：取代与双向版本查询保留关系并可往返 JSON', async () => {
  const box = tools()
  try {
    const write = box.list.find(t => t.name === 'memory_write')
    const links = box.list.find(t => t.name === 'memory_links')
    const old = await write.execute({type:'user',scope:'global',summary:'固定使用紫罗兰色的画板'}, {})
    const value = await write.execute({type:'user',scope:'global',summary:'固定使用深绿色的画板',supersedes:'紫罗兰色'}, {})
    lossless(value)
    assert.equal(typeof value.superseded, 'string')
    const older = await links.execute({scope:'global',id:old.id}, {})
    const newer = await links.execute({scope:'global',id:value.id}, {})
    lossless(older);lossless(newer)
    assert.equal(older.found, false)
    assert.equal(newer.supersedesLine, old.indexLine)
  } finally { box.cleanup() }
})

test('原生工具输出：无版本链或未找到的 links 不带未定义属性', async () => {
  const box = tools()
  try {
    const value = await box.list.find(t => t.name === 'memory_write').execute({type:'user',scope:'global',summary:'固定使用紫罗兰色的画板'}, {})
    const tool = box.list.find(t => t.name === 'memory_links')
    lossless(await tool.execute({scope:'global',id:value.id}, {}))
    const missing = await tool.execute({scope:'global',match:'不存在的风琴'}, {})
    lossless(missing);assert.equal(missing.found, false)
  } finally { box.cleanup() }
})

test('原生工具输出：六工具完整生命周期均保持 JSON 结果契约', async () => {
  const box = tools()
  try {
    const call = async (name,args) => {const value=await box.list.find(t => t.name === name).execute({scope:'global',...args}, {});lossless(value);return value}
    await call('memory_write',{type:'user',summary:'固定使用紫罗兰色的画板'})
    assert.ok((await call('memory_search',{query:'紫罗兰色'})).hits.length)
    assert.equal((await call('memory_links',{match:'紫罗兰色'})).found, true)
    assert.equal((await call('memory_status',{})).index.lines, 1)
    assert.equal((await call('memory_prune',{})).applied, false)
    assert.equal((await call('memory_forget',{match:'紫罗兰色'})).removed, 1)
    assert.equal((await call('memory_status',{})).index.lines, 0)
  } finally { box.cleanup() }
})
