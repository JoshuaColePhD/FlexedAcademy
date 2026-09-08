/* Best-effort touch feedback for browsers that expose the Vibration API.
 * iOS Safari currently has no standard navigator.vibrate implementation, so
 * every call safely becomes a no-op there. Respect coarse pointers and the
 * user's reduced-motion preference so desktop and accessibility settings stay
 * quiet. */
const PATTERNS = Object.freeze({
  light: 8,
  selection: 12,
  medium: 18,
})

export function haptic(kind = 'light') {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return false
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (!window.matchMedia('(pointer: coarse)').matches) return false
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  }

  try {
    return navigator.vibrate(PATTERNS[kind] ?? PATTERNS.light)
  } catch {
    // Some embedded browsers expose the method but reject vibration at runtime.
    return false
  }
}
