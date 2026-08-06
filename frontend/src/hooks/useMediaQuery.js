import { useEffect, useState } from 'react'
import { COARSE, atLeast, below, between } from '../lib/breakpoints'

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

/* Every number below comes from lib/breakpoints.js, which tailwind.config.js
   also reads. There is no second copy to keep in step any more. */

/** Below this the sidebar is a drawer, not a dock. */
export const NARROW = below('lg')

/** Below this the artifact cannot sit beside the plan; it overlays. */
export const PANEL_OVERLAY = below('xl')

/** The review/author line. Below it a teacher reads a plan; they don't build one. */
export const PHONE = below('md')

export const TOUCH = COARSE

/** 'phone' | 'tablet' | 'desktop'.
 *
 *  One decision, read everywhere — instead of four components each asking a
 *  slightly different question about the same screen and disagreeing at the
 *  edges. Components that need a layout branch should use this; the raw
 *  constants above are for the two overlay decisions that are genuinely about
 *  a specific piece of chrome. */
export function useLayoutMode() {
  const phone = useMediaQuery(below('md'))
  const tablet = useMediaQuery(between('md', 'lg'))
  return phone ? 'phone' : tablet ? 'tablet' : 'desktop'
}

export { atLeast, below, between }
