/* One small bridge between navigation and the browser's native View
 * Transition API. Modern browsers can capture the old and new page as one
 * scene; browsers without it simply use React Router's existing motion
 * fallback. This helper owns no router state, so it is safe to use from the
 * public landing page and the auth layout alike. */
export function runViewTransition(update) {
  if (typeof update !== 'function') return undefined

  const reduced = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const start = typeof document !== 'undefined' ? document.startViewTransition : undefined

  if (reduced || typeof start !== 'function') return update()

  try {
    const transition = start.call(document, update)
    // A cancelled transition must never turn a successful navigation into an
    // unhandled rejection.
    transition?.finished?.catch(() => {})
    return transition
  } catch {
    // Another transition may own the document after a rapid second click. The
    // route is more important than the effect, so complete it plainly.
    return update()
  }
}

export function handleViewTransitionNavigation(event, navigate, to) {
  // Preserve Cmd/Ctrl-click, middle-click, and alternate targets exactly like
  // a normal Link. Only a plain primary click becomes an in-place transition.
  if (
    event.defaultPrevented
    || event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
  ) return

  event.preventDefault()
  runViewTransition(() => navigate(to))
}
