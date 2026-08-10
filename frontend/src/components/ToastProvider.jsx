import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import { ToastContext } from '../lib/toastContext'
import { errorParts } from '../lib/apiError'

/* Replaces four alert() calls. alert() blocks the page, can't carry a hint, and
   is invisible to a screen reader until dismissed — this region is a live region
   instead.

   Two live regions, not one: an error needs to interrupt, a "Saved" does not.
   They share the visual column but sit in separate role/aria-live containers. */

let seq = 0

// Enough to see a burst, few enough that they don't cover the app. A dead
// backend can fire the same error from several effects at once.
const MAX_TOASTS = 4
const DEDUPE_MS = 2000

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timersRef = useRef(new Map())
  /* Same reasoning as ConfirmProvider: this sits above <Gate/>, so a toast is
     AppShell's sibling, not its descendant, and never sees .neo-world's
     redeclared tokens on its own. Scope by route to the same /c/* boundary
     AppShell itself uses. */
  const location = useLocation()
  const isNeo = location.pathname.startsWith('/c/')

  const dismiss = useCallback((id) => {
    const t = timersRef.current.get(id)
    if (t) {
      clearTimeout(t)
      timersRef.current.delete(id)
    }
    setToasts((list) => list.filter((x) => x.id !== id))
  }, [])

  // Otherwise a pending ttl fires into an unmounted tree.
  useEffect(
    () => () => {
      timersRef.current.forEach((t) => clearTimeout(t))
      timersRef.current.clear()
    },
    []
  )

  const push = useCallback(
    (toast) => {
      const id = ++seq
      const entry = { id, tone: 'info', ttl: 6000, at: Date.now(), ...toast }

      setToasts((list) => {
        // Collapse an identical toast fired moments ago rather than stacking it.
        const dupe = list.find(
          (x) =>
            x.tone === entry.tone &&
            x.title === entry.title &&
            x.detail === entry.detail &&
            entry.at - x.at < DEDUPE_MS
        )
        if (dupe) return list
        return [...list, entry].slice(-MAX_TOASTS)
      })

      if (entry.ttl) {
        timersRef.current.set(
          id,
          setTimeout(() => dismiss(id), entry.ttl)
        )
      }
      return id
    },
    [dismiss]
  )

  const value = useMemo(
    () => ({
      push,
      dismiss,
      error: (title, detail) => push({ tone: 'error', title, detail, ttl: 10000 }),
      success: (title, detail) => push({ tone: 'success', title, detail, ttl: 4000 }),
      info: (title, detail) => push({ tone: 'info', title, detail }),
      /* The one way to report a thrown API error.
         Every previous site did `toast.error(title, err.message)` by hand, and
         six of them silently lost the backend's `hint` — the part that tells the
         teacher what to do. Going through here means the hint can't be forgotten,
         because nobody has to remember it. */
      apiError: (title, err, fallback) => {
        const { message, hint } = errorParts(err, fallback)
        return push({ tone: 'error', title, detail: message, hint, ttl: 12000 })
      },
    }),
    [push, dismiss]
  )

  const errors = toasts.filter((t) => t.tone === 'error')
  const others = toasts.filter((t) => t.tone !== 'error')

  const renderToast = (t) => (
    <div key={t.id} className={`toast is-${t.tone}${isNeo ? ' neo-world' : ''}`}>
      <div className="toast-body">
        <strong>{t.title}</strong>
        {t.detail ? <small>{t.detail}</small> : null}
        {/* The backend's actionable half — "Start it with ./run.sh". */}
        {t.hint ? <small className="toast-hint">{t.hint}</small> : null}
      </div>
      <button
        type="button"
        className="btn-icon"
        onClick={() => dismiss(t.id)}
        aria-label={`Dismiss: ${t.title}`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {/* Errors interrupt; everything else waits its turn. */}
        <div className="toast-region" role="alert" aria-live="assertive">
          {errors.map(renderToast)}
        </div>
        <div className="toast-region" role="region" aria-label="Notifications" aria-live="polite">
          {others.map(renderToast)}
        </div>
      </div>
    </ToastContext.Provider>
  )
}
