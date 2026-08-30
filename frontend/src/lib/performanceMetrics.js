/* Lightweight browser timing markers for the Performance panel.
 *
 * These deliberately do not log on every token. The marks are cheap in
 * production, invisible to the UI, and can be inspected in Chrome's
 * Performance/measurements view when diagnosing a slow turn.
 */
const PREFIX = 'flexed-academy:'

const fullName = (name) => `${PREFIX}${name}`

const diagnosticLimit = 120

/* A small, opt-in field notebook for the exact class of bugs that feels like
 * “I clicked it and nothing happened.” Enable with
 * `window.__FLEXED_PERF_DEBUG__ = true` before reload. It records slow
 * interactions and long tasks without shipping teacher content or adding a
 * dependency; Chrome DevTools can then show whether the delay was input,
 * JavaScript, or presentation work. */
export function installBrowserDiagnostics() {
  if (typeof window === 'undefined' || !window.__FLEXED_PERF_DEBUG__ || !window.PerformanceObserver) return
  if (window.__flexedPerformanceDiagnostics) return

  const entries = []
  const vitals = {}
  const push = (entry) => {
    entries.push({ ...entry, at: Math.round(performance.now()) })
    if (entries.length > diagnosticLimit) entries.shift()
  }
  const observers = []
  const supported = PerformanceObserver.supportedEntryTypes || []

  if (supported.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => push({ type: 'longtask', duration: Math.round(entry.duration) }))
    })
    observer.observe({ type: 'longtask', buffered: true })
    observers.push(observer)
  }
  if (supported.includes('event')) {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (entry.duration >= 200) {
          push({
            type: 'interaction',
            name: entry.name,
            duration: Math.round(entry.duration),
            inputDelay: Math.round(entry.processingStart - entry.startTime),
            processing: Math.round(entry.processingEnd - entry.processingStart),
            presentation: Math.round(entry.duration - (entry.processingEnd - entry.startTime)),
          })
        }
      })
    })
    observer.observe({ type: 'event', buffered: true, durationThreshold: 16 })
    observers.push(observer)
  }

  /* Buffered browser signals make the same “feels sticky” report measurable:
   * FCP/LCP describe visual readiness, layout shift catches panels jumping
   * under a click, and interaction entries expose input delay/processing.
   * This stays opt-in with the rest of the notebook and never records text. */
  if (supported.includes('paint')) {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (entry.name === 'first-contentful-paint') vitals.fcp = Math.round(entry.startTime)
      })
    })
    observer.observe({ type: 'paint', buffered: true })
    observers.push(observer)
  }
  if (supported.includes('largest-contentful-paint')) {
    const observer = new PerformanceObserver((list) => {
      const last = list.getEntries().at(-1)
      if (last) vitals.lcp = Math.round(last.startTime)
    })
    observer.observe({ type: 'largest-contentful-paint', buffered: true })
    observers.push(observer)
  }
  if (supported.includes('layout-shift')) {
    const observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((entry) => {
        if (!entry.hadRecentInput) vitals.cls = Math.round(((vitals.cls || 0) + entry.value) * 1000) / 1000
      })
    })
    observer.observe({ type: 'layout-shift', buffered: true })
    observers.push(observer)
  }

  window.__flexedPerformanceDiagnostics = {
    entries,
    vitals,
    snapshot: () => ({ entries: [...entries], vitals: { ...vitals } }),
    clear: () => entries.splice(0, entries.length),
    disconnect: () => observers.forEach((observer) => observer.disconnect()),
  }
}

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
