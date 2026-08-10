import { useCallback, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ConfirmContext } from '../lib/confirmContext'
import { useFocusTrap } from '../hooks/useFocusTrap'

/* Replaces the two native confirm() calls, which couldn't be styled, couldn't
   carry a hint, and looked like a browser error rather than part of the app.

   Usage:
     const confirm = useConfirm()
     if (!(await confirm({ title: 'Delete “Week 3”?', confirmLabel: 'Delete' })) ) return
*/

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null)
  const resolveRef = useRef(null)
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)
  /* ConfirmProvider sits above <Gate/> (see App.jsx) so its dialog renders as
     AppShell's SIBLING, not its descendant — .neo-world's redeclared tokens
     live on AppShell's own root and never reach a sibling subtree no matter
     how deep. Reading the route here is the cheapest way to know which world
     this particular confirm() call belongs to: /c/* is everything AppShell
     wraps (the authenticated app), matching the scope neo-world already
     committed to — landing/login/admin dialogs stay in the plain palette. */
  const location = useLocation()
  const isNeo = location.pathname.startsWith('/c/')

  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        resolveRef.current = resolve
        setRequest({
          title: 'Are you sure?',
          body: '',
          confirmLabel: 'Confirm',
          cancelLabel: 'Cancel',
          tone: 'default',
          ...opts,
        })
      }),
    []
  )

  const settle = useCallback((answer) => {
    setRequest(null)
    const resolve = resolveRef.current
    resolveRef.current = null
    resolve?.(answer)
  }, [])

  // Initial focus on Cancel: for a destructive prompt the safe option should be
  // the one an Enter keypress hits.
  useFocusTrap(dialogRef, {
    active: !!request,
    trap: true,
    initialFocus: cancelRef,
    onEscape: () => settle(false),
  })

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request ? (
        <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && settle(false)}>
          <div
            className={`dialog${isNeo ? ' neo-world' : ''}`}
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby={request.body ? 'confirm-body' : undefined}
          >
            <h2 id="confirm-title">{request.title}</h2>
            {request.body ? <p id="confirm-body">{request.body}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="btn" ref={cancelRef} onClick={() => settle(false)}>
                {request.cancelLabel}
              </button>
              <button
                type="button"
                className={`btn ${request.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
                onClick={() => settle(true)}
              >
                {request.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  )
}
