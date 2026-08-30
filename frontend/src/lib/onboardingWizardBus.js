/* A one-function pub/sub so SettingsPage's "Take the tour again" link can
 * reopen OnboardingWizard.jsx (mounted up in AppShell.jsx) without either
 * one needing to sit in the same component tree, hold shared state, or pass
 * a callback down through props that would otherwise thread through several
 * unrelated layers. A CustomEvent on `window` rather than a new React
 * context: this is a single fire-and-forget "open it" signal, not state
 * anything needs to read continuously.
 */
const EVENT = 'aplang:open-onboarding-wizard'

export function openOnboardingWizard() {
  window.dispatchEvent(new CustomEvent(EVENT))
}

export function onOpenOnboardingWizard(handler) {
  window.addEventListener(EVENT, handler)
  return () => window.removeEventListener(EVENT, handler)
}

/* "This teacher tried to leave onboarding and the server wouldn't record it."
 *
 * finish() marks onboarding seen server-side, and ClassRoutes (App.jsx) sends
 * any account without onboarding_seen_at straight back to the wizard. When
 * that PATCH failed the error was swallowed and the wizard closed anyway, so
 * the redirect fired immediately and put them right back — including from the
 * X, which is also finish(). Offline or a 500 meant no way into the app at
 * all, while the code comment claimed the worst case was "the wizard offers
 * itself again next login."
 *
 * This flag makes that comment true. It is deliberately sessionStorage, not
 * localStorage: skipping is a concession for THIS visit only, so the wizard
 * really does come back next time rather than being permanently dismissed by
 * a transient network failure. Nothing here grants access — ClassRoutes still
 * requires a real account; it only stops a bookkeeping write nobody can
 * retry from holding the app hostage.
 */
const DEFERRED_KEY = 'aplang:onboardingDeferred'

function keyFor(accountId) {
  return accountId ? `${DEFERRED_KEY}:${encodeURIComponent(String(accountId))}` : null
}

export function deferOnboarding(accountId) {
  const key = keyFor(accountId)
  if (!key) return
  try {
    sessionStorage.setItem(key, '1')
  } catch {
    /* Private mode with storage disabled. The teacher is no worse off than
       before this existed, and the toast still explains what happened. */
  }
}

export function onboardingDeferred(accountId) {
  const key = keyFor(accountId)
  if (!key) return false
  try {
    return sessionStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
