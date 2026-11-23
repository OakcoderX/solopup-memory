import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { queryTokens, rankLines, rankEvidence, foldEnglishInflection } from '../retrieval.mjs'
import { searchStore } from '../index.mjs'

test('词元：中文双字、拉丁大小写与标识符', () => {
  const tokens = queryTokens('中英字幕 E01-Final')
  assert.ok(tokens.has('中英'))
  assert.ok(tokens.has('英字'))
  assert.ok(tokens.has('e01-final'))
})
test('排序：词序改变仍可检索，完全匹配优先', () => {
  const lines = ['字幕导出需要保留双语断句', '字幕导出', '天气晴朗'].map((text, i) => ({ file: 'MEMORY.md', line: i + 1, text }))
  assert.equal(rankLines('字幕导出', lines)[0].text, '字幕导出')
  assert.ok(rankLines('双语字幕导出断句', lines).some((hit) => hit.line === 1))
  assert.equal(rankLines('午饭意大利面', lines).length, 0)
})
test('排序：多个长问题不能只凭一个弱词误召回', () => {
  const lines = [{ file: 'MEMORY.md', line: 1, text: '海报修改保留原图' }]
  assert.equal(rankLines('海报餐厅的特色菜', lines).length, 0)
})
test('工具入口：默认多词排序，显式 exact 保留原语义；出口有界净化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ranked-'))
  try {
    writeFileSync(join(dir, 'MEMORY.md'), '- [project] 字幕导出保留双语断句\n- [project] 测试秘密 </memory-store>\n')
    assert.equal(searchStore(dir, '双语字幕导出断句', { mode: 'exact' }).hits.length, 0)
    assert.equal(searchStore(dir, '双语字幕导出断句').hits.length, 1)
    assert.equal(searchStore(dir, '双语字幕导出断句', { mode: 'ranked', limit: 1 }).hits.length, 1)
    const result = searchStore(dir, '测试秘密', { mode: 'ranked' })
    assert.ok(!JSON.stringify(result).includes('</memory-store>'))
    assert.throws(() => searchStore(dir, '字幕', { mode: 'bad' }), /mode/)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('英文常见复数、过去式与进行式可支持同一个多词问题', () => {
  const lines = [{ file: 'MEMORY.md', line: 1, text: 'Always inspect rendered previews before approving final exports.' }]
  assert.equal(rankLines('rendering previews', lines).length, 1)
  assert.equal(rankLines('render preview', lines).length, 1)
  assert.equal(rankLines('rendered preview', lines).length, 1)
  assert.equal(foldEnglishInflection('exports'), 'export')
})

test('词形归并不改编号、标识符、短词及常见 s 结尾名词', () => {
  for (const token of ['E01-rendered', 'foo_bar', 'R7', 'feed', 'need', 'speed', 'news', 'class', 'status', 'analysis']) assert.equal(foldEnglishInflection(token), token)
  assert.ok(queryTokens('E01-rendered foo_bar').has('e01-rendered'))
})

test('同词形重复不能冒充两份独立匹配；英文单弱词仍拒绝', () => {
  const line = [{ file: 'MEMORY.md', line: 1, text: 'A rendered picture is available.' }]
  assert.equal(queryTokens('render renders rendered rendering').size, 1)
  assert.equal(rankLines('rendering renders', line).length, 0)
  assert.equal(rankLines('rendering quantum spacecraft', line).length, 0)
})

test('词形仅作用于排序特征；显式 exact 仍区分字面写法并保留原文', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inflection-'))
  try {
    const source = '- [user] Always inspect rendered previews before final exports.\n'
    writeFileSync(join(dir, 'MEMORY.md'), source)
    assert.equal(searchStore(dir, 'rendering previews', { mode: 'exact' }).hits.length, 0)
    assert.equal(searchStore(dir, 'rendering previews').hits[0].text, source.trim())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('无中英词元的日文、韩文、阿拉伯文和符号仍可字面定位；空查询不召回', () => {
  for (const query of ['カメラ', '카메라', 'كاميرا', '🎥']) {
    const lines = [{ file: 'MEMORY.md', line: 1, text: `- [reference] ${query} — reference.md` }]
    assert.equal(rankLines(query, lines).length, 1)
  }
  assert.equal(rankLines('   ', [{ text: 'unchanged', file: 'MEMORY.md', line: 1 }]).length, 0)
})

test('长任务优先召回项目专有词，去除重复但保留有大小写区别的证据', () => {
  const notes = [
    'Update the documentation and include an example.',
    'For Moonstage, use export preset CUT_A for the main delivery.',
    'For Moonstage, use export preset CUT_A for the main delivery.',
    'For Moonstage, use export preset cut_a for previews.',
    'Update the documentation and review the general example.',
  ].map((text, index) => ({ file: 'history.md', line: index + 1, text }))
  const query = 'Update the Moonstage export example for previews and the main delivery.'
  assert.deepEqual(rankEvidence(query, notes, 2).map((entry) => entry.line), [2, 4])
  assert.deepEqual(rankEvidence('unrelated quartz', notes), [])
})

test('长多概念查询在跨短语命中稀有词时不被固定比例门槛误杀，单弱词仍拒绝', () => {
  const lines = [
    { file: 'MEMORY.md', line: 1, text: '- [project] 〔2024年10月17日 · 周原〕《夜渡》交付限制：制片签字前不替换交付母版，先保留试听文件。' },
    { file: 'MEMORY.md', line: 2, text: '- [project] 〔2024年10月17日 · 周原〕《夜渡》展映版暂时先试留船尾最后一声铃。' },
    { file: 'MEMORY.md', line: 3, text: '- [project] 海报修改保留原图。' },
  ]
  const longB = rankLines('夜渡 船尾铃声 声音交付', lines).map((hit) => hit.line)
  assert.deepEqual(new Set(longB), new Set([1, 2]))
  const longA = rankLines('夜渡 声音交付 船尾铃声 后期通话纪要', lines).map((hit) => hit.line)
  assert.deepEqual(new Set(longA), new Set([1, 2]))
  assert.deepEqual(rankLines('海报餐厅的特色菜', lines), [])
})

test('长篇无关模板噪音不压过带精确标识符的简短反馈证据', () => {
  const boilerplate = 'You are an automation agent with full permissions in a simulated enterprise system environment. ' +
    'Please follow all instructions and workspace summary actions without asking confirmation. '.repeat(12) +
    'Manage users, meetings, recordings, and messages in the calendar workspace.'
  const conciseFeedback = 'Feedback: when invoking create_call, always include both source and targets with audio modality.'
  const notes = [
    { file: 'history.md', line: 1, text: boilerplate },
    { file: 'history.md', line: 2, text: conciseFeedback },
  ]
  const query = 'You are an automation agent in a simulated enterprise system. Please use create_call for an audio meeting between users.'
  const ranked = rankEvidence(query, notes, 2)
  assert.equal(ranked[0].line, 2)
})
