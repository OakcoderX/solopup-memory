/** Exact paired sign test at independent scenario level. No external libraries. */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function signTail(wins, losses) {
  if (![wins, losses].every((v) => Number.isSafeInteger(v) && v >= 0) || wins + losses > 10000) throw new Error('invalid counts')
  const n = wins + losses
  if (!n || wins === 0) return 1
  // log binomial PMF avoids underflow for large discordant sets.
  let logCombination = 0
  let total = 0
  for (let k = 0; k <= n; k += 1) {
    if (k >= wins) total += Math.exp(logCombination - n * Math.LN2)
    if (k < n) logCombination += Math.log(n - k) - Math.log(k + 1)
  }
  return Math.min(1, total)
}

export function analyzePairs(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('missing paired scenarios')
  let wins = 0, losses = 0, ties = 0, ours = 0, baseline = 0
  const ids = new Set()
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw new Error('duplicate or missing scenario id')
    ids.add(row.id)
    if (!Array.isArray(row.ours) || !Array.isArray(row.baseline) || row.ours.length !== row.baseline.length || !row.ours.length) throw new Error('unpaired repetitions')
    if (![...row.ours, ...row.baseline].every((v) => typeof v === 'boolean')) throw new Error('success must be boolean; missing results count as failures upstream')
    const a = row.ours.filter(Boolean).length / row.ours.length
    const b = row.baseline.filter(Boolean).length / row.baseline.length
    ours += a; baseline += b
    if (a > b) wins += 1
    else if (a < b) losses += 1
    else ties += 1
  }
  return {
    scenarios: rows.length, wins, losses, ties,
    ours: ours / rows.length, baseline: baseline / rows.length,
    meanPairedDifference: (ours - baseline) / rows.length,
    oneSidedSignP: signTail(wins, losses),
    conclusion: 'statistics-only: requires frozen protocol, real harness traces, scope and safety review',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(analyzePairs(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
