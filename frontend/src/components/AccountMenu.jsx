import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, ChevronUp, LogOut, Settings, ShieldCheck, User } from 'lucide-react'
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
 * separate rows to two separate routes (ClassPage / SettingsPage), and a usage
 * readout sits under the identity block. Log out sits icon-only right beside
 * Settings, not a labeled row of its own — the label doesn't add anything a
 * teacher hasn't already learned this icon means the one time they hover it. */

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
  const { tokens_used: used, token_cap: cap, usage_window_days: days, unlimited } = entitlement
  // Genuinely uncapped (comped, no admin override) — entitlement.py sends
  // token_cap: null for exactly this case now. Said outright rather than
  // silently hiding the section: a blank space where the usage meter
  // should be reads as "this is broken," not "you have nothing to worry
  // about."
  if (unlimited) {
    return (
      <div className="px-3 py-2">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-muted">Usage</span>
        <p className="mt-1 text-xs font-medium text-ok">Unlimited access</p>
      </div>
    )
  }
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
      {/* The exact token counts (six-digit numbers nobody thinks in) are gone —
          the percentage is the one number worth keeping, since it's the same
          unit the bar above it is already drawn in. */}
      <p className="text-2xs text-ink-muted">
        {pct}% used · {100 - pct}% left
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
    <div className="relative px-2 py-2" ref={ref}>
      <div className="flex w-full items-stretch rounded-md transition-colors hover:bg-paper-inset focus-within:bg-paper-inset">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span
            aria-hidden="true"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-paper-sunken text-ink-muted"
          >
            <User size={13} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-soft">{name}</span>
          <ChevronUp size={13} aria-hidden="true" className="shrink-0 text-ink-faint" />
        </button>

        <div className="flex items-center" aria-hidden="true">
          <div className="h-3 w-px bg-edge shrink-0" />
        </div>

        <Link
          to={`${classPath}/settings`}
          className="flex items-center justify-center px-2.5 rounded-r-md text-ink-faint hover:text-ink transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={13} aria-hidden="true" />
        </Link>
      </div>

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

          {/* Its own group, not lumped in with My classes/Settings below —
              it used to sit one plain row among them, same size, same grey,
              same divider treatment as everything else, which made the one
              genuinely privileged link in this whole menu just as easy to
              graze past (or mis-tap) as an everyday one. A boundary is the
              signal, not a colour change — this isn't "actionable" the way
              --accent means elsewhere in the app, it's "different in kind."
              Placed first (above My classes/Settings), on Josh's own ask —
              the one control gated to admins only is the one that should be
              hardest to scroll past, not the last thing in the list. */}
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

          <div className="mt-1 border-t border-hairline pt-1">
            <Link
              to={`${classPath}/class`}
              onClick={() => setOpen(false)}
              className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
            >
              <BookOpen size={14} aria-hidden="true" /> My classes
            </Link>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                logout()
              }}
              className="flex w-full min-h-touch items-center gap-2 px-3 py-2 text-xs text-left text-ink-soft transition-colors hover:bg-mark-tint hover:text-mark"
            >
              <LogOut size={14} aria-hidden="true" /> Log out
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
