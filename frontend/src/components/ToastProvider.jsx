import { useCallback, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { ToastContext } from '../lib/toastContext'

/* Replaces four alert() calls. alert() blocks the page, can't carry a hint, and
   is invisible to a screen reader until dismissed — this region is a live region
   instead. */

let seq = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const push = useCallback(
    (toast) => {
      const id = ++seq
      const entry = { id, tone: 'info', ttl: 6000, ...toast }
      setToasts((t) => [...t, entry])
      if (entry.ttl) setTimeout(() => dismiss(id), entry.ttl)
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
    }),
    [push, dismiss]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast is-${t.tone}`}>
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.detail ? <small>{t.detail}</small> : null}
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
        ))}
      </div>
    </ToastContext.Provider>
  )
}
