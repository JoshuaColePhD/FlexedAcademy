/* Lightweight browser timing markers for the Performance panel.
 *
 * These deliberately do not log on every token. The marks are cheap in
 * production, invisible to the UI, and can be inspected in Chrome's
 * Performance/measurements view when diagnosing a slow turn.
 */
const PREFIX = 'flexed-academy:'

const fullName = (name) => `${PREFIX}${name}`

export function mark(name) {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  try {
    performance.mark(fullName(name))
  } catch {
    // Performance instrumentation must never affect a lesson-plan request.
  }
}

export function measure(name, start, end) {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return
  try {
    performance.measure(fullName(name), fullName(start), fullName(end))
  } catch {
    // A missing mark (for example after a browser clears its buffer) is fine.
  }
}
