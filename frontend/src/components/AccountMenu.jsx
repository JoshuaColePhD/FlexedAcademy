import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronUp, Info, LogOut, Mail, Settings, ShieldCheck } from 'lucide-react'
import { getAvatar, getInitials } from '../lib/avatars'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useExitTransition } from '../hooks/useExitTransition'
import { SupportDialog } from './SupportDialog'

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
function UsageMeter({ entitlement, onSubscribeClick }) {
  if (!entitlement) return null
  const {
    tokens_used: used,
    token_cap: cap,
    usage_window_days: days,
    unlimited,
    trial_expired: trialExpired,
    trial_days_remaining: trialDaysRemaining,
  } = entitlement
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
  // trial_expired also carries token_cap: null (there's no cap left to show
  // — see entitlement.py) but that's a different reason a teacher hits the
  // paywall than a cap ever was, and needs its own line rather than falling
  // into the generic "no cap number" case below and going blank.
  if (trialExpired) {
    return (
      <div className="px-3 py-2">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-muted">Usage</span>
        <p className="mt-1 text-xs font-medium text-mark">Your free trial has ended</p>
        <button type="button" className="mt-1 text-2xs font-medium text-accent underline" onClick={onSubscribeClick}>
          Subscribe to keep building
        </button>
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
        <span className="text-2xs text-ink-muted">{days === 7 ? 'resets after 7 days' : `resets every ${days} days`}</span>
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
        {pct}% / 100% usage limit
      </p>
      {/* Only set for an unsubscribed account still inside its free week
          (entitlement.py) — a countdown that means "this stops working
          entirely," not "this resets," which is why it reads as its own
          line rather than folding into the reset copy above. */}
      {trialDaysRemaining != null ? (
        <p className="mt-1 text-2xs font-medium text-flag">
          {trialDaysRemaining === 0
            ? 'Your free trial ends today'
            : `${trialDaysRemaining} day${trialDaysRemaining === 1 ? '' : 's'} left in your free trial`}
        </p>
      ) : null}
    </div>
  )
}

export function AccountMenu({ classPath, collapsed, spacious }) {
  const { user, logout } = useAuth()
  const { entitlement, openPaywall } = useBilling()
  const [open, setOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  // Sits right above the trigger (bottom-full) — mirrors ClassSwitcher's own
  // dropdown, closing shape and all, just growing up instead of dropping down.
  const { mounted, closing } = useExitTransition(open, 150)
  const ref = useRef(null)
  const popoverRef = useRef(null)
  const [popoverStyle, setPopoverStyle] = useState(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!ref.current?.contains(e.target) && !popoverRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // The rail is intentionally clipped so its collapsed state stays narrow.
  // Render the account menu in the document layer and anchor it to the footer
  // trigger instead of letting that clipping context cut the menu to 68px.
  useLayoutEffect(() => {
    if (!mounted || !ref.current) return undefined
    const position = () => {
      const anchor = ref.current?.getBoundingClientRect()
      if (!anchor) return
      const width = collapsed ? 280 : Math.max(anchor.width, 220)
      const left = Math.max(8, Math.min(
        collapsed ? anchor.right + 8 : anchor.left,
        window.innerWidth - width - 8,
      ))
      setPopoverStyle({
        position: 'fixed',
        left,
        bottom: Math.max(8, window.innerHeight - anchor.top + 4),
        width,
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'min(70vh, 520px)',
        zIndex: 1000,
      })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [mounted, collapsed])

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
  const avatar = getAvatar(user?.avatar)
  const sizeCls = spacious ? 'h-9 w-9' : 'h-7 w-7'
  const avatarNode = avatar ? (
    <span
      aria-hidden="true"
      className={`grid ${sizeCls} shrink-0 place-items-center rounded-full ${avatar.bg} border border-edge/30`}
    >
      <span className={spacious ? 'text-base leading-none' : 'text-sm leading-none'}>{avatar.emoji}</span>
    </span>
  ) : (
    <span
      aria-hidden="true"
      className={`grid ${sizeCls} shrink-0 place-items-center rounded-full bg-paper-inset text-ink-muted border border-edge/30`}
    >
      <span className={spacious ? 'text-xs font-bold tracking-wide' : 'text-2xs font-bold tracking-wide'}>{getInitials(user?.name)}</span>
    </span>
  )

  return (
    <div className={`relative flex items-center gap-1 py-2 ${collapsed ? 'px-1 justify-center' : 'px-2'}`} ref={ref}>
      {collapsed ? (
        <button
          type="button"
          className="flex justify-center rounded-md p-2 transition-colors hover:bg-paper-inset"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`Open account menu for ${name}`}
          title={name}
        >
          {avatarNode}
        </button>
      ) : (
        <div className="rail-reveal flex min-w-0 flex-1 items-center">
          {/* One control, not two — this used to be a Link straight to
              Settings sitting beside a separate chevron button that opened
              this same popover, and the popover already has its own
              Settings row (below). Both pieces did the same job of "find
              your account," just at different distances, so they're merged
              into the single toggle the collapsed state above already
              uses. */}
          <button
            type="button"
            className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left transition-colors hover:bg-paper-inset ${spacious ? 'min-h-[48px] px-2.5 py-2.5' : 'gap-2 px-2 py-1.5'}`}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={`Open account menu for ${name}`}
            title={name}
          >
            {avatarNode}
            <span className={`min-w-0 flex-1 truncate font-medium text-ink-soft ${spacious ? 'text-sm' : 'text-xs'}`}>{name}</span>
            <ChevronUp size={spacious ? 15 : 13} className="shrink-0 text-ink-faint" aria-hidden="true" />
          </button>
        </div>
      )}

      {mounted ? (
        createPortal(
          <div
            ref={popoverRef}
            tabIndex={-1}
            style={popoverStyle || { visibility: 'hidden' }}
            className={`neo-panel fa-pop-up overflow-hidden rounded-2xl bg-paper-raised py-1${closing ? ' fa-chip-exit' : ''}`}
          >
          {/* --ink-muted: an email address is identity, not decoration —
              --ink-faint reads under 3:1 against --paper in light mode. */}
          {user?.email ? (
            <p className="truncate px-3 py-1.5 text-2xs text-ink-muted">{user.email}</p>
          ) : null}

          <UsageMeter
            entitlement={entitlement}
            onSubscribeClick={() => {
              setOpen(false)
              openPaywall()
            }}
          />

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
                to={`${classPath}/admin`}
                onClick={() => setOpen(false)}
                className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
              >
                <ShieldCheck size={14} aria-hidden="true" /> Admin
              </Link>
            </div>
          ) : null}

          <div className="mt-1 border-t border-hairline pt-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setSupportOpen(true)
              }}
              title="Contact support"
              className="flex min-h-touch w-full min-w-0 items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
            >
              <Mail size={14} aria-hidden="true" /> Contact support
            </button>
            <Link
              to="/privacy"
              onClick={() => setOpen(false)}
              className="flex min-h-touch items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
            >
              <Info size={14} aria-hidden="true" /> Privacy &amp; data policy
            </Link>
            <div className="flex items-center">
              <Link
                to={`${classPath}/settings`}
                onClick={() => setOpen(false)}
                className="flex min-h-touch min-w-0 flex-1 items-center gap-2 px-3 py-2 text-xs text-ink-soft transition-colors hover:bg-paper-sunken"
              >
                <Settings size={14} aria-hidden="true" /> Settings
              </Link>
              {/* Icon-only, right beside Settings — no label needed once it
                  sits next to the one thing it's most often reached for
                  right after (or instead of). Its own hover tint (--mark)
                  keeps it reading as the one destructive control up here,
                  same as the full-width row this replaced. */}
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  logout()
                }}
                aria-label="Log out"
                title="Log out"
                className="mr-2 grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-soft transition-colors hover:bg-mark-tint hover:text-mark"
              >
                <LogOut size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
          </div>,
          document.body,
        )
      ) : null}
      <SupportDialog open={supportOpen} onClose={() => setSupportOpen(false)} />
    </div>
  )
}
