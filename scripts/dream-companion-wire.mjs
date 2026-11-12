/** A bounded JSON-lines protocol for the companion's inherited file descriptors. */
export const MAX_FRAME_BYTES = 32 * 1024

export function encodeFrame(value) {
  const line = JSON.stringify(value)
  if (typeof line !== 'string' || Buffer.byteLength(line) > MAX_FRAME_BYTES) throw Error('dream-companion-frame-too-large')
  return line + '\n'
}

export function readFrames(stream, onFrame, onEnd, onFailure) {
  let pending = Buffer.alloc(0), stopped = false
  const fail = () => {
    if (!stopped) { stopped = true; onFailure(Error('dream-companion-invalid-frame')) }
  }
  stream.on('data', data => {
    if (stopped) return
    pending = Buffer.concat([pending, data])
    try {
      for (;;) {
        const at = pending.indexOf(10)
        if (at < 0) {
          if (pending.length > MAX_FRAME_BYTES) fail()
          return
        }
        if (at === 0 || at > MAX_FRAME_BYTES) return fail()
        const raw = pending.subarray(0, at).toString('utf8')
        pending = pending.subarray(at + 1)
        onFrame(JSON.parse(raw))
        if (stopped) return
      }
    } catch { fail() }
  })
  stream.on('end', () => {
    if (stopped) return
    if (pending.length) fail()
    else { stopped = true; onEnd() }
  })
  stream.on('error', fail)
}
