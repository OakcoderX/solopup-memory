/** Conservative exposure reduction, not a confidentiality boundary or exhaustive PII detector. */
import {normalizeText} from './security.mjs'
const patterns = [
  ['exact-dob', /生日|出生(?:日期|年月|于|在)?|\bbirth(?:day|date)\b|\bdate\s+of\s+birth\b|\bdob\b|\bborn\b/i],
  ['personal-profile', /个人档案|性别|男性|女性|\bpersonal\s+profile\b|\bgender\b/i],
  ['health', /病史|医疗诊断|疾病诊断|医生诊断|诊断(?:为|出)|用药|过敏|怀孕|月经|健康状况|医疗资料|\bmedical\b|\bclinical\s+diagnosis\b|\bdiagnosed\s+with\b|\bmedication\b/i],
  ['intimate', /亲密关系|性取向|性生活|性行为|伴侣|男朋友|女朋友|前任|恋爱|情人|\bsexual\b|\bintimate\b|\bromantic\b/i],
  ['personal-contact', /身份证|护照号码|家庭住址|私人电话|银行卡号|\bpassport\s+number\b|\bhome\s+address\b/i],
  ['marked-private', /\[private(?::[a-z-]+)?\]|保密资料|私密档案|敏感个人/i],
]

export function memoryPrivacy(value, line = '') {
  const content = typeof value === 'string' ? value : value && typeof value === 'object'
    ? [value.summary, value.detail, value.indexLine, JSON.stringify(value.meaning ?? {}),
      ...(value.evidence ?? []).map(e => e.quote), JSON.stringify(value.fieldLineage ?? {})].filter(Boolean).join('\n') : ''
  const text = normalizeText(content + '\n' + line)
  const categories = patterns.filter(([, pattern]) => pattern.test(text)).map(([category]) => category)
  return {exposure: categories.length ? 'on-demand' : 'automatic', categories}
}
export const privateMemory = (value, line = '') => memoryPrivacy(value, line).exposure === 'on-demand'
export function publicMemoryRecords(records) { return records.filter(record => !privateMemory(record)) }
export function publicMemoryIndex(lines, records) {
  return lines.filter(line => !privateMemory(records.find(record => record.indexLine === line || line.endsWith(' ' + record.indexLine)), line))
}
export const PRIVATE_MEMORY_NOTICE = '个人资料可能按需保存在本地；未自动提供其内容。仅在用户询问相关资料时使用 memory_search 并明确 includePrivate=true。读取结果仍会进入当前会话及模型请求；这不是加密或文件访问隔离。'
