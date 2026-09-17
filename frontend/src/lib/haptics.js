/* Best-effort touch feedback for browsers that expose the Vibration API.
 * iOS Safari currently has no standard navigator.vibrate implementation, so
 * every call safely becomes a no-op there — and we fall back to a short CSS
 * press class on the nearest interactive control so the tap still feels physical.
 * Respect coarse pointers and the user's reduced-motion preference so desktop
 * and accessibility settings stay quiet. */
const PATTERNS = Object.freeze({
  light: 8,
  selection: 12,
  medium: 18,
})

const PRESS_SELECTOR = '.fa-press, .btn, .btn-icon, .mobile-tab-item, button, [role="button"]'

function preferQuietMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function preferCoarsePointer() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(pointer: coarse)').matches
}

function pulsePressVisual(target) {
  if (!target || preferQuietMotion()) return
  const el = typeof target.closest === 'function' ? target.closest(PRESS_SELECTOR) : null
  if (!el) return
  el.classList.add('is-pressed')
  window.setTimeout(() => el.classList.remove('is-pressed'), 120)
}

/** Install once at app boot. Gives every primary control a tactile press
 *  flash on touch devices even when navigator.vibrate is unavailable (iOS). */
export function installPressFeedback() {
  if (typeof document === 'undefined' || installPressFeedback.installed) return
  installPressFeedback.installed = true
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'mouse' && !preferCoarsePointer()) return
      pulsePressVisual(event.target)
    },
    { passive: true },
  )
}

export function haptic(kind = 'light', eventOrTarget) {
  const target = eventOrTarget?.currentTarget || eventOrTarget?.target || eventOrTarget || null
  if (preferQuietMotion()) return false
  if (preferCoarsePointer()) pulsePressVisual(target)

  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false
  if (!preferCoarsePointer()) return false

  try {
    return navigator.vibrate(PATTERNS[kind] ?? PATTERNS.light)
  } catch {
    // Some embedded browsers expose the method but reject vibration at runtime.
    return false
  }
}
