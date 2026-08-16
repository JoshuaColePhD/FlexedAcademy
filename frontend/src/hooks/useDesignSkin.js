import { useCallback, useEffect, useState } from 'react'

const KEY = 'aplang.skin'
const SKINS = ['neo', 'skeu']

/* Same shape as useTheme.js (persist to localStorage, write a data-*
 * attribute onto <html>, one hook owns the read/write so nothing can drift)
 * for the neomorphic-vs-skeuomorphic toggle Josh asked for after the
 * sign-in form's contrast problems traced back to .neo-world's own soft
 * shadows. Only two states — no "system" equivalent exists for a design
 * skin the way it does for light/dark, so this is simpler than useTheme,
 * not a subset of it. */
function readSkin() {
  try {
    const saved = localStorage.getItem(KEY)
    return SKINS.includes(saved) ? saved : 'neo'
  } catch {
    return 'neo'
  }
}

export function useDesignSkin() {
  const [skin, setSkinState] = useState(readSkin)

  useEffect(() => {
    document.documentElement.setAttribute('data-skin', skin)
    try {
      localStorage.setItem(KEY, skin)
    } catch {
      // Private browsing — the choice just won't persist.
    }
  }, [skin])

  const setSkin = useCallback((next) => {
    if (SKINS.includes(next)) setSkinState(next)
  }, [])

  const toggle = useCallback(() => {
    setSkinState((s) => (s === 'neo' ? 'skeu' : 'neo'))
  }, [])

  return { skin, setSkin, toggle }
}
