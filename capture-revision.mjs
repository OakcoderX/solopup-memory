/** Bind a model-requested replacement to an exact, same-scope captured index row.
 * This proves target identity, not semantic entailment of the user's correction.
 * writeMemory's revision guard and publication transaction remain authoritative.
 */
export function captureRevision(candidate, indexLines) {
  if (candidate.supersedes === undefined) return undefined
  const fail = () => { const error = new Error('capture-invalid-replacement'); error.code = 'capture-invalid-replacement'; throw error }
  const target = candidate.supersedes
  if (candidate.basis !== 'explicit' || !['global', 'project'].includes(candidate.scope) || typeof target !== 'string' || target.length > 4096) fail()
  const prefix = `[${candidate.scope}] `
  if (!target.startsWith(prefix) || !target.slice(prefix.length).startsWith('- [') || !Array.isArray(indexLines) || indexLines.filter(line => line === target).length !== 1) fail()
  return target.slice(prefix.length)
}
