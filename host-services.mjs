/** Public active-service lookup, with an older-host/test-context compatibility path. */
export function optionalService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
    if (typeof ctx?.reflect?.get === 'function') return ctx.reflect.get(name)
    return ctx?.[name]
  } catch { return undefined }
}
