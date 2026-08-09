import { useEffect, useState } from 'react'

/* Every overlay in this app animated IN and vanished instantly on close —
 * conditional render unmounts the DOM node the instant `open` goes false,
 * which is before a CSS animation has any node left to play on. Entrances
 * felt considered; exits felt like a bug. This keeps the node mounted for
 * one more tick — long enough to play a mirrored exit animation — then lets
 * it go.
 *
 * `duration` should match the exit keyframe's own duration (ms), not the
 * entrance's — the two are allowed to differ, but they usually don't.
 */
export function useExitTransition(open, duration = 220) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return undefined
    }
    if (!mounted) return undefined
    setClosing(true)
    const t = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, duration)
    return () => clearTimeout(t)
    // `mounted` intentionally excluded — including it re-runs this effect the
    // moment the timeout above sets it false, which would immediately re-fire
    // the same close logic against a node that's already gone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, duration])

  return { mounted, closing }
}
