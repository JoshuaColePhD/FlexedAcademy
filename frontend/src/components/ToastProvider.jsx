import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import { ToastContext } from '../lib/toastContext'
import { errorParts } from '../lib/apiError'
import { useExitTransition } from '../hooks/useExitTransition'

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

/* One toast's own mount lifecycle. Entrance already animated (toast-in, see
 * base.css); dismiss used to just splice the toast out of state and vanish
 * — an entrance with no matching exit. `toast.closing` (set by
 * ToastProvider's dismiss()) is this component's own `open` signal to
 * useExitTransition; once the fade finishes, onExited tells the parent to
 * actually remove it from state. Until then the toast stays mounted,
 * playing toast-out. */
function Toast({ toast: t, isNeo, onDismiss, onExited }) {
  const { mounted, closing } = useExitTransition(!t.closing, 220)

  useEffect(() => {
    if (!mounted) onExited(t.id)
  }, [mounted, onExited, t.id])

  if (!mounted) return null

  return (
    <div className={`toast is-${t.tone}${isNeo ? ' neo-world' : ''}${closing ? ' is-closing' : ''}`}>
      <div className="toast-body">
        <strong>{t.title}</strong>
        {t.detail ? <small>{t.detail}</small> : null}
        {/* The backend's actionable half — "Start it with ./run.sh". */}
        {t.hint ? <small className="toast-hint">{t.hint}</small> : null}
        {t.action ? (
          <button
            type="button"
            className="mt-2 block text-xs font-semibold text-accent-text hover:text-accent-hover"
            onClick={() => {
              t.action.onClick()
              onDismiss(t.id)
            }}
          >
            {t.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="btn-icon"
        onClick={() => onDismiss(t.id)}
        aria-label={`Dismiss: ${t.title}`}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timersRef = useRef(new Map())
  /* Same reasoning as ConfirmProvider: this sits above <Gate/>, so a toast is
     AppShell's sibling, not its descendant, and never sees .neo-world's
     redeclared tokens on its own. Scope by route to the same /c/* boundary
     AppShell itself uses. */
  const location = useLocation()
  const isNeo = location.pathname.startsWith('/c/')

  // Marks a toast as leaving rather than removing it outright — Toast's own
  // useExitTransition needs the node to stay mounted long enough to play
  // toast-out. reallyRemove (passed to Toast as onExited) is what actually
  // takes it out of state, once that animation has finished.
  const dismiss = useCallback((id) => {
    const t = timersRef.current.get(id)
    if (t) {
      clearTimeout(t)
      timersRef.current.delete(id)
    }
    setToasts((list) => list.map((x) => (x.id === id ? { ...x, closing: true } : x)))
  }, [])

  const reallyRemove = useCallback((id) => {
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
      success: (title, detail, action) => push({ tone: 'success', title, detail, action, ttl: action ? 8000 : 4000 }),
      info: (title, detail, action) => push({ tone: 'info', title, detail, action, ttl: action ? 8000 : 4000 }),
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
    <Toast key={t.id} toast={t} isNeo={isNeo} onDismiss={dismiss} onExited={reallyRemove} />
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
