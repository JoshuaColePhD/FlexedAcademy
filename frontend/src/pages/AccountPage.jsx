import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, BookOpen, ChevronRight, LogOut, Settings, ShieldCheck, User } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { useBilling } from '../lib/billingContext'

/* Was a popover anchored to the rail's own footer — on request, the account
 * trigger now navigates here instead of opening one: the rail slides shut
 * (AppShell.jsx, keyed on this route) and this page takes the whole pane, the
 * same "drill in, then come back" shape a phone's own Settings app uses
 * rather than a menu stacked on top of a still-visible chat. Everything the
 * popover used to hold — identity, usage, My classes / Settings / Admin /
 * Log out — is still here, just given the room a real page has: a
 * description under each destination, not just an icon and a word. */

/* Usage was pulled OUT of every teacher's own settings page and centralized
 * in the admin accounts panel (see SettingsPage.jsx's own BillingSection
 * comment) — that was about decluttering a page every teacher scrolls
 * through, not about hiding a teacher's own number from them. This is the
 * one place it comes back: your own usage, right under your name. */
function UsageMeter({ entitlement }) {
  if (!entitlement) return null
  const { tokens_used: used, token_cap: cap, usage_window_days: days, unlimited } = entitlement
  if (unlimited) {
    return (
      <div className="neo-panel mt-4 rounded-xl p-4">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-muted">Usage</span>
        <p className="mt-1 text-sm font-medium text-ok">Unlimited access</p>
      </div>
    )
  }
  if (!cap) return null

  const pct = Math.min(100, Math.round((used / cap) * 100))
  const tone = pct >= 100 ? 'bg-mark' : pct >= 85 ? 'bg-flag' : 'bg-ok'
  const statusText =
    pct >= 100
      ? 'You’ve reached this week’s limit'
      : pct >= 85
        ? 'Getting close to this week’s limit'
        : 'Plenty left this week'
  const statusTextColor = pct >= 100 ? 'text-mark' : pct >= 85 ? 'text-flag' : 'text-ok'

  return (
    <div className="neo-panel mt-4 rounded-xl p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-2xs font-medium uppercase tracking-wider text-ink-muted">Usage</span>
        <span className="text-2xs text-ink-muted">{days === 7 ? 'resets weekly' : `resets every ${days} days`}</span>
      </div>
      <div className="neo-inset mt-2 h-1.5 w-full overflow-hidden rounded-full bg-paper-sunken">
        <div className={`h-full rounded-full transition-[width] ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-1.5 text-sm font-medium ${statusTextColor}`}>{statusText}</p>
      <p className="text-2xs text-ink-muted">
        {pct}% used · {100 - pct}% left
      </p>
    </div>
  )
}

/* One row per destination, description and all — the thing a small popover
 * never had room for. `to`/`onClick` are mutually exclusive: every real
 * navigation uses `to` (so it's a genuine, linkable, back-button-friendly
 * anchor); Log out is the one action that isn't a destination. */
function AccountRow({ icon: Icon, label, description, to, onClick, tone = 'default' }) {
  const isDanger = tone === 'danger'
  const content = (
    <>
      <span
        aria-hidden="true"
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
          isDanger ? 'bg-mark-tint text-mark' : 'bg-paper-inset text-ink-soft'
        }`}
      >
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-medium ${isDanger ? 'text-mark' : 'text-ink'}`}>{label}</span>
        <span className="mt-0.5 block text-xs text-ink-muted">{description}</span>
      </span>
      {to ? <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-ink-faint" /> : null}
    </>
  )
  const className =
    'neo-raised flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-paper-sunken'
  return to ? (
    <Link to={to} className={className}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={className}>
      {content}
    </button>
  )
}

export function AccountPage() {
  const { classId } = useParams()
  const classPath = `/c/${classId}`
  const { user, logout } = useAuth()
  const { entitlement } = useBilling()
  const name = user?.name || user?.email || 'Signed in'

  return (
    <div className="column">
      <header className="flex h-14 shrink-0 items-center gap-2 px-gutter">
        {/* Back to the chat, not browser-back specifically — a teacher who
            drilled in from a different screen (My classes, say) should still
            land somewhere useful, not wherever history happens to point. */}
        <Link
          to={classPath}
          aria-label="Back to your plans"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Link>
        <h1 className="text-sm font-semibold text-ink">Account</h1>
      </header>

      <div className="page scroll-y">
        <div className="mx-auto w-full max-w-measure-form">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-paper-inset text-ink-muted"
            >
              <User size={22} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-ink">{name}</p>
              {user?.email ? <p className="truncate text-xs text-ink-muted">{user.email}</p> : null}
            </div>
          </div>

          <UsageMeter entitlement={entitlement} />

          <div className="mt-6 flex flex-col gap-2">
            {/* Placed first, same reasoning as the old popover's own
                ordering — the one control gated to admins only is the one
                that should be hardest to scroll past, not the last thing in
                the list. */}
            {user?.is_admin ? (
              <AccountRow
                icon={ShieldCheck}
                label="Admin"
                description="Manage every account, its billing status, and its usage."
                to="/admin"
              />
            ) : null}
            <AccountRow
              icon={BookOpen}
              label="My classes"
              description="See every class you teach, and add a new one."
              to={`${classPath}/class`}
            />
            <AccountRow
              icon={Settings}
              label="Settings"
              description="Appearance, your school's calendar, custom instructions, password, billing."
              to={`${classPath}/settings`}
            />
          </div>

          <div className="mt-6 border-t border-hairline pt-4">
            <AccountRow
              icon={LogOut}
              label="Log out"
              description="Ends your session on this device."
              tone="danger"
              onClick={logout}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
