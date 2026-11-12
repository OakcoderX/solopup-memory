/** Synchronous Standard Schema V1, consumed by Cordis without a second runtime. */
import { dirname, isAbsolute, resolve } from 'node:path'

export const DEFAULT_AUTO_CAPTURE = Object.freeze({ enabled: true, everyTurns: 4, maxEntries: 3, maxTokens: 800, maxInputBytes: 24 * 1024, timeoutMs: 25000 })
export const DEFAULT_DREAM = Object.freeze({
  enabled: false, projects: Object.freeze([]), idleMs: 20 * 60_000,
  timeoutMs: 180_000, maxDailyAttempts: 2, maxDailyTokens: 12_000,
})
const dreamLimits = {
  idleMs: [1_000, 7 * 86_400_000], timeoutMs: [1_000, 180_000],
  maxDailyAttempts: [1, 10], maxDailyTokens: [2_000, 60_000],
}
const dreamKeys = new Set([...Object.keys(DEFAULT_DREAM), 'provider', 'model'])
const integers = { everyTurns: [1, 1000], maxEntries: [1, 10], maxTokens: [1, 8192], maxInputBytes: [1024, 64 * 1024], timeoutMs: [1, 120000] }
const keys = new Set([...Object.keys(DEFAULT_AUTO_CAPTURE), 'provider', 'model'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function validate(input) {
  if (input === undefined) input = {}
  const issues = []
  const issue = (field, message) => issues.push({ message, path: field ? ['autoCapture', field] : [] })
  if (!object(input)) return { issues: [{ message: 'Plugin configuration must be an object.' }] }
  if (Object.keys(input).some(key => key !== 'autoCapture' && key !== 'dream')) issue(undefined, 'Unknown plugin configuration field.')
  const provided = input.autoCapture === undefined ? {} : input.autoCapture
  if (!object(provided)) return { issues: [...issues, { message: 'autoCapture must be an object.', path: ['autoCapture'] }] }
  if (Object.keys(provided).some(key => !keys.has(key))) issue(undefined, 'Unknown autoCapture configuration field.')
  if (provided.enabled !== undefined && typeof provided.enabled !== 'boolean') issue('enabled', 'enabled must be a boolean.')
  for (const [key, [min, max]] of Object.entries(integers)) {
    if (provided[key] !== undefined && (!Number.isSafeInteger(provided[key]) || provided[key] < min || provided[key] > max)) issue(key, `${key} must be an integer between ${min} and ${max}.`)
  }
  const routed = provided.provider !== undefined || provided.model !== undefined
  if (routed) for (const key of ['provider', 'model']) {
    if (typeof provided[key] !== 'string' || !provided[key].trim() || provided[key].length > 250) issue(key, `${key} must be a nonempty string of at most 250 characters; provider and model must be supplied together.`)
  }
  const dream = input.dream === undefined ? {} : input.dream
  const dreamIssue = (field, message) => issues.push({ message, path: field ? ['dream', field] : ['dream'] })
  if (!object(dream)) return { issues: [...issues, { message: 'Dream configuration must be an object.', path: ['dream'] }] }
  if (Object.keys(dream).some(key => !dreamKeys.has(key))) dreamIssue(undefined, 'Unknown dream configuration field.')
  if (dream.enabled !== undefined && typeof dream.enabled !== 'boolean') dreamIssue('enabled', 'enabled must be a boolean.')
  for (const [key, [min, max]] of Object.entries(dreamLimits)) {
    if (dream[key] !== undefined && (!Number.isSafeInteger(dream[key]) || dream[key] < min || dream[key] > max)) {
      dreamIssue(key, `${key} must be an integer between ${min} and ${max}.`)
    }
  }
  const projects = dream.projects === undefined ? [] : dream.projects
  if (!Array.isArray(projects) || projects.length > 16 || projects.some(path =>
    typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f]/.test(path) || resolve(path) === dirname(resolve(path))
  ) || new Set(projects.map(path => resolve(path))).size !== projects.length) {
    dreamIssue('projects', 'projects must contain at most 16 distinct absolute project directories.')
  } else if (dream.enabled && !projects.length) dreamIssue('projects', 'Choose at least one project before enabling dream.')
  const dreamRoute = dream.provider !== undefined || dream.model !== undefined || dream.enabled === true
  if (dreamRoute) for (const key of ['provider', 'model']) {
    if (typeof dream[key] !== 'string' || !dream[key].trim() || dream[key].length > 250 || /[\x00-\x1f]/.test(dream[key])) {
      dreamIssue(key, 'provider and model must be supplied together when dream is enabled.')
    }
  }
  if (issues.length) return { issues }
  const supplied = Object.fromEntries(Object.entries(provided).filter(([, value]) => value !== undefined))
  const dreamSupplied = Object.fromEntries(Object.entries(dream).filter(([, value]) => value !== undefined))
  return { value: {
    autoCapture: { ...DEFAULT_AUTO_CAPTURE, ...supplied, ...(routed ? { provider: provided.provider.trim(), model: provided.model.trim() } : {}) },
    dream: { ...DEFAULT_DREAM, ...dreamSupplied, projects: projects.map(path => resolve(path)), ...(dreamRoute ? { provider: dream.provider.trim(), model: dream.model.trim() } : {}) },
  } }
}

export const Config = Object.freeze({ '~standard': Object.freeze({ version: 1, vendor: 'dsh-memory', validate }) })
export function normalizePluginConfig(input = {}) {
  const result = validate(input)
  if (result.issues) throw new Error('memory-invalid-config:' + (result.issues[0].path?.join('.') || 'root'))
  return result.value
}
