import { useEffect, useState } from 'react'

/** Reactive media query, so layout decisions don't get made once at mount from a
 *  stale window.innerWidth. */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? false)

  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = (e) => setMatches(e.matches)
    setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/* Both of these are duplicated in components.css — NARROW at the `.sidebar`
   drawer block, PANEL_OVERLAY at the `.artifact-panel` absolute-position block.
   Keep them in step: the JS decides whether to trap focus, the CSS decides
   whether the thing is actually covering the page, and they must agree. */
export const NARROW = '(max-width: 900px)'
export const PANEL_OVERLAY = '(max-width: 1180px)'
