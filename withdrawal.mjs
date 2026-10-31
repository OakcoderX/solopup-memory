import {withdrawalSelector} from './source-identity.mjs'
import {readdirSync} from 'node:fs'
import { createHash } from 'node:crypto'
/** Build a withdrawal plan for traceable adopted records and audit-linked summary-only captures. */
import { join } from 'node:path'
import { readSafely, normalizeText, entryId } from './security.mjs'
import { contentHash } from './publication.mjs'
import { readManagedLogs } from './managed-logs.mjs'
import { removeRetiredBlock } from './source-retirement.mjs'
import {purgeEpisodes} from './episodes.mjs'

export const normalizedLineHash = (line) => contentHash(normalizeText(line).trim())
export const candidateDetail = (id, detail) => `[candidate:${id}]\n${detail}`
const hasSourceOrigin = record => ['tool-context', 'quoted-extraction'].includes(record.origin)

export function buildWithdrawal(dir, affected, source, formatLine, independent = []) {
  const retired = affected.filter(record => record.status === 'retired')
  const adopted = affected.filter((r) => r.status === 'adopted' || hasSourceOrigin(r) && ['recorded', 'superseded'].includes(r.status))
  const hasDetail = record => record.detail !== undefined && normalizeText(String(record.detail)).trim().length > 0
  const records = adopted.map((r) => ({ candidateId: r.id, line: hasSourceOrigin(r) ? r.indexLine : formatLine(r.type, r.summary, undefined, hasDetail(r)), type: r.type, detail: r.detail, allowMissingIndex: hasSourceOrigin(r) }))
  const effectiveHash = other => other.status === 'retired' ? other.lineHash : normalizedLineHash(hasSourceOrigin(other) ? other.indexLine : formatLine(other.type, other.summary, undefined, hasDetail(other)))
  if ([...records.map(record => normalizedLineHash(record.line)), ...retired.map(record => record.lineHash)].some(hash => independent.some(other => effectiveHash(other) === hash))) throw new Error('withdrawal-shared-effective-memory')
  const logs = readManagedLogs(dir).map(({ name, raw }) => {
    const rows = raw === undefined ? [] : raw.split('\n').filter((l) => l.trim()).map((l) => {
      try { return JSON.parse(l) } catch { throw new Error('withdrawal-corrupt-log') }
    })
    return { name, raw, rows }
  })
  const sourceHash = source.sourceKey ?? createHash('sha256').update(JSON.stringify([source.sessionId, source.messageId])).digest('hex')
  if(source.sourceKey&&source.sessionId!==undefined)source=withdrawalSelector(source.sourceKey,source)
  const matchesSource = (row) => typeof row?.sessionId === 'string' && Array.isArray(row.evidence) && row.evidence.some(e => typeof e?.messageId === 'string' && createHash('sha256').update(JSON.stringify([row.sessionId, e.messageId])).digest('hex') === sourceHash)
  for (const { rows } of logs) for (const row of rows) {
    if (row?.op === 'write' && row.outcome === 'ok' && (source.sessionId!==undefined ? row.sessionId===source.sessionId : source.sourceKey ? typeof row.sessionId==='string' : false) && typeof row.line === 'string' && (!Array.isArray(row.evidence) || !row.evidence.length)) throw new Error('withdrawal-missing-source-lineage')
    if (row?.op !== 'write' || row.outcome !== 'ok' || !matchesSource(row) || typeof row.line !== 'string') continue
    if (records.some((r) => r.line === row.line) || retired.some(record => record.lineHash === normalizedLineHash(row.line))) continue
    if (row.withDetail) throw new Error('withdrawal-untracked-detail')
    if (!['user', 'feedback', 'project', 'reference'].includes(row.type)) throw new Error('withdrawal-invalid-audit-type')
    records.push({ line: row.line, type: row.type })
  }
  const index = readSafely(join(dir, 'MEMORY.md'))
  const indexLines = (index ?? '').split('\n')
  const lineHashes = new Set([...records.map((r) => normalizedLineHash(r.line)), ...retired.map(record => record.lineHash)])
  const ids = new Set([...records.map((r) => entryId(r.line)), ...retired.map(record => record.memoryId)])
  const candidateIds = new Set(affected.map((r) => r.id))
  for (const r of records) {
    if (!r.allowMissingIndex && !indexLines.some((line) => normalizeText(line).trim() === normalizeText(r.line).trim())) throw new Error('withdrawal-effective-line-diverged')
  }
  for (const record of [...records.filter(record => record.allowMissingIndex && record.detail !== undefined), ...retired.filter(record => record.block)]) {
    if (readdirSync(dir).some(name => name.startsWith(record.type + '.archive-'))) throw new Error('withdrawal-unreviewed-topic-archive')
  }
  const writes = []
  const historical=purgeEpisodes(dir,sourceHash);if(historical)writes.push(historical)
  if (index !== undefined && records.length + retired.length > 0) writes.push({ name: 'MEMORY.md', text: indexLines.filter((line) => !lineHashes.has(normalizedLineHash(line))).join('\n') })
  const topics = new Map()
  for (const r of records) {
    if (r.detail === undefined) continue
    const name = `${r.type}.md`
    const current = topics.has(name) ? topics.get(name) : readSafely(join(dir, name))
    const indexPresent = indexLines.some(line => normalizeText(line).trim() === normalizeText(r.line).trim())
    if (current === undefined && r.allowMissingIndex && !indexPresent) continue
    if (current === undefined || !r.candidateId) throw new Error('withdrawal-untracked-detail')
    const block = candidateDetail(r.candidateId, r.detail)
    const start = current.indexOf(block)
    if (start < 0 && r.allowMissingIndex && !indexPresent && !current.includes(`[candidate:${r.candidateId}]`) && !current.includes(r.detail)) continue
    if (start < 0 || current.indexOf(block, start + block.length) >= 0) throw new Error('withdrawal-untracked-detail')
    const header = current.lastIndexOf('\n- ', start)
    if (header < 0 || !/^\n- \d{4}-\d\d-\d\d｜$/.test(current.slice(header, start)) || current[start + block.length] !== '\n') throw new Error('withdrawal-untracked-detail')
    topics.set(name, current.slice(0, header) + '\n' + current.slice(start + block.length + 1))
  }
  for (const record of retired) {
    if (!record.block) continue
    const name = record.type + '.md', current = topics.has(name) ? topics.get(name) : readSafely(join(dir, name))
    if (current === undefined) continue
    const next = removeRetiredBlock(current, record)
    if (next !== current) topics.set(name, next)
  }
  for (const [name, text] of topics) writes.push({ name, text })
  function scrub(value) {
    if (Array.isArray(value)) return value.filter((v) => !(v && typeof v === 'object' && ids.has(v.id))).map(scrub)
    if (value && typeof value === 'object') {
      const next = Object.create(null)
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && (lineHashes.has(normalizedLineHash(item)) || key === 'summary' && affected.some((r) => r.summary === item))) continue
        next[key] = scrub(item)
      }
      return next
    }
    return value
  }
  for (const log of logs) {
    if (log.raw === undefined) continue
    let changed = false
    const rows = log.rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('withdrawal-corrupt-log')
      if (ids.has(row.id) && typeof row.line === 'string' && !lineHashes.has(normalizedLineHash(row.line))) throw new Error('withdrawal-id-collision')
      if (ids.has(row.id) || lineHashes.has(normalizedLineHash(String(row.line ?? ''))) || candidateIds.has(row.candidateId) || matchesSource(row)) {
        changed = true
        return { op: 'source-withdrawn', ...(typeof row.id === 'string' ? { id: row.id } : {}) }
      }
      const next = scrub(row)
      if (JSON.stringify(next) !== JSON.stringify(row)) changed = true
      return next
    })
    if (changed) writes.push({ name: log.name, text: rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '') })
  }
  return { writes, lineHashes: [...lineHashes], memoryIds: [...ids], candidateIds: [...candidateIds],
    blocks: [...records.filter((r) => r.candidateId && r.detail !== undefined).map((r) => ({ id: r.candidateId, length: candidateDetail(r.candidateId, r.detail).length, hash: contentHash(candidateDetail(r.candidateId, r.detail)) })), ...retired.filter(record => record.block).map(record => record.block)], effectiveRemoved: records.length + retired.length }
}

/** Suppress exact withdrawn lines and marked detail blocks if an old file is restored. */
export function filterWithdrawn(text, policy, isIndex = false) {
  let filtered = text
  for (const id of policy.candidateIds) {
    const marker = `[candidate:${id}]\n`
    let start = filtered.indexOf(marker)
    while (start >= 0) {
      const header = filtered.lastIndexOf('\n- ', start)
      const block = policy.blocks.find((b) => b.id === id)
      const length = block?.length
      if (header < 0 || !/^\n- \d{4}-\d\d-\d\d｜$/.test(filtered.slice(header, start)) || length === undefined || contentHash(filtered.slice(start, start + length)) !== block.hash) {
        if (policy.strict === true) throw new Error('withdrawal-unverifiable-block')
        start = filtered.indexOf(marker, start + marker.length)
        continue
      }
      // Known original block length prevents embedded dated lines from leaking its tail.
      filtered = filtered.slice(0, header) + filtered.slice(start + length)
      start = filtered.indexOf(marker)
    }
  }
  return filtered.split('\n').filter((line) => !policy.lineHashes.includes(normalizedLineHash(line))).join('\n')
}

/** Scrub recognizable restored projections without recreating deleted evidence bodies. */
export function prepareRestoredWithdrawalCleanup(dir,policy,source){
  const strict={...policy,strict:true},writes=[],ids=new Set(policy.memoryIds),candidateIds=new Set(policy.candidateIds),lines=new Set(policy.lineHashes)
  const historical=purgeEpisodes(dir,source);if(historical)writes.push(historical)
  for(const name of ['MEMORY.md','user.md','feedback.md','project.md','reference.md']){
    const body=readSafely(join(dir,name));if(body===undefined)continue
    const next=filterWithdrawn(body,strict,name==='MEMORY.md');if(next!==body)writes.push({name,text:next})
  }
  const matches=row=>typeof row?.sessionId==='string'&&Array.isArray(row.evidence)&&row.evidence.some(e=>typeof e?.messageId==='string'&&createHash('sha256').update(JSON.stringify([row.sessionId,e.messageId])).digest('hex')===source)
  function scrub(value){
    if(Array.isArray(value))return value.filter(item=>!item||typeof item!=='object'||!ids.has(item.id)).map(scrub)
    if(value&&typeof value==='object'){const result={};for(const [key,item]of Object.entries(value)){if(typeof item==='string'&&lines.has(normalizedLineHash(item)))continue;result[key]=scrub(item)}return result}
    return value
  }
  for(const {name,raw}of readManagedLogs(dir)){
    if(raw===undefined)continue
    const rows=raw.split('\n').filter(line=>line.trim()).map(line=>{try{return JSON.parse(line)}catch{throw Error('withdrawal-corrupt-log')}})
    let changed=false
    const after=rows.map(row=>{if(!row||typeof row!=='object'||Array.isArray(row))throw Error('withdrawal-corrupt-log');if(ids.has(row.id)||candidateIds.has(row.candidateId)||typeof row.line==='string'&&lines.has(normalizedLineHash(row.line))||matches(row)){changed=true;return{op:'source-withdrawn',...(typeof row.id==='string'?{id:row.id}:{})}}const next=scrub(row);if(JSON.stringify(next)!==JSON.stringify(row))changed=true;return next})
    if(changed)writes.push({name,text:after.map(row=>JSON.stringify(row)).join('\n')+(after.length?'\n':'')})
  }
  return writes
}
