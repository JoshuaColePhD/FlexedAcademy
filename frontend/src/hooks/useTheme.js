import { useCallback, useEffect, useState } from 'react'

const KEY = 'aplang.theme'
const MODES = ['light', 'dark', 'system']

function systemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readMode() {
  try {
    const saved = localStorage.getItem(KEY)
    return MODES.includes(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

/** Resolves "system" itself and always writes a concrete data-theme onto <html>,
 *  so the CSS needs exactly one dark selector instead of duplicating every value
 *  across a prefers-color-scheme media query. */
export function useTheme() {
  const [mode, updateMode] = useState(readMode)
  const [resolved, setResolved] = useState(() =>
    readMode() === 'system' ? systemTheme() : readMode()
  )

  useEffect(() => {
    const apply = () => {
      const next = mode === 'system' ? systemTheme() : mode
      setResolved(next)
      document.documentElement.setAttribute('data-theme', next)
      // Keep the iOS status bar / Android URL bar in step. index.html's
      // pre-paint script sets this once; without updating it here, toggling to
      // dark leaves a white bar above a dark app. Literal hex because a meta
      // tag cannot read a custom property — these are --paper-rgb in tokens.css.
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', next === 'dark' ? '#171719' : '#f7f7f8')
    }
    apply()

    if (mode !== 'system') return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [mode])

  useEffect(() => {
    const sync = (event) => {
      if (event.type === 'storage' && event.key !== KEY && event.key !== null) return
      updateMode(event.detail || readMode())
    }
    window.addEventListener('storage', sync)
    window.addEventListener('flexed-theme', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('flexed-theme', sync)
    }
  }, [])

  const setMode = useCallback((next) => {
    if (!MODES.includes(next)) return
    try { localStorage.setItem(KEY, next) } catch { /* Session-only preference. */ }
    updateMode(next)
    window.dispatchEvent(new CustomEvent('flexed-theme', { detail: next }))
  }, [])

  const cycle = useCallback(() => {
    setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length])
  }, [mode, setMode])

  return { mode, resolved, setMode, cycle }
}
