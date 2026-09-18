/* Release streamed text at a steady rate instead of in network-shaped bursts.
 *
 * rAF coalescing already caps updates at one per frame, but the text still
 * arrives the way the network delivered it: a 200-character burst lands in one
 * frame, then three frames show nothing. The eye reads that as stuttering, and
 * it is a large part of why this felt mechanical next to ChatGPT and Claude.
 *
 * This sits between the accumulated text and what the transcript renders.
 * `accumulated` itself is deliberately untouched, because three callers need it
 * immediately: voice's sentence cutter (spoken latency is the whole product
 * there), the first-token perf mark (which must stay a true network TTFT), and
 * the truncation/recovery logic at the end of a stream.
 *
 * The rate is proportional to the backlog, so it self-tunes: a small backlog
 * drains in a frame or two and feels instant, while a large one still clears in
 * about a quarter second rather than dribbling out.
 */

const DIVISOR = 7 // characters per frame = backlog / DIVISOR
const MIN_CHARS = 2 // so a tiny backlog still finishes promptly

export function createSmoother({
  onFrame,
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
} = {}) {
  let target = ''
  let shown = 0
  let frame = null

  const stop = () => {
    if (frame != null) caf(frame)
    frame = null
  }

  const tick = () => {
    frame = null
    const backlog = target.length - shown
    if (backlog <= 0) return
    const step = Math.max(MIN_CHARS, Math.ceil(backlog / DIVISOR))
    shown = Math.min(target.length, shown + step)
    onFrame(target.slice(0, shown))
    if (shown < target.length) schedule()
  }

  const schedule = () => {
    if (frame != null) return
    frame = raf(tick)
  }

  return {
    /** The full accumulated text so far. */
    push(full) {
      target = full || ''
      // A caller that resets (a retry clearing the transcript) must not have
      // the old position carried forward onto shorter text.
      if (shown > target.length) shown = 0
      if (shown < target.length) schedule()
    },
    /** The network is finished, so show everything.
     *
     * Deliberately not a slower drain: the turn settles from the full reply a
     * moment later regardless, so animating past the end of the stream would
     * only risk the settle overtaking the animation and snapping anyway. The
     * smoothing is for the wait, not for the ending.
     */
    flush() {
      stop()
      shown = target.length
      onFrame(target)
    },
    /** Aborted: drop everything pending so a queued frame cannot resurrect it. */
    cancel() {
      stop()
      target = ''
      shown = 0
    },
  }
}

export default createSmoother
