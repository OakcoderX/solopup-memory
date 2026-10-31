#!/usr/bin/env node
/** Local review CLI. Apply is explicit; no model-callable adoption endpoint. */
import { listCandidates, rejectCandidate, withdrawSource, pruneCandidates } from '../candidates.mjs'
import { storeDirFor, adoptCandidate, recoverMemoryPublication, withdrawManagedSource } from '../index.mjs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const command = args.shift() ?? 'list'
function option(name, fallback) {
  const i = args.indexOf(name)
  if (i < 0) return fallback
  if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new Error(`${name} 需要值`)
  const value = args[i + 1]; args.splice(i, 2); return value
}
try {
  const scope = option('--scope', 'project')
  if (scope !== 'project' && scope !== 'global') throw new Error('scope 必须是 project 或 global')
  const cwd = resolve(option('--cwd', process.cwd()))
  const status = option('--status', 'pending')
  const limit = Number(option('--limit', '20'))
  const id = option('--id', undefined)
  const session = option('--session', undefined)
  const message = option('--message', undefined)
  const reviewedIndex = option('--reviewed-index', undefined)
  const candidateRevisionText = option('--candidate-revision', undefined)
  const controlReview = option('--control-review', undefined)
  const controlRevision = option('--control-revision', undefined)
  const operationId = option('--operation', undefined)
  const candidateRevision = candidateRevisionText === undefined ? undefined : Number(candidateRevisionText)
  const applyIndex = args.indexOf('--apply')
  const apply = applyIndex >= 0
  if (apply) args.splice(applyIndex, 1)
  if (apply && !['prune', 'adopt', 'recover', 'withdraw-managed-source'].includes(command)) throw new Error('--apply 仅用于 prune/adopt/recover/withdraw-managed-source')
  if (args.length) throw new Error('未知参数')
  const dir = storeDirFor(scope, cwd)
  let result
  if (command === 'list') result = listCandidates(dir, { status, limit })
  else if (command === 'reject') result = rejectCandidate(dir, id)
  else if (command === 'withdraw-source') result = withdrawSource(dir, session, message)
  else if (command === 'prune') result = pruneCandidates(dir, { apply })
  else if (command === 'adopt') result = adoptCandidate(dir, id, { scope, apply, reviewedIndex, candidateRevision, controlRevision })
  else if (command === 'recover') result = recoverMemoryPublication(dir, { apply })
  else if (command === 'withdraw-managed-source') result = withdrawManagedSource(dir, session, message, { scope, apply, reviewedIndex, candidateRevision, controlReview, operationId })
  else throw new Error('操作：list / reject / withdraw-source / withdraw-managed-source / prune / adopt / recover；adopt、recover 与 withdraw-managed-source 默认只预览')
  console.log(JSON.stringify({ scope, ...result }, null, 2))
} catch (error) { console.error(error.message); process.exitCode = 1 }
