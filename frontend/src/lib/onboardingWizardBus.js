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
