import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LogOut, Settings, User, ShieldCheck } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'

/* The rail footer, and the home of the control that did not exist.
 *
 * AuthProvider has exposed `logout` since the multi-tenant work and nothing has
 * ever called it: there was no way to sign out of this app. On a single-user
 * tool that was merely odd. On a product other teachers log into it is a bug
 * with a privacy shape — a shared staffroom machine keeps the last teacher's
 * session for thirty days.
 *
 * It goes next to the teacher's own name because that is where people already
 * look for it. */
export function AccountMenu({ classPath }) {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  // Sits right above the trigger (bottom-full) — mirrors ClassSwitcher's own
  // dropdown, closing shape and all, just growing up instead of dropping down.
  const { mounted, closing } = useExitTransition(open, 150)
  const ref = useRef(null)
  const popoverRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  /* This claimed role="menu"/role="menuitem" — real ARIA menu semantics,
     which come with a contract: arrow keys move between items, Home/End jump
     to the ends, focus moves in on open. None of that existed; opening it
     left focus on the trigger button and only Tab/Shift+Tab walked through,
     so a screen reader announced a widget that then didn't behave like one.
     Same call already made elsewhere in this app for a fake tablist: drop
     the claim rather than half-implement the pattern. It's an ordinary
     disclosure — a button that reveals more buttons and links — and plain
     elements already carry the right semantics for that with no role at all.
     useFocusTrap adds the part a disclosure still owes a keyboard user: focus
     moves to the first item on open, Escape closes it, focus returns to the
     trigger on close. `trap: false` — same as the artifact panel's docked
     case — because this sits beside a still-live app, not over a modal. */
  useFocusTrap(popoverRef, { active: open, trap: false, onEscape: () => setOpen(false) })

  const name = user?.name || user?.email || 'Signed in'

  return (
    <div className="relative flex items-center gap-1 px-2 py-2" ref={ref}>
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-paper-inset"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span
          aria-hidden="true"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-paper-inset text-ink-muted"
        >
          <User size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-soft">{name}</span>
      </button>

      {mounted ? (
        <div
          ref={popoverRef}
          tabIndex={-1}
          className={`neo-panel fa-pop-up absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-2xl bg-paper-raised py-1${closing ? ' fa-chip-exit' : ''}`}
        >
          {/* --ink-muted: an email address is identity, not decoration —
              --ink-faint reads under 3:1 against --paper in light mode. */}
          {user?.email ? (
            <p className="truncate px-3 py-1.5 text-2xs text-ink-muted">{user.email}</p>
          ) : null}
          {user?.is_admin ? (
            <Link
              to="/admin"
              onClick={() => setOpen(false)}
              className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
            >
              <ShieldCheck size={14} aria-hidden="true" /> Admin
            </Link>
          ) : null}
          <div className="flex items-stretch border-t border-hairline mt-1 pt-1">
            <Link
              to={`${classPath}/class`}
              onClick={() => setOpen(false)}
              className="flex-1 flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
            >
              <Settings size={14} aria-hidden="true" /> Classes &amp; settings
            </Link>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                logout()
              }}
              title="Sign out"
              aria-label="Sign out"
              className="flex min-h-touch w-10 shrink-0 items-center justify-center text-ink-soft transition-colors hover:bg-paper-sunken hover:text-ink border-l border-hairline"
            >
              <LogOut size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
