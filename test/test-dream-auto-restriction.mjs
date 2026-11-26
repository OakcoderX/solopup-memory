import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildDreamEvidence } from '../dream-review.mjs'
import { planDreamCorrection, prepareDreamCorrection } from '../dream-auto-apply.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
function plan(old, next, { proposed = next, exceptions = [] } = {}) {
  const projectId = digest('project'), storeRevision = digest('revision'), sessionId = 'original'
  const quote = `已确认：${old}`
  const record = { id: digest('record'), scope: 'project', status: 'recorded', summary: old,
    sessionId, createdAt: new Date(1000).toISOString(), meaning: { kind: 'decision', conditions: [], except: exceptions },
    evidence: [{ messageId: 'original-message', quote, hash: digest(quote) }],
    sources: [digest(JSON.stringify([sessionId, 'original-message']))] }
  const message = `更正「${old}」→「${next}」`
  const pointer = { sessionId: 'owner', seq: 4, hash: digest(message) }
  const source = { ...pointer, projectId, role: 'user', sourceComplete: true, messageId: 'owner:4',
    text: message, quote: message, occurredAt: new Date(2000).toISOString(), wholeOwnerMessage: true, liveCursor: 6 }
  const proof = { pointers: { [record.id]: [pointer] }, additionalEvidenceByTarget: { [record.id]: [source] } }
  const input = buildDreamEvidence({ projectId, storeRevision, records: [record], ...proof, now: 3000 })
  const row = { id: record.id, verdict: 'propose-correction', proposedSummary: proposed,
    evidenceDigest: digest(JSON.stringify(input.items[0])), pointerDigest: digest(JSON.stringify([pointer])),
    sourceIds: input.items[0].sources.map(source => source.id) }
  return { plan: planDreamCorrection({ report: { projectId, storeRevision, items: [row] }, input, proof }), record }
}

test('automatic correction only admits clearly identified delivery values', () => {
  for (const [old, next] of [
    ['交付说明默认使用中文。', '交付说明默认使用英文。'],
    ['交付格式为PDF', '交付格式为DOCX'],
    ['交付模板版本为 V1', '交付模板版本为 V2'],
    ['正式交付说明默认用中文，内部审片批注用中文。', '正式交付说明默认用英文，内部审片批注用中文。'],
  ]) assert.ok(plan(old, next).plan, old)
  for (const [old, next] of [
    ['脚注适用的页码为 2 页', '脚注适用的页码为 3 页'],
    ['交付页数为2页', '交付页数为3页'],
    ['第2章交付说明默认使用中文。', '第2章交付说明默认使用英文。'],
    ['审批通过后交付格式为PDF', '审批通过后交付格式为DOCX'],
    ['交付模板版本试行为 V1', '交付模板版本试行为 V2'],
    ['交付格式为PDF，仅限第2章', '交付格式为DOCX，仅限第2章'],
    ['脚注语言为中文', '脚注语言为英文'],
    ['交付模板版本为 V1，适用于第2章', '交付模板版本为 V2，适用于第2章'],
  ]) assert.equal(plan(old, next).plan, undefined, old)
})


test('exact inherited exception may be restated without altering the owner replacement', () => {
  const old = '交付格式使用DOCX', next = '交付格式使用PDF'
  const exceptions = [{ dimension: 'audience', value: '内部审阅稿' }]
  const observed = '交付格式使用PDF。例外：内部审阅稿。'
  const result = plan(old, next, { exceptions, proposed: observed })
  assert.equal(result.plan.after, next)
  const punctuated = plan('交付格式使用DOCX。', '交付格式使用PDF。', { exceptions, proposed: observed })
  assert.equal(punctuated.plan.after, '交付格式使用PDF。')
  assert.equal(plan('交付格式使用DOCX。', '交付格式使用PDF。', { exceptions, proposed: '交付格式使用PDF。。例外：内部审阅稿。' }).plan, undefined)
  const parent = { ...result.record, type: 'project', indexLine: '- [project] example', expires: '2030-12-12' }
  assert.deepEqual(prepareDreamCorrection(result.plan, parent).meaning.except, exceptions)
  assert.equal(prepareDreamCorrection(result.plan, { ...parent, meaning: { ...parent.meaning, except: [] } }), undefined)
  for (const proposed of [
    '交付格式使用PDF。例外：内部审阅稿及外部稿。',
    '交付格式使用PDF。例外：内部审阅。',
    '交付格式使用PDF。例外：内部审阅稿。另需审批。',
    '交付格式使用PDF。例外：内部审阅稿',
    '交付格式使用DOCX。例外：内部审阅稿。',
  ]) assert.equal(plan(old, next, { exceptions, proposed }).plan, undefined, proposed)
  assert.equal(plan(old, next, { proposed: observed }).plan, undefined)
  assert.equal(plan(old, next, { exceptions: [...exceptions, { dimension: 'other', value: '其他稿' }], proposed: observed }).plan, undefined)
})
