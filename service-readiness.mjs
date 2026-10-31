/** Observe optional active services through their owning Cordis lifecycle. */
import { optionalService } from './host-services.mjs'

export function watchOptionalService(ctx, name, changed = () => {}) {
  const managed = typeof ctx?.inject === 'function'
  let stopped = false, owner, controller = new AbortController()
  let state = { value: undefined, generation: 0, signal: controller.signal }
  function update(value, nextOwner) {
    if (state.value === value && owner === nextOwner) return
    controller.abort()
    controller = new AbortController(); owner = nextOwner
    state = { value, generation: state.generation + 1, signal: controller.signal }
    changed(state)
  }
  const tracker = {
    current: () => state,
    refresh() {
      if (!stopped && !managed) update(optionalService(ctx, name), undefined)
      return state
    },
  }
  ctx.effect?.(() => () => {
    stopped = true; update(undefined, undefined); controller.abort()
  })
  if (managed) {
    ctx.inject([name], child => {
      if (stopped) return
      const token = Symbol(name), value = optionalService(child, name)
      update(value, token)
      child.effect(() => () => { if (owner === token) update(undefined, undefined) })
    })
  } else tracker.refresh()
  return tracker
}
