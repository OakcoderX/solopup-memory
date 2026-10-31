/** Synchronous Standard Schema V1, consumed by Cordis without a second runtime. */
export const DEFAULT_AUTO_CAPTURE = Object.freeze({ enabled: true, everyTurns: 4, maxEntries: 3, maxTokens: 800, maxInputBytes: 24 * 1024, timeoutMs: 25000 })
const integers = { everyTurns: [1, 1000], maxEntries: [1, 10], maxTokens: [1, 8192], maxInputBytes: [1024, 64 * 1024], timeoutMs: [1, 120000] }
const keys = new Set([...Object.keys(DEFAULT_AUTO_CAPTURE), 'provider', 'model'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

function validate(input) {
  if (input === undefined) input = {}
  const issues = []
  const issue = (field, message) => issues.push({ message, path: field ? ['autoCapture', field] : [] })
  if (!object(input)) return { issues: [{ message: 'Plugin configuration must be an object.' }] }
  if (Object.keys(input).some(key => key !== 'autoCapture')) issue(undefined, 'Unknown plugin configuration field.')
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
  if (issues.length) return { issues }
  const supplied = Object.fromEntries(Object.entries(provided).filter(([, value]) => value !== undefined))
  return { value: { autoCapture: { ...DEFAULT_AUTO_CAPTURE, ...supplied, ...(routed ? { provider: provided.provider.trim(), model: provided.model.trim() } : {}) } } }
}

export const Config = Object.freeze({ '~standard': Object.freeze({ version: 1, vendor: 'dsh-memory', validate }) })
export function normalizePluginConfig(input = {}) {
  const result = validate(input)
  if (result.issues) throw new Error('memory-invalid-config:' + (result.issues[0].path?.join('.') || 'root'))
  return result.value
}
