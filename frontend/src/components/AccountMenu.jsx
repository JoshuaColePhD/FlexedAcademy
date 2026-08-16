import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, ChevronsUpDown, LogOut, Settings, ShieldCheck, User } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'
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
 * look for it.
 *
 * Redesigned on Josh's own ask (findability): "My classes" and "Settings" used
 * to be one link ("Classes & settings") pointing at one page — now they're two
 * separate rows to two separate routes (ClassPage / SettingsPage), a usage
 * readout sits under the identity block, and Log out is its own full-width row
 * instead of a bare icon squeezed beside "Classes & settings". */

/* Usage was deliberately pulled OUT of every teacher's own settings page and
 * centralized in the admin accounts panel (see SettingsPage.jsx's own
 * BillingSection comment) — that was about decluttering a page every teacher
 * scrolls through, not about hiding a teacher's own number from them. This is
 * the one place it comes back: your own usage, in the one popover you already
 * open to find yourself. Rendered whenever the entitlement rode in on
 * /api/auth/me, regardless of whether billing itself is turned on — the
 * trailing-week cap governs generation either way (backend/entitlement.py). */
function UsageMeter({ entitlement }) {
  if (!entitlement) return null
  const { tokens_used: used, token_cap: cap, tokens_remaining: remaining, usage_window_days: days } = entitlement
  if (!cap) return null

  const pct = Math.min(100, Math.round((used / cap) * 100))
  // Same three-colour language the rest of the app already uses for "fine /
  // getting close / out" (--ok/--flag/--mark) rather than inventing a fourth
  // meaning for a fill colour.
  const tone = pct >= 100 ? 'bg-mark' : pct >= 85 ? 'bg-flag' : 'bg-ok'
  // The bar already answers "am I fine or should I worry" at a glance — the
  // words underneath should say the SAME thing in the only unit a teacher
  // actually thinks in, not make them subtract two six-digit numbers to
  // find out. The exact counts move to a smaller, secondary line instead of
  // disappearing outright: still there for anyone (Josh included) who wants
  // the real number, just not the first thing read.
  const statusText =
    pct >= 100
      ? 'You’ve reached this week’s limit'
      : pct >= 85
        ? 'Getting close to this week’s limit'
        : 'Plenty left this week'
  const statusTextColor = pct >= 100 ? 'text-mark' : pct >= 85 ? 'text-flag' : 'text-ok'

  return (
    <div className="px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-muted">Usage</span>
        <span className="text-2xs text-ink-muted">{days === 7 ? 'resets weekly' : `resets every ${days} days`}</span>
      </div>
      <div className="neo-inset mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-paper-sunken">
        <div
          className={`h-full rounded-full transition-[width] ${tone}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className={`mt-1 text-xs font-medium ${statusTextColor}`}>{statusText}</p>
      <p className="text-2xs text-ink-muted">
        {used.toLocaleString()} / {cap.toLocaleString()} tokens · {remaining.toLocaleString()} left
      </p>
    </div>
  )
}

export function AccountMenu({ classPath }) {
  const { user, logout } = useAuth()
  const { entitlement } = useBilling()
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
        {/* Same chevron ClassSwitcher already puts beside ITS trigger, right
            above this one in the rail — nothing here previously said "this
            opens" at all, unlike its sibling. One convention for "tap this
            for more," not two. */}
        <ChevronsUpDown size={13} aria-hidden="true" className="shrink-0 text-ink-faint" />
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

          <UsageMeter entitlement={entitlement} />

          <div className="mt-1 border-t border-hairline pt-1">
            <Link
              to={`${classPath}/class`}
              onClick={() => setOpen(false)}
              className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
            >
              <BookOpen size={14} aria-hidden="true" /> My classes
            </Link>
            <Link
              to={`${classPath}/settings`}
              onClick={() => setOpen(false)}
              className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
            >
              <Settings size={14} aria-hidden="true" /> Settings
            </Link>
          </div>

          {/* Its own group, not lumped in with My classes/Settings above OR
              Log out below — it used to sit one plain row above Log out,
              same size, same grey, same divider treatment as everything
              else, which made the one genuinely privileged link in this
              whole menu just as easy to graze past (or mis-tap) as an
              everyday one. A boundary on both sides is the signal, not a
              colour change — this isn't "actionable" the way --accent means
              elsewhere in the app, it's "different in kind." */}
          {user?.is_admin ? (
            <div className="mt-1 border-t border-hairline pt-1">
              <Link
                to="/admin"
                onClick={() => setOpen(false)}
                className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
              >
                <ShieldCheck size={14} aria-hidden="true" /> Admin
              </Link>
            </div>
          ) : null}

          {/* Its own full-width row, not an icon squeezed beside "Classes &
              settings" — a mis-tap on a 40px-wide icon button next to the
              app's own main settings link was one slip away, and the icon
              alone (no visible label) made the control hard to even find in
              the first place. */}
          <div className="mt-1 border-t border-hairline pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                logout()
              }}
              className="flex min-h-touch w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-ink-soft transition-colors hover:bg-mark-tint hover:text-mark"
            >
              <LogOut size={14} aria-hidden="true" /> Log out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
