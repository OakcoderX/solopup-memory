#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDreamQueue } from '../dream-queue.mjs'
import { buildDreamEvidence } from '../dream-review.mjs'
import { readDreamProject } from '../index.mjs'

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function reportView(queue, root, runId, cwd) {
  const run = queue.getRun(runId), report = queue.report(runId)
  if (!run || !report) return { available: false, reason: 'dream-report-missing' }
  return readDreamProject(root, cwd, project => {
    if (project?.projectId !== report.projectId) return { available: false, reason: 'dream-report-project-mismatch' }
    const input = buildDreamEvidence({ ...project, targetIds: run.metadata.itemIds })
    if (digest(input) !== report.inputHash) return { available: false, reason: 'dream-report-evidence-changed' }
    const items = report.items.map(row => {
      const item = input.items.find(value => value.id === row.id)
      return { ...row, current: item.summary, sources: item.sources.filter(source => row.sourceIds.includes(source.id)) }
    })
    return { available: true, ...report, items }
  })
}

function run(args) {
  if (!args.length || args[0] === '--help') {
    return { usage: [
      'node scripts/dream-review.mjs status',
      'node scripts/dream-review.mjs mode ordinary|superagent',
      'node scripts/dream-review.mjs preview /absolute/project',
      'node scripts/dream-review.mjs reports',
      'node scripts/dream-review.mjs show RUN_ID /absolute/project',
    ] }
  }
  const [command, parameter, project, ...rest] = args
  if (rest.length || !(command === 'status' && args.length === 1 || command === 'reports' && args.length === 1 ||
    command === 'mode' && args.length === 2 && ['ordinary', 'superagent'].includes(parameter) ||
    command === 'preview' && args.length === 2 ||
    command === 'show' && args.length === 3 && /^[a-f0-9]{64}$/.test(parameter))) throw Error('dream-invalid-command')
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'memory')
  if (command === 'preview') return readDreamProject(root, parameter, current => {
    if (!current) return { available: false, reason: 'dream-project-unavailable' }
    const input = buildDreamEvidence(current)
    return {
      available: true, projectId: current.projectId, currentRecords: current.records.length,
      selectedItems: input.items.length, selectedQuotes: input.items.reduce((n, item) => n + item.sources.length, 0),
      needsMoreEvidence: input.items.filter(item => item.incompleteEvidence).length,
      modelInvoked: false,
    }
  })
  const queue = openDreamQueue(root, { existingOnly: true })
  try {
    if (command === 'status') {
      const { budget: { day, attempts, tokens }, ...state } = queue.status()
      return { ...state, budget: { day, attempts, tokens } }
    }
    if (command === 'mode') return queue.requestExecutor(parameter)
    if (command === 'reports') return queue.listReports()
    return reportView(queue, root, parameter, project)
  } finally { queue.close() }
}

try {
  process.stdout.write(JSON.stringify(run(process.argv.slice(2)), null, 2) + '\n')
} catch (error) {
  const safe = /^dream-(?:queue-)?[a-z-]+$/.test(error?.message) ? error.message : 'dream-command-unavailable'
  process.stderr.write(safe + '\n')
  process.exitCode = 1
}
