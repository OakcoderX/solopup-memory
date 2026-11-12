/** Optional parent plugin. Register explicitly in the DSH profile; it is never auto-loaded. */
import { isAbsolute } from 'node:path'
import { createDreamCompanion } from '../dream-companion.mjs'
import { SUPER_AGENT_DREAM_SERVICE, SUPER_AGENT_DREAM_ISOLATION_SERVICE } from '../dream-superagent.mjs'
import { watchOptionalService } from '../service-readiness.mjs'

export const name = 'solopup-dream-companion'
const paths = ['dshCli', 'prototypeBundle', 'stateDir']
const keys = new Set([...paths, 'prototypeBundleSha256'])
export const Config = Object.freeze({ '~standard': Object.freeze({ version: 1, vendor: 'solopup-dream-companion', validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.has(key))) {
    return { issues: [{ message: 'Provide the explicit companion paths and the pinned prototype bundle SHA-256.' }] }
  }
  const issues = []
  for (const field of paths) if (typeof value[field] !== 'string' || !isAbsolute(value[field]) || /[\x00-\x1f]/.test(value[field])) {
    issues.push({ message: 'Use an absolute path.', path: [field] })
  }
  if (typeof value.prototypeBundleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.prototypeBundleSha256)) {
    issues.push({ message: 'Use a lowercase SHA-256 digest.', path: ['prototypeBundleSha256'] })
  }
  return issues.length ? { issues } : { value }
} }) })

export function apply(ctx, config) {
  const llm = watchOptionalService(ctx, 'llm')
  const companion = createDreamCompanion({ ...config, getLlm: () => llm.refresh() })
  ctx.effect(() => () => companion.close())
  ctx.provide(SUPER_AGENT_DREAM_SERVICE, companion.bridge)
  ctx.provide(SUPER_AGENT_DREAM_ISOLATION_SERVICE, companion.isolation)
}
