import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CreditCard, LogOut, Settings, Sparkles, User } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { ThemeToggle } from './ThemeToggle'

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
  const { entitlement, billingEnabled, openPaywall, manage } = useBilling()
  const [open, setOpen] = useState(false)
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

      <ThemeToggle />

      {open ? (
        <div
          ref={popoverRef}
          tabIndex={-1}
          className="absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-lg border border-edge bg-paper-raised py-1 shadow-lg"
        >
          {/* --ink-muted: an email address is identity, not decoration —
              --ink-faint reads under 3:1 against --paper in light mode. */}
          {user?.email ? (
            <p className="truncate px-3 py-1.5 text-2xs text-ink-muted">{user.email}</p>
          ) : null}
          {/* Subscription. Hidden entirely while billing is unconfigured — an
              account menu offering to manage a subscription that cannot exist
              is worse than no row at all. */}
          {billingEnabled ? (
            entitlement?.subscribed ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  manage()
                }}
                className="flex min-h-touch w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
              >
                <CreditCard size={14} aria-hidden="true" /> Manage subscription
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  openPaywall()
                }}
                className="flex min-h-touch w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
              >
                <Sparkles size={14} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">Subscribe</span>
                {/* Plans are unlimited on the free tier now (see
                    entitlement.py) — nothing left to count down, so this only
                    has something to say once the weekly usage cap is
                    actually hit, not on every ordinary week of use. */}
                {entitlement && !entitlement.may_generate ? (
                  <span className="shrink-0 text-2xs text-mark">Limit reached</span>
                ) : null}
              </button>
            )
          ) : null}
          <Link
            to={`${classPath}/class`}
            onClick={() => setOpen(false)}
            className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
          >
            <Settings size={14} aria-hidden="true" /> Classes &amp; settings
          </Link>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              logout()
            }}
            className="flex min-h-touch w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
          >
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
