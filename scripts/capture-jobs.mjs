#!/usr/bin/env node
/** Read-only by default. Recovery marks expired invocations; never calls a model. */
import { storeDirFor } from '../index.mjs'
import { listCaptureJobs, recoverCaptureJobs, abandonCaptureJob } from '../capture-jobs.mjs'
import { listCaptureInputs, pruneCaptureInputs } from '../capture-inputs.mjs'

try {
  const args = process.argv.slice(2)
  const command = args.shift() ?? 'list'
  const usage = '用法：capture-jobs.mjs list | inputs | inputs-prune [--apply --revision 输入版本 --jobs-revision 调用版本] | recover [--apply] | abandon ID [--apply --revision 预览版本]'
  const id = command === 'abandon' ? args.shift() : undefined
  const applyIndex = args.indexOf('--apply'); const apply = applyIndex >= 0
  if (apply) args.splice(applyIndex, 1)
  const revisionIndex = args.indexOf('--revision')
  let expectedRevision
  if (revisionIndex >= 0) {
    const text = args[revisionIndex + 1]
    if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(usage)
    expectedRevision = Number(text); args.splice(revisionIndex, 2)
  }
  const jobsIndex = args.indexOf('--jobs-revision')
  let expectedJobsRevision
  if (jobsIndex >= 0) {
    const text = args[jobsIndex + 1]
    if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(text)) throw new Error(usage)
    expectedJobsRevision = Number(text); args.splice(jobsIndex, 2)
  }
  if (args.length || apply && !['recover', 'abandon', 'inputs-prune'].includes(command) ||
    expectedRevision !== undefined && (!['abandon','inputs-prune'].includes(command) || !apply) ||
    expectedJobsRevision !== undefined && (command !== 'inputs-prune' || !apply)) throw new Error(usage)
  if (!['list', 'recover', 'abandon', 'inputs', 'inputs-prune'].includes(command)) throw new Error(usage)
  const dir = storeDirFor('global')
  if (command === 'inputs') console.log(JSON.stringify({applied:false,...listCaptureInputs(dir)},null,2))
  else if (command === 'inputs-prune') console.log(JSON.stringify(pruneCaptureInputs(dir,{apply,expectedRevision,expectedJobsRevision}),null,2))
  else if (command === 'abandon') console.log(JSON.stringify(abandonCaptureJob(dir, id, { apply, expectedRevision }), null, 2))
  else if (command === 'recover' && apply) console.log(JSON.stringify({ applied: true, ...recoverCaptureJobs(dir) }, null, 2))
  else {
    const state = listCaptureJobs(dir)
    console.log(JSON.stringify({ applied: false, ...state }, null, 2))
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
