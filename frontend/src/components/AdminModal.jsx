import { useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ShieldCheck, X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { AdminBody } from '../pages/AdminPage'

/* Same pop-up-over-the-chat pattern as SettingsModal — see its own comment
 * for the reasoning. AdminPage.jsx still renders as a full page for a
 * direct/bookmarked `/admin` visit (App.jsx's background-location routing
 * only swaps this in when there's a real background to show behind it).
 *
 * AdminModal is a top-level route (App.jsx's `Gate`), a sibling of
 * AppShell rather than a descendant of it — same position ConfirmProvider's
 * own dialog sits in, and for the same reason `.neo-world`'s tokens are
 * otherwise undeclared here. `isNeo` mirrors ConfirmProvider's own check,
 * just read off the BACKGROUND location (the chat underneath) rather than
 * the real one, since the real location is always /admin regardless of
 * which "world" the chat behind it belongs to.
 */
export function AdminModal() {
  const navigate = useNavigate()
  const location = useLocation()
  const background = location.state?.adminBackground
  const isNeo = background?.pathname?.startsWith('/c/') ?? false

  const close = () => navigate(-1)

  const { mounted, closing } = useExitTransition(true, 200)
  const dialogRef = useRef(null)
  useFocusTrap(dialogRef, { active: true, trap: true, onEscape: close })

  if (!mounted) return null

  return (
    <div
      className={`dialog-scrim${closing ? ' is-closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className={`dialog dialog-xl${isNeo ? ' neo-world' : ''}${closing ? ' is-closing' : ''}`}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-modal-title"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-hairline px-5 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} aria-hidden="true" className="text-ink-muted" />
            <h1 id="admin-modal-title" className="text-sm font-semibold text-ink">
              Accounts
            </h1>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close accounts"
            className="grid h-8 w-8 place-items-center rounded-md text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <AdminBody />
        </div>
      </div>
    </div>
  )
}
