/** Owns the host-local idle timer. Shared dispatch ownership belongs to the queue. */
export function createDreamScheduler({
  idleMs,
  run,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
}) {
  if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw Error('dream-invalid-idle')
  let lastActivity = now()
  const foreground = new Set()
  let timer, active, stopped = false, pending = false

  function disarm() {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
  }

  function arm(notBefore = 0) {
    disarm()
    if (stopped || active || foreground.size) return
    const delay = Math.max(0, lastActivity + idleMs - now(), notBefore - now())
    timer = setTimer(start, Math.min(delay, 2 ** 31 - 1))
    timer?.unref?.()
  }

  async function start() {
    timer = undefined
    if (stopped || active || foreground.size) return
    if (now() < lastActivity + idleMs) { arm(); return }
    const attempt = new AbortController()
    active = attempt
    pending = false
    let nextAt
    try {
      const result = await run({ signal: attempt.signal })
      nextAt = result?.nextAt
    } catch (error) {
      if (!attempt.signal.aborted) onError(error)
    } finally {
      active = undefined
      if (pending || attempt.signal.aborted) arm()
      else if (Number.isSafeInteger(nextAt) && nextAt > now()) arm(nextAt)
    }
  }

  function activity() {
    if (stopped) return
    lastActivity = now()
    active?.abort(new Error('dream-foreground-resumed'))
    arm()
  }

  arm()
  return {
    activity,
    enter(id) { if (!stopped) { foreground.add(id); activity() } },
    leave(id) { if (!stopped && foreground.delete(id)) activity() },
    wake() {
      if (stopped) return
      pending = true
      arm()
    },
    status() {
      return {
        foreground: foreground.size,
        running: Boolean(active),
        idleAt: lastActivity + idleMs,
      }
    },
    dispose() {
      stopped = true
      disarm()
      active?.abort(new Error('dream-host-stopping'))
      foreground.clear()
    },
  }
}
