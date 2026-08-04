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

export const NARROW = '(max-width: 900px)'
