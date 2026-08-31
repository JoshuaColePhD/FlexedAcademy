import React, { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Activity,
  ArrowUpRight,
  Ban,
  BarChart3,
  BookOpen,
  Building2,
  CalendarCheck2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  Download,
  FileText,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { SplitLayout } from "../components/SplitLayout"
import { useActiveClass } from '../hooks/useAppData'

/* Account management, as a page instead of a Supabase SQL editor tab.
 *
 * This replaces exactly one workflow: "who's signed up, are they paying, and
 * give this one unlimited access" — the three questions that used to mean
 * either running SQL by hand against production or asking someone who could.
 * It is deliberately narrow. It does not edit classes, plans, or content —
 * teachers still own those records — but it does provide an admin-only,
 * read-only plan history for support and product review.
 *
 * is_admin gates the route itself (see App.jsx) and every request the page
 * makes (see deps.get_current_admin) — a non-admin hitting /admin by URL sees
 * the same "Not authorized" the API would have given them anyway.
 *
 * Widened twice on Josh's own ask ("needs to give me a lot more control").
 * First pass (still here): an estimated $ cost per account, an at-a-glance
 * cap status, a per-account cap override, search, and a card layout below
 * `lg`. Second pass, this one: summary stats at a glance, sortable columns
 * and a status filter (so "who's actually close to their cap" doesn't mean
 * scanning every row by eye), a site-wide weekly usage trend (a single 7-day
 * snapshot says how much, never whether it's growing), and bulk actions
 * (grant/revoke/cap several accounts at once instead of one row at a time).
 */

const STATUS_LABELS = {
  active: 'Active',
  trialing: 'Trialing',
  past_due: 'Past due',
  canceled: 'Canceled',
  comped: 'Comped',
  none: 'No subscription',
}

/* Same shape as BillingProvider's own formatPrice — cents and a currency
   code in, a locale-formatted figure out. Not imported from there: that
   component's version also appends "/ month", which an aggregate MRR figure
   has no use for. */
function formatCents(cents, currency = 'USD') {
  if (cents == null) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

/* One human-readable line per admin_audit_log row (backend/db.py migration
   28). Kept next to the log fetch rather than in a shared util — nothing
   else in the app renders this shape, and it would be one more file to open
   to follow what "comp_grant" means. */
function describeAuditEntry(entry) {
  const who = entry.actor_email || 'unknown admin'
  switch (entry.action) {
    case 'comp_grant':
      return `${who} granted unlimited access to ${entry.target}`
    case 'comp_revoke':
      return `${who} revoked unlimited access from ${entry.target}`
    case 'school_add':
      return `${who} added school "${entry.detail?.name || entry.target}" (${entry.target})`
    case 'school_remove':
      return `${who} removed school ${entry.target}`
    case 'settings_update': {
      const before = entry.detail?.before
      const after = entry.detail?.after
      if (before && after) {
        return `${who} changed token caps: free ${before.free_weekly_token_cap.toLocaleString()} → ${after.free_weekly_token_cap.toLocaleString()}, subscriber ${before.subscriber_weekly_token_cap.toLocaleString()} → ${after.subscriber_weekly_token_cap.toLocaleString()}`
      }
      return `${who} updated settings`
    }
    default:
      return `${who} · ${entry.action}${entry.target ? ` · ${entry.target}` : ''}`
  }
}

const ENTITLED = new Set(['active', 'trialing', 'past_due', 'comped'])

// Mirrors config.py/entitlement.py — see their own comments for where these
// numbers come from. Duplicated rather than fetched, the same call
// list_accounts_with_stats's own docstring already made for the 7-day
// window: this is a display estimate for an admin, not the value anything
// actually gates on, so a fetch-on-every-render is more machinery than the
// number is worth. Keep these three in step with the backend if either
// changes.
const FREE_WEEKLY_CAP = 150_000
const SUBSCRIBER_WEEKLY_CAP = 110_000
const BURST_FRACTION = 0.35
// $ / 1M tokens, the same gpt-4o-era blended rate the profitability math
// behind SUBSCRIBER_WEEKLY_CAP itself used — an estimate, not an invoice.
const BLENDED_RATE_PER_1M = 5

function relative(iso) {
  if (!iso) return 'never'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function estCost(tokens) {
  return `$${((tokens / 1_000_000) * BLENDED_RATE_PER_1M).toFixed(2)}`
}

/* free / subscribed / comped — the three states the status filter and the
   summary cards both read off of. Not the same partition as ENTITLED
   (which lumps comped in with active/trialing/past_due for "may generate")
   — an admin looking at the account list wants comped called out on its
   own, since it's the one status THIS page can flip, unlike a real Stripe
   subscription. */
function tier(account) {
  if (account.subscription_status === 'comped') return 'comped'
  if (ENTITLED.has(account.subscription_status)) return 'subscribed'
  return 'free'
}

/* The cap actually in effect for one account, and how close it's running to
   it — same precedence entitlement.py itself uses (custom override, then
   comped-is-truly-unlimited, then tier default), and the same weekly+burst
   thresholds it gates generation on, just read here for DISPLAY rather than
   enforcement.

   'comped' with no custom override is genuinely uncapped — entitlement.py's
   own fix (see its comment there): comped used to just mean "ride the
   subscriber cap," which stopped being effectively unlimited the moment that
   cap was sized to a real dollar ceiling instead of a loose round number.
   This table would otherwise show a comped account as "near cap" or "at
   cap," which is exactly the state that bug put real comped accounts into. */
function capStatusFor(account) {
  if (account.custom_weekly_token_cap == null && account.subscription_status === 'comped') {
    return { tone: 'ok', label: 'Unlimited', cap: null }
  }

  const cap =
    account.custom_weekly_token_cap ??
    (ENTITLED.has(account.subscription_status) ? SUBSCRIBER_WEEKLY_CAP : FREE_WEEKLY_CAP)
  const burstCap = Math.floor(cap * BURST_FRACTION)
  const weekly = account.tokens_7d || 0
  const burst = account.tokens_burst || 0

  if (weekly >= cap) return { tone: 'mark', label: 'At weekly cap', cap }
  if (burst >= burstCap) return { tone: 'mark', label: 'Burst-limited now', cap }
  if (weekly / cap >= 0.85) return { tone: 'flag', label: 'Near cap', cap }
  return { tone: 'ok', label: 'Fine', cap }
}

function CapStatusBadge({ account }) {
  const { tone, label } = capStatusFor(account)
  const cls =
    tone === 'mark' ? 'bg-mark-tint text-mark' : tone === 'flag' ? 'bg-flag-tint text-flag' : 'bg-ok-tint text-ok'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium ${cls}`}>{label}</span>
  )
}

function StatusPill({ status }) {
  const entitled = status ? ENTITLED.has(status) : false
  const label = status || 'free week'
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium ${
        entitled ? 'bg-ok-tint text-ok' : 'bg-paper-inset text-ink-muted'
      }`}
    >
      {label}
    </span>
  )
}

function BlockedPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-mark-tint px-2 py-0.5 text-2xs font-medium text-mark">
      <Ban size={10} aria-hidden="true" /> Blocked
    </span>
  )
}

function resourcePillClass(tone) {
  if (tone === 'ok') return 'bg-ok-tint text-ok'
  if (tone === 'flag') return 'bg-flag-tint text-flag'
  if (tone === 'mark') return 'bg-mark-tint text-mark'
  return 'bg-paper-inset text-ink-muted'
}

/* Read-only context indicators for support. Pacing guides are teacher/class
   resources; the calendar is deliberately labeled school-wide because one
   confirmed calendar serves everyone at that school. The API returns dates
   and filenames but never exposes the submitter's identity here. */
function PlanningContext({ account }) {
  const context = account.learning_context || {}
  const pacing = context.pacing_guides || {}
  const calendar = context.calendar || {}
  const activeDocuments = pacing.documents?.filter((doc) => doc.active) || []
  const guideLabel = pacing.active_count
    ? pacing.class_count
      ? `${pacing.active_class_count} of ${pacing.class_count} classes`
      : 'Account-wide'
    : pacing.superseded_count
      ? 'Superseded only'
      : 'Not uploaded'
  const guideTone = pacing.active_count
    ? pacing.class_count && pacing.active_class_count < pacing.class_count
      ? 'flag'
      : 'ok'
    : pacing.superseded_count
      ? 'flag'
      : 'none'
  const guideDetail = activeDocuments.length
    ? `${activeDocuments[0].original_name}${activeDocuments.length > 1 ? ` +${activeDocuments.length - 1}` : ''}`
    : pacing.superseded_count
      ? `${pacing.superseded_count} superseded`
      : 'No active guide'
  const calendarLabels = {
    confirmed: 'Confirmed',
    pending: 'Pending review',
    rejected: 'Rejected',
    none: 'Not uploaded',
  }
  const calendarTone = calendar.status === 'confirmed' ? 'ok' : calendar.status === 'pending' ? 'flag' : calendar.status === 'rejected' ? 'mark' : 'none'
  const calendarDetail = calendar.source_name || (calendar.status === 'none' ? 'No school calendar' : 'Needs attention')

  return (
    <div className="flex min-w-[210px] flex-col gap-1.5 text-2xs">
      <div className="flex items-center gap-1.5" title={`${guideDetail}${pacing.latest_uploaded_at ? ` · ${new Date(pacing.latest_uploaded_at).toLocaleDateString()}` : ''}`}>
        <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-medium ${resourcePillClass(guideTone)}`}>
          Pacing: {guideLabel}
        </span>
        <span className="max-w-36 truncate text-ink-muted">{guideDetail}</span>
      </div>
      <div className="flex items-center gap-1.5" title={`${calendarDetail}${calendar.submitted_at ? ` · ${new Date(calendar.submitted_at).toLocaleDateString()}` : ''}`}>
        <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 font-medium ${resourcePillClass(calendarTone)}`}>
          Calendar: {calendarLabels[calendar.status] || 'Not uploaded'}
        </span>
        <span className="max-w-36 truncate text-ink-muted">{calendarDetail}</span>
      </div>
    </div>
  )
}

// Whole days remaining until `iso`, rounded up — "expires in 6 hours" and
// "expires in 23 hours" both read as "1 day left," which is closer to what
// someone glancing at this table wants than a fraction.
function daysUntil(iso) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)
}

/* Nothing for a normal account — beta_expires_at is null for every signup
 * that didn't come through "New beta account" below, which is most of them.
 * For one that does have it: a countdown that gets more alarmed as it gets
 * closer, and reads "Expired" past zero rather than "-1d left" — the trial
 * itself is what deps._verify_current actually enforces (backend), this is
 * only ever telling the truth about that, never deciding it.
 */
function TrialBadge({ account }) {
  if (!account.beta_expires_at) return null
  const days = daysUntil(account.beta_expires_at)
  const label = days <= 0 ? 'Trial expired' : days === 1 ? 'Trial: 1 day left' : `Trial: ${days} days left`
  const cls = days <= 0 ? 'bg-mark-tint text-mark' : days <= 2 ? 'bg-flag-tint text-flag' : 'bg-paper-inset text-ink-muted'
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium ${cls}`}>{label}</span>
}

/* Extend/End — only meaningful on an account that already has a trial
 * window, which is exactly what the backend's own guard on both routes
 * checks (400 not_a_beta_account otherwise), so this never renders for a
 * normal account in the first place. */
function BetaAccountActions({ account, pending, setPending }) {
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  if (!account.beta_expires_at) return null

  const extend = async () => {
    setPending(account.id)
    try {
      await api.adminExtendBeta(account.id, 7)
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      toast.success(`${account.email}'s trial extended 7 days`)
    } catch (err) {
      toast.apiError('Could not extend that trial', err)
    } finally {
      setPending(null)
    }
  }

  const end = async () => {
    const ok = await confirm({
      title: `End ${account.email}'s trial now?`,
      body: 'Their session stops working on their very next request — same as if the 7 days had already run out.',
      confirmLabel: 'End trial',
      tone: 'danger',
    })
    if (!ok) return
    setPending(account.id)
    try {
      await api.adminEndBeta(account.id)
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      toast.success(`${account.email}'s trial ended`)
    } catch (err) {
      toast.apiError('Could not end that trial', err)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex gap-1.5">
      <button type="button" className="btn text-xs" disabled={pending === account.id} onClick={extend}>
        Extend 7d
      </button>
      <button type="button" className="btn text-xs" disabled={pending === account.id} onClick={end}>
        End now
      </button>
    </div>
  )
}

/* Hand a beta tester a working login in one step: real account, subscriber-
 * tier usage (entitlement.py's `unlimited` flag is keyed specifically on
 * 'comped' — this is 'active', so a tester experiences the product's real
 * limits, not either extreme), a 7-day window enforced server-side
 * (deps._verify_current), and nothing pre-seeded — no class, no
 * onboarding_seen_at — so it walks through /welcome and the onboarding
 * wizard exactly like a brand-new signup.
 *
 * The password is shown exactly once, right here, the moment the account is
 * created — same as this codebase treats every other credential it ever
 * generates. There is no "view password" anywhere else in the app because
 * there is nothing left to view; only the hash is stored. */
function NewBetaAccountForm() {
  const toast = useToast()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [days, setDays] = useState(7)
  // Blank means "generate a real, unique one" (the normal case). Filled in,
  // every account created while it's set shares that exact password — for a
  // small batch of easy-to-type test logins (test1@, test2@…) that don't
  // need to be distinct from each other.
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState(null) // { email, password }
  const [copied, setCopied] = useState(false)

  const create = async (e) => {
    e.preventDefault()
    if (!email.trim() || !name.trim()) return
    setSaving(true)
    try {
      const res = await api.adminCreateBetaAccount(email.trim(), name.trim(), days, password.trim() || undefined)
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      setCreated({ email: email.trim(), password: res.password })
      setEmail('')
      setName('')
      // Password is left as-is (not cleared) — creating a batch of
      // test1@/test2@/test3@ with the SAME password means typing it once and
      // reusing it across several submits, not retyping it every time.
    } catch (err) {
      toast.apiError('Could not create that account', err)
    } finally {
      setSaving(false)
    }
  }

  const copyCreds = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(`Email: ${created.email}\nPassword: ${created.password}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* Clipboard blocked — the text is still selectable right below. */
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn text-xs" onClick={() => setOpen(true)}>
        <Plus size={13} className="mr-1" aria-hidden="true" /> New beta account
      </button>
    )
  }

  return (
    <div className="neo-world neo-panel w-full max-w-md rounded-xl p-4">
      {created ? (
        <>
          <h3 className="text-sm font-semibold text-ink">Account ready</h3>
          <p className="mt-1 text-2xs text-ink-muted">
            This is the only time the password is ever shown. Copy it now and send it to them
            directly — there's nowhere in the app to look it up again.
          </p>
          <div className="mt-3 rounded-lg border border-edge bg-paper-sunken p-3 font-mono text-xs text-ink">
            <div>Email: {created.email}</div>
            <div>Password: {created.password}</div>
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn flex-1 text-xs" onClick={copyCreds}>
              {copied ? 'Copied' : 'Copy email + password'}
            </button>
            <button
              type="button"
              className="btn text-xs"
              onClick={() => {
                setCreated(null)
                setOpen(false)
              }}
            >
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={create} className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">New beta account</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Cancel"
              className="rounded p-0.5 text-ink-faint hover:text-ink"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-ink-muted">Their name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Smith"
              required
              className="rounded-md border border-edge bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-ink-muted">Their email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@herschool.org"
              required
              className="rounded-md border border-edge bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-ink-muted">Trial length (days)</span>
            <input
              type="number"
              min={1}
              max={90}
              value={days}
              onChange={(e) => setDays(Math.max(1, parseInt(e.target.value, 10) || 7))}
              className="w-24 rounded-md border border-edge bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-ink-muted">Password (optional)</span>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to generate a unique one"
              className="rounded-md border border-edge bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
            {password && password.trim().length < 8 ? (
              <span className="text-2xs text-mark">At least 8 characters.</span>
            ) : password ? (
              <span className="text-2xs text-ink-muted">
                Every account you create while this is filled in shares this exact password.
              </span>
            ) : null}
          </label>
          <p className="text-2xs text-ink-muted">
            Gets subscriber-level usage (not the free tier's limit, not unlimited) and starts
            fresh — no class yet, so they go straight through the same onboarding a brand-new
            signup does.
          </p>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !email.trim() || !name.trim() || (password.trim().length > 0 && password.trim().length < 8)}
          >
            {saving ? 'Creating…' : 'Create account'}
          </button>
        </form>
      )}
    </div>
  )
}

/* The missing middle ground between "the ordinary tier cap" and "comped"
   (unlimited) — give one account more headroom without unlocking it
   entirely, or throttle one down without suspending it outright. Blank
   input = no override (the tier default applies, same as before this
   existed); a number, including 0, is a real override. */
function CustomCapEditor({ account }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [value, setValue] = useState(account.custom_weekly_token_cap ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setValue(account.custom_weekly_token_cap ?? '')
  }, [account.custom_weekly_token_cap])

  const current = account.custom_weekly_token_cap ?? null
  const next = value === '' ? null : Math.max(0, parseInt(value, 10) || 0)
  const dirty = next !== current

  const save = async () => {
    setSaving(true)
    try {
      await api.adminSetCustomCap(account.id, next)
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      toast.success(
        next == null
          ? `${account.email} back to the ordinary tier cap`
          : `${account.email} capped at ${next.toLocaleString()} tokens/week`
      )
    } catch (err) {
      toast.apiError('Could not update that cap', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        step={1000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="tier default"
        aria-label={`Custom weekly token cap for ${account.email}`}
        className="w-full min-w-0 rounded-md border border-edge bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-accent"
      />
      <button
        type="button"
        className="btn shrink-0 px-2 py-1 text-2xs"
        disabled={saving || !dirty}
        onClick={save}
      >
        {saving ? '…' : 'Save'}
      </button>
    </div>
  )
}

/* A single 7-day snapshot per account says how much; it can't say whether
   usage is growing, flat, or falling off — the question that actually
   matters for "is the current pricing still working." Plain divs sized by
   inline height, not a charting library, for the same reason the rest of
   this page stays plain HTML: eight bars is not something that needs a
   dependency. */
function UsageTrendChart() {
  const { data, isLoading, isError } = useQuery({
    queryKey: qk.adminUsageTrend,
    queryFn: () => api.adminUsageTrend(),
  })
  const weeks = data?.weeks ?? []

  if (isLoading || isError || !weeks.length) return null

  const max = Math.max(...weeks.map((w) => w.tokens), 1)

  return (
    <div className="neo-world neo-panel mb-6 rounded-xl p-4">
      <p className="text-sm font-semibold text-ink">Weekly usage</p>
      <p className="mt-0.5 text-2xs text-ink-muted">
        Tokens across every account, by week — {weeks.length} week{weeks.length === 1 ? '' : 's'}.
      </p>
      <div className="mt-3 flex h-20 items-end gap-1.5">
        {weeks.map((w) => (
          <div
            key={w.week_start}
            className="group relative flex h-full flex-1 items-end"
            title={`Week of ${new Date(w.week_start).toLocaleDateString()}: ${w.tokens.toLocaleString()} tokens (${estCost(
              w.tokens
            )})`}
          >
            <div
              className="w-full rounded-t bg-accent/60 transition-colors group-hover:bg-accent"
              style={{ height: `${Math.max(4, Math.round((w.tokens / max) * 100))}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

const ADMIN_PLAN_FIELDS = [
  ['learning_targets', 'Learning targets'],
  ['standards', 'Standards'],
  ['act_alignment', 'ACT alignment'],
  ['engagement_strategy', 'Engagement strategy'],
  ['do_now', 'Do now'],
  ['during', 'During'],
  ['assessment', 'Assessment'],
]

function displayPlanValue(value) {
  if (value == null || value === '') return ''
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function AdminDocxDownloadButton({ planId }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const download = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.adminDownloadPlan(planId)
    } catch (err) {
      toast.apiError('Could not download the DOCX', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" className="btn inline-flex items-center gap-1.5 text-xs" onClick={download} disabled={busy}>
      {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
      {busy ? 'Preparing…' : 'Download DOCX'}
    </button>
  )
}

function AdminPlanDetail({ planId, onClose }) {
  const { data: plan, isLoading, isError } = useQuery({
    queryKey: qk.adminPlan(planId),
    queryFn: () => api.adminGetPlan(planId),
    enabled: Boolean(planId),
  })

  if (isLoading) return <p className="mt-4 text-sm text-ink-muted">Loading plan…</p>
  if (isError || !plan) return <p className="mt-4 text-sm text-mark">Could not load that lesson plan.</p>

  const days = plan.plan_json?.days || []
  return (
    <div className="mt-5 rounded-xl border border-accent/30 bg-paper p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-edge pb-3">
        <div>
          <p className="text-lg font-semibold text-ink">{plan.week_label || 'Untitled lesson plan'}</p>
          <p className="mt-1 text-xs text-ink-muted">
            {plan.user_name || plan.user_email} · {plan.course || 'Course not recorded'}
            {plan.school_name ? ` · ${plan.school_name}` : ''}
          </p>
          <p className="mt-1 text-2xs text-ink-faint">
            Created {new Date(plan.created_at).toLocaleString()}
            {plan.class_name ? ` · ${plan.class_name}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AdminDocxDownloadButton planId={plan.id} />
          <button type="button" className="btn text-xs" onClick={onClose}>Close</button>
        </div>
      </div>

      {plan.query ? (
        <div className="mt-3 rounded-lg bg-paper-inset px-3 py-2 text-xs text-ink-soft">
          <span className="font-medium text-ink">Original request:</span> {plan.query}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {days.map((day, index) => (
          <section key={`${day.name || 'day'}-${index}`} className="rounded-lg border border-edge bg-paper-sunken p-3">
            <h3 className="text-sm font-semibold text-ink">{day.name || `Day ${index + 1}`}</h3>
            <div className="mt-2 space-y-3">
              {ADMIN_PLAN_FIELDS.map(([key, label]) => {
                const value = displayPlanValue(day[key])
                return value ? (
                  <div key={key}>
                    <p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-ink-soft">{value}</p>
                  </div>
                ) : null
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function AdminLessonPlans({ accounts }) {
  const [search, setSearch] = useState('')
  const [userFilter, setUserFilter] = useState('')
  const [page, setPage] = useState(0)
  const [selectedId, setSelectedId] = useState(null)
  const limit = 50

  useEffect(() => {
    setPage(0)
    setSelectedId(null)
  }, [search, userFilter])

  const { data, isLoading, isError } = useQuery({
    queryKey: qk.adminPlans({ search, userFilter, page }),
    queryFn: () => api.adminListPlans({
      limit,
      offset: page * limit,
      q: search.trim() || undefined,
      userId: userFilter || undefined,
    }),
  })
  const plans = data?.items || []
  const total = data?.total || 0
  const pageCount = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="neo-world neo-panel rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <BookOpen size={17} aria-hidden="true" className="mt-0.5 text-ink-muted" />
          <div>
            <h2 className="text-sm font-semibold text-ink">Lesson Plans</h2>
            <p className="mt-1 text-2xs text-ink-muted">
              Read-only history of plans produced by every account. Open one to review its full content or download its DOCX.
            </p>
          </div>
        </div>
        {total > 0 ? <span className="text-xs text-ink-muted">{total.toLocaleString()} total</span> : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plans, users, schools, or courses…"
            aria-label="Search lesson plans"
            className="w-full rounded-lg border border-edge bg-paper py-2 pl-8 pr-3 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
        <select
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          aria-label="Filter lesson plans by user"
          className="min-w-52 rounded-lg border border-edge bg-paper px-2.5 py-2 text-sm text-ink outline-none focus:border-accent"
        >
          <option value="">All users</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.email}</option>)}
        </select>
      </div>

      {isLoading ? (
        <p className="mt-4 text-sm text-ink-muted">Loading lesson plans…</p>
      ) : isError ? (
        <p className="mt-4 text-sm text-mark">Could not load lesson plans.</p>
      ) : plans.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">No lesson plans match those filters.</p>
      ) : (
        <div className="mt-4 divide-y divide-edge rounded-lg border border-edge">
          {plans.map((plan) => (
            <div
              key={plan.id}
              className={`flex w-full flex-wrap items-center gap-3 px-3 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg ${selectedId === plan.id ? 'bg-accent-tint' : 'bg-paper'}`}
            >
              <button
                type="button"
                onClick={() => setSelectedId(plan.id)}
                className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                aria-label={`Open ${plan.week_label || 'untitled lesson plan'}`}
              >
                <span className="block truncate text-sm font-medium text-ink">{plan.week_label || 'Untitled lesson plan'}</span>
                <span className="mt-0.5 block truncate text-xs text-ink-muted">
                  {plan.user_name || plan.user_email} · {plan.course || 'Course not recorded'}
                  {plan.school_name ? ` · ${plan.school_name}` : ''}
                </span>
              </button>
              <span className="flex shrink-0 items-center gap-3 text-2xs text-ink-muted">
                <span>{new Date(plan.created_at).toLocaleDateString()}</span>
                <span className={plan.document_status === 'ready' ? 'text-ok' : plan.document_status === 'failed' ? 'text-mark' : 'text-ink-muted'}>
                  {plan.document_status === 'ready' ? 'DOCX ready' : plan.document_status === 'not_ready' ? 'No DOCX' : plan.document_status}
                </span>
              </span>
              <AdminDocxDownloadButton planId={plan.id} />
            </div>
          ))}
        </div>
      )}

      {selectedId ? <AdminPlanDetail planId={selectedId} onClose={() => setSelectedId(null)} /> : null}

      {pageCount > 1 ? (
        <div className="mt-4 flex items-center justify-between text-xs text-ink-muted">
          <span>Page {page + 1} of {pageCount}</span>
          <div className="flex gap-2">
            <button type="button" className="btn text-xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</button>
            <button type="button" className="btn text-xs" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* A deterministic check, not a feedback loop — every plan's cited standard
 * codes, checked against its own class's subject and grade, plus against
 * the corpus at all. Runs automatically (no button to remember to press):
 * a handful of in-memory dict lookups per plan against an already-cached
 * corpus (backend/qa.py), not a fresh model call. Clean plans (the
 * expected common case) are simply not in the list — this only ever shows
 * up as something worth looking at, never a wall of green checkmarks. */
function StandardsCheckSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'qa', 'standards-check'],
    queryFn: () => api.adminStandardsCheck(),
  })
  const flagged = data?.flagged ?? []

  return (
    <div className="neo-world neo-panel mt-8 rounded-xl p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} aria-hidden="true" className="text-ink-muted" />
        <h2 className="text-sm font-semibold text-ink">Standards check</h2>
      </div>
      <p className="mt-1 text-2xs text-ink-muted">
        Every plan's cited standard codes, checked against its own class's subject and grade —
        a code that's real but belongs to a different course or grade, or one that doesn't exist
        in the corpus at all.
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-ink-muted">Checking…</p>
      ) : isError ? (
        <p className="mt-3 text-sm text-mark">Could not run the check.</p>
      ) : flagged.length === 0 ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-ok">
          <CheckCircle2 size={14} aria-hidden="true" /> No issues found.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {flagged.map((f) => (
            <li key={f.plan_id} className="rounded-lg border border-mark/30 bg-mark-tint p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  {f.week_label} <span className="text-ink-muted">· {f.email}</span>
                </p>
                <span className="inline-flex items-center gap-1 text-2xs font-medium text-mark">
                  <AlertTriangle size={12} aria-hidden="true" />
                  {f.subject} · grade {f.grade}
                </span>
              </div>
              {f.hallucinated.length ? (
                <p className="mt-1.5 text-xs text-ink-soft">
                  <span className="font-medium text-mark">Not in the corpus:</span>{' '}
                  {f.hallucinated.join(', ')}
                </p>
              ) : null}
              {f.mismatched.length ? (
                <p className="mt-1 text-xs text-ink-soft">
                  <span className="font-medium text-mark">Wrong course/grade:</span>{' '}
                  {f.mismatched.join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'free', label: 'Free' },
  { key: 'subscribed', label: 'Subscribed' },
  { key: 'comped', label: 'Comped' },
]

// What each sortable column actually sorts on — plain values, so the same
// comparator works for every column instead of one bespoke sort per column.
const SORT_ACCESSORS = {
  name: (a) => (a.name || a.email || '').toLowerCase(),
  status: (a) => a.subscription_status || '',
  plans_built: (a) => a.plans_built || 0,
  tokens_7d: (a) => a.tokens_7d || 0,
  avg_day: (a) => a.tokens_avg_day_30d || 0,
  last_active: (a) => a.last_plan_at || '',
  joined: (a) => a.created_at || '',
}

function SortHeader({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey
  return (
    <th className="px-3 py-2 font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 transition-colors hover:text-ink"
      >
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ChevronUp size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )
        ) : null}
      </button>
    </th>
  )
}

/* Curated schools — a calendar switch, not a CRUD showcase. Registering one
   here never writes or parses a calendar file; it only points at one that
   already exists on disk (backend/context/calendars/<id>.md), which is what
   the copy below says outright. See db.py migration 23 / routes/admin.py's
   create_school_route for why: this app deliberately has no self-serve
   calendar upload, only a curated, hand-authored list. */
function SchoolsAdmin() {
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: schools = [], isLoading, isError } = useQuery({
    queryKey: qk.schools,
    queryFn: () => api.listSchools(),
  })
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState(null)

  const addSchool = async (e) => {
    e.preventDefault()
    if (!newId.trim() || !newName.trim()) return
    setSaving(true)
    try {
      await api.adminCreateSchool(newId.trim(), newName.trim())
      await qc.invalidateQueries({ queryKey: qk.schools })
      setNewId('')
      setNewName('')
      toast.success(`${newName.trim()} added`)
    } catch (err) {
      toast.apiError('Could not add that school', err)
    } finally {
      setSaving(false)
    }
  }

  const removeSchool = async (school) => {
    const ok = await confirm({
      title: `Remove ${school.name}?`,
      body: 'Fails safely if any account is still set to this school — reassign them first.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    setRemovingId(school.id)
    try {
      await api.adminDeleteSchool(school.id)
      await qc.invalidateQueries({ queryKey: qk.schools })
      toast.success(`${school.name} removed`)
    } catch (err) {
      toast.apiError('Could not remove that school', err)
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="neo-world neo-panel mt-8 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-ink">Schools</h2>
      <p className="mt-1 text-2xs text-ink-muted">
        Add <code>backend/context/calendars/&lt;id&gt;.md</code> and commit it before registering
        here — this only points at a calendar file that already exists, it never writes or
        parses one.
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-ink-muted">Loading…</p>
      ) : isError ? (
        <p className="mt-3 text-sm text-mark">Could not load schools.</p>
      ) : (
        <ul className="mt-3 divide-y divide-edge">
          {schools.map((s) => (
            <li key={s.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                {s.name} <span className="text-ink-faint">({s.id})</span>
              </span>
              <button
                type="button"
                className="btn-icon"
                disabled={removingId === s.id}
                onClick={() => removeSchool(s)}
                aria-label={`Remove ${s.name}`}
                title="Remove this school"
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addSchool} className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          placeholder="id (e.g. springfield-ms)"
          aria-label="School id"
          className="rounded-lg border border-edge bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
        />
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Display name"
          aria-label="School display name"
          className="rounded-lg border border-edge bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={saving || !newId.trim() || !newName.trim()}
          className="btn inline-flex items-center gap-1.5 text-xs"
        >
          <Plus size={13} aria-hidden="true" /> Add
        </button>
      </form>

      <PendingCalendarSubmissions />
      <PendingSchoolTemplates />
      <AutoActivatedTemplates />
      <BuilderCodegenQueue />
      <AutoVerifiedBuilders />
    </div>
  )
}

/* The queue behind teacher-submitted calendars (routes/school_calendars.py)
 * — peer confirmation is the normal path, this is the backstop for a school
 * with only one teacher on the app so far, or a submission nobody's gotten
 * to yet. */
function PendingCalendarSubmissions() {
  const toast = useToast()
  const qc = useQueryClient()
  const [decidingId, setDecidingId] = useState(null)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'calendarSubmissions', 'pending'],
    queryFn: () => api.adminListCalendarSubmissions('pending'),
  })
  const submissions = data?.submissions || []

  const decide = async (submission, action) => {
    setDecidingId(submission.id)
    try {
      if (action === 'approve') {
        await api.adminApproveCalendarSubmission(submission.id)
        toast.success(`Calendar confirmed for that school`)
      } else {
        await api.adminRejectCalendarSubmission(submission.id)
        toast.success('Submission rejected')
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['admin', 'calendarSubmissions', 'pending'] }),
        qc.invalidateQueries({ queryKey: qk.schools }),
      ])
    } catch (err) {
      toast.apiError('Could not decide that submission', err)
    } finally {
      setDecidingId(null)
    }
  }

  if (isLoading || isError || !submissions.length) return null

  return (
    <div className="mt-5 border-t border-edge pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Pending calendar submissions ({submissions.length})
      </h3>
      <ul className="mt-2 divide-y divide-edge">
        {submissions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div>
              <span className="font-medium text-ink">{s.school_id}</span>{' '}
              <span className="text-2xs text-ink-muted">
                submitted {new Date(s.submitted_at).toLocaleDateString()} via {s.source_kind}
                {s.source_name ? ` (${s.source_name})` : ''} · {s.weeks?.length ?? 0} weeks
              </span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={decidingId === s.id}
                onClick={() => decide(s, 'approve')}
                className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={decidingId === s.id}
                onClick={() => decide(s, 'reject')}
                className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// analysis_status -> badge look. 'pending'/'analyzing' shouldn't linger in
// practice (the upload endpoint runs the pipeline inline before it ever
// returns), but both are handled rather than falling through to 'unknown'
// styling, since a crashed worker or an old row is exactly when an admin
// most needs the badge to still make sense.
const TEMPLATE_STATUS_STYLE = {
  analyzed: { label: 'Analyzed', className: 'bg-emerald-500/10 text-emerald-600' },
  analyzed_with_warnings: { label: 'Analyzed — warnings', className: 'bg-amber-500/10 text-amber-600' },
  failed: { label: 'Analysis failed', className: 'bg-red-500/10 text-red-600' },
  analyzing: { label: 'Analyzing…', className: 'bg-sky-500/10 text-sky-600' },
  pending: { label: 'Not yet analyzed', className: 'bg-ink-muted/10 text-ink-muted' },
}

const FINDING_SEVERITY_STYLE = {
  error: { label: 'Error', className: 'text-red-600' },
  warning: { label: 'Warning', className: 'text-amber-600' },
  info: { label: 'Info', className: 'text-ink-muted' },
}

function TemplateStatusBadge({ status }) {
  const style = TEMPLATE_STATUS_STYLE[status] || TEMPLATE_STATUS_STYLE.pending
  return (
    <span className={`rounded px-1.5 py-0.5 text-2xs font-medium ${style.className}`}>{style.label}</span>
  )
}

function TemplateAnalysisDetail({ templateId, onChanged }) {
  const toast = useToast()
  const [reanalyzing, setReanalyzing] = useState(false)
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin', 'schoolTemplates', 'analysis', templateId],
    queryFn: () => api.getTemplateAnalysis(templateId),
  })

  const reanalyze = async () => {
    setReanalyzing(true)
    try {
      await api.reanalyzeTemplate(templateId)
      await refetch()
      onChanged?.()
      toast.success('Re-analysis complete')
    } catch (err) {
      toast.apiError('Re-analysis failed', err)
    } finally {
      setReanalyzing(false)
    }
  }

  if (isLoading) return <p className="py-2 text-2xs text-ink-muted">Loading analysis…</p>
  if (isError || !data) return <p className="py-2 text-2xs text-red-600">Could not load the analysis detail.</p>

  const findings = data.findings || []
  const sections = data.analysis?.sections || []

  return (
    <div className="space-y-3 rounded border border-edge bg-surface-muted/40 p-3 text-2xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold uppercase tracking-wide text-ink-muted">Quality checks</span>
        <button
          type="button"
          disabled={reanalyzing}
          onClick={reanalyze}
          className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reanalyzing ? 'Re-analyzing…' : 'Re-analyze'}
        </button>
      </div>

      {findings.length === 0 ? (
        <p className="text-ink-muted">No findings recorded — nothing has flagged this template yet.</p>
      ) : (
        <ul className="space-y-1">
          {findings.map((f, i) => {
            const sev = FINDING_SEVERITY_STYLE[f.severity] || FINDING_SEVERITY_STYLE.info
            return (
              <li key={i} className="flex gap-2">
                <span className={`shrink-0 font-semibold ${sev.className}`}>{sev.label}</span>
                <span className="text-ink-muted">
                  <span className="text-ink">{f.check_name}</span> — {f.message}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {sections.length > 0 && (
        <div>
          <span className="font-semibold uppercase tracking-wide text-ink-muted">
            Proposed sections ({sections.length})
          </span>
          <ul className="mt-1 space-y-1.5">
            {sections.map((s, i) => (
              <li key={i}>
                <span className="font-medium text-ink">{s.name}</span>
                <span className="text-ink-muted"> — {s.description}</span>
                <div className="text-ink-muted italic">from: "{s.source_evidence}"</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {typeof data.analysis?.overall_confidence === 'number' && (
        <p className="text-ink-muted">
          Model confidence: {Math.round(data.analysis.overall_confidence * 100)}%
          {data.analysis.recommended_for_auto_use ? ' — recommended for auto-use' : ' — recommends human review'}
        </p>
      )}
    </div>
  )
}

function PendingSchoolTemplates() {
  const toast = useToast()
  const qc = useQueryClient()
  const [activatingId, setActivatingId] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'schoolTemplates', 'pending'],
    queryFn: () => api.listPendingTemplates(),
  })
  const templates = data?.templates || []

  const activate = async (template) => {
    setActivatingId(template.id)
    try {
      await api.adminActivateTemplate(template.school_id, template.id)
      toast.success(`${template.school_name} template marked as the school default`)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['admin', 'schoolTemplates', 'pending'] }),
        qc.invalidateQueries({ queryKey: qk.schools }),
      ])
    } catch (err) {
      toast.apiError('Could not activate that template', err)
    } finally {
      setActivatingId(null)
    }
  }

  if (isLoading || isError || !templates.length) return null

  return (
    <div className="mt-5 border-t border-edge pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Pending School Templates ({templates.length})
      </h3>
      <ul className="mt-2 divide-y divide-edge">
        {templates.map((t) => {
          const isExpanded = expandedId === t.id
          return (
            <li key={t.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-ink">{t.school_name}</span>{' '}
                  <TemplateStatusBadge status={t.analysis_status} />{' '}
                  <span className="text-2xs text-ink-muted">
                    submitted · {new Date(t.created_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex gap-2">
                  <a href={api.templateDownloadUrl(t.id)} download className="btn text-2xs">
                    Download Doc
                  </a>
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : t.id)}
                    className="btn flex items-center gap-1 text-2xs"
                  >
                    Analysis {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <button
                    type="button"
                    disabled={activatingId === t.id}
                    onClick={() => activate(t)}
                    className="btn text-2xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Make School Default
                  </button>
                </div>
              </div>
              {isExpanded && (
                <div className="mt-2">
                  <TemplateAnalysisDetail
                    templateId={t.id}
                    onChanged={() => qc.invalidateQueries({ queryKey: ['admin', 'schoolTemplates', 'pending'] })}
                  />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function AutoActivatedTemplates() {
  // The only place an auto-activated school is still visible as such — it
  // no longer shows up in PendingSchoolTemplates once its status flips to
  // 'active', so this is what lets an admin see what the pipeline decided
  // on its own, after the fact, without needing to go looking for it.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'schoolTemplates', 'autoActivated'],
    queryFn: () => api.listAutoActivatedTemplates(),
  })
  const templates = data?.templates || []

  if (isLoading || isError || !templates.length) return null

  return (
    <div className="mt-5 border-t border-edge pt-4">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        <ShieldCheck size={14} className="text-emerald-600" />
        Auto-Activated Templates ({templates.length})
      </h3>
      <p className="mt-1 text-2xs text-ink-muted">
        These went live automatically — every quality check passed with zero findings, so no admin review was
        needed. Download and spot-check any of these if you want a second opinion.
      </p>
      <ul className="mt-2 divide-y divide-edge">
        {templates.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div>
              <span className="font-medium text-ink">{t.school_name}</span>{' '}
              <span className="text-2xs text-ink-muted">
                activated ·{' '}
                {new Date(t.analyzed_at || t.created_at).toLocaleDateString()}
              </span>
            </div>
            <a href={api.templateDownloadUrl(t.id)} download className="btn text-2xs">
              Download Doc
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

const BUILDER_JOB_STATUS_STYLE = {
  queued: { label: 'Queued', className: 'bg-surface-muted text-ink-muted' },
  running: { label: 'Running', className: 'bg-sky-500/15 text-sky-600' },
  succeeded: { label: 'Passed — needs approval', className: 'bg-emerald-500/15 text-emerald-600' },
  failed_needs_human: { label: 'Failed — needs a human', className: 'bg-red-500/15 text-red-600' },
}

function BuilderJobStatusBadge({ status }) {
  const style = BUILDER_JOB_STATUS_STYLE[status] || BUILDER_JOB_STATUS_STYLE.queued
  return <span className={`rounded px-1.5 py-0.5 text-2xs font-medium ${style.className}`}>{style.label}</span>
}

/* One attempt's spec + both independent vision-judge verdicts — the
   "documented near-miss" a failed job hands an admin to finish from, per
   backend/builder/codegen.py's own reasoning for persisting every attempt
   rather than just the last one. */
function BuilderCodegenAttempt({ jobId, attempt }) {
  const [expanded, setExpanded] = useState(false)
  const judges = [attempt.judge1, attempt.judge2].filter(Boolean)

  return (
    <li className="rounded border border-edge p-2 text-2xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">
          Attempt {attempt.attempt_number} — {attempt.passed ? (
            <span className="text-emerald-600">passed both judges</span>
          ) : (
            <span className="text-red-600">failed</span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {attempt.render_image_path && (
            <a
              href={api.builderCodegenAttemptRenderUrl(jobId, attempt.attempt_number)}
              download
              className="btn text-2xs"
            >
              Download .docx
            </a>
          )}
          <button type="button" onClick={() => setExpanded((v) => !v)} className="btn flex items-center gap-1 text-2xs">
            Detail {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2">
          {judges.length > 0 ? (
            judges.map((j, i) => (
              <div key={i} className="rounded bg-surface-muted/40 p-2">
                <span className="font-semibold text-ink">Judge {i + 1}:</span>{' '}
                <span className={j.pass ? 'text-emerald-600' : 'text-red-600'}>
                  {j.pass ? 'pass' : 'fail'}
                </span>{' '}
                <span className="text-ink-muted">({Math.round((j.confidence || 0) * 100)}% confidence)</span>
                <p className="mt-1 text-ink-muted">{j.reasoning}</p>
                {(j.visual_defects || []).length > 0 && (
                  <p className="mt-1 text-red-600">Defects: {j.visual_defects.join('; ')}</p>
                )}
                {(j.per_field_checks || []).filter((c) => !c.correct_cell).length > 0 && (
                  <p className="mt-1 text-red-600">
                    Misplaced: {j.per_field_checks.filter((c) => !c.correct_cell).map((c) => c.field).join(', ')}
                  </p>
                )}
              </div>
            ))
          ) : (
            <p className="text-ink-muted">This attempt was rejected before rendering — see the spec below.</p>
          )}
          {attempt.layout_spec && (
            <pre className="max-h-48 overflow-auto rounded bg-surface-muted/40 p-2 text-2xs text-ink-muted">
              {JSON.stringify(attempt.layout_spec, null, 2)}
            </pre>
          )}
        </div>
      )}
    </li>
  )
}

function BuilderCodegenJobDetail({ jobId }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'builderCodegen', 'job', jobId],
    queryFn: () => api.getBuilderCodegenJob(jobId),
  })

  if (isLoading) return <p className="py-2 text-2xs text-ink-muted">Loading attempt history…</p>
  if (isError || !data) return <p className="py-2 text-2xs text-red-600">Could not load this job's attempts.</p>

  const attempts = data.attempts || []
  if (!attempts.length) return <p className="py-2 text-2xs text-ink-muted">No attempts recorded yet.</p>

  return (
    <ul className="mt-2 space-y-2">
      {attempts.map((a) => (
        <BuilderCodegenAttempt key={a.id} jobId={jobId} attempt={a} />
      ))}
    </ul>
  )
}

/* Every job here has EITHER exhausted its retry budget (failed_needs_human)
   OR passed both vision judges but wasn't clean enough on the template side
   to qualify for auto-verify (AutoVerifiedBuilders, below) — a manual
   approve is still required. See backend/builder/codegen.py's module
   docstring for the exact bar. */
function BuilderCodegenQueue() {
  const toast = useToast()
  const qc = useQueryClient()
  const [busyId, setBusyId] = useState(null)
  const [expandedId, setExpandedId] = useState(null)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'builderCodegen', 'pending'],
    queryFn: () => api.listPendingBuilderCodegenJobs(),
  })
  const jobs = data?.jobs || []

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['admin', 'builderCodegen', 'pending'] }),
      qc.invalidateQueries({ queryKey: qk.schools }),
    ])

  const approve = async (job) => {
    setBusyId(job.id)
    try {
      await api.approveBuilderCodegenJob(job.id)
      toast.success(`${job.school_name} builder approved — it can generate real documents now`)
      await invalidate()
    } catch (err) {
      toast.apiError('Could not approve that builder', err)
    } finally {
      setBusyId(null)
    }
  }

  const retry = async (job) => {
    setBusyId(job.id)
    try {
      await api.retryBuilderCodegenJob(job.id)
      toast.success(`${job.school_name} builder queued for another attempt`)
      await invalidate()
    } catch (err) {
      toast.apiError('Could not retry that builder', err)
    } finally {
      setBusyId(null)
    }
  }

  if (isLoading || isError || !jobs.length) return null

  return (
    <div className="mt-5 border-t border-edge pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Builder Codegen Queue ({jobs.length})
      </h3>
      <p className="mt-1 text-2xs text-ink-muted">
        Automated document-builder generation for schools without a hand-written builder script. A job here needs
        your review either way: it ran out of attempts, or it passed but still needs your approval before it can
        generate real documents for a teacher.
      </p>
      <ul className="mt-2 divide-y divide-edge">
        {jobs.map((job) => {
          const isExpanded = expandedId === job.id
          const canApprove = job.status === 'succeeded'
          return (
            <li key={job.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-ink">{job.school_name}</span>{' '}
                  <BuilderJobStatusBadge status={job.status} />{' '}
                  <span className="text-2xs text-ink-muted">
                    {job.attempt_count} attempt{job.attempt_count === 1 ? '' : 's'} · {new Date(job.created_at).toLocaleDateString()}
                  </span>
                  {job.error_message && <p className="text-2xs text-red-600">{job.error_message}</p>}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : job.id)}
                    className="btn flex items-center gap-1 text-2xs"
                  >
                    Attempts {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <button
                    type="button"
                    disabled={busyId === job.id}
                    onClick={() => retry(job)}
                    className="btn flex items-center gap-1 text-2xs disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw size={12} /> Retry
                  </button>
                  {canApprove && (
                    <button
                      type="button"
                      disabled={busyId === job.id}
                      onClick={() => approve(job)}
                      className="btn flex items-center gap-1 text-2xs disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <CheckCircle2 size={12} /> Approve
                    </button>
                  )}
                </div>
              </div>
              {isExpanded && <BuilderCodegenJobDetail jobId={job.id} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* The audit trail for the auto-verify fast path (migration 55,
   backend/builder/codegen.py's _meets_auto_verify_bar) — every builder that
   went live with no admin ever clicking approve, most recent first. Mirrors
   AutoActivatedTemplates' own shape one stage further down the pipeline: a
   verified document BUILDER, not just an analyzed template format. */
function AutoVerifiedBuilders() {
  const [expandedId, setExpandedId] = useState(null)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'builderCodegen', 'autoVerified'],
    queryFn: () => api.listAutoVerifiedBuilderCodegenJobs(),
  })
  const jobs = data?.jobs || []

  if (isLoading || isError || !jobs.length) return null

  return (
    <div className="mt-5 border-t border-edge pt-4">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
        <ShieldCheck size={14} className="text-emerald-600" />
        Auto-Verified Builders ({jobs.length})
      </h3>
      <p className="mt-1 text-2xs text-ink-muted">
        These went live automatically — the template's own analysis was clean enough to auto-activate AND this
        builder passed both vision judges, so no admin approval was needed. Expand any of these for the full attempt
        history if you want a second opinion.
      </p>
      <ul className="mt-2 divide-y divide-edge">
        {jobs.map((job) => {
          const isExpanded = expandedId === job.id
          return (
            <li key={job.id} className="py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-ink">{job.school_name}</span>{' '}
                  <span className="text-2xs text-ink-muted">
                    uploaded by {job.uploader_name || job.uploader_email || 'unknown'} · verified{' '}
                    {new Date(job.verified_at || job.finished_at).toLocaleDateString()}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : job.id)}
                  className="btn flex items-center gap-1 text-2xs"
                >
                  Attempts {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                </button>
              </div>
              {isExpanded && <BuilderCodegenJobDetail jobId={job.id} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* Revenue and payment-risk without a Stripe dashboard login. Read-only —
   there is nothing here for an admin to edit; everything that changes a
   subscription happens on Stripe's own hosted pages (checkout, portal), and
   this app never touches a card. MRR is an estimate (routes/admin.py's own
   comment explains why), not a Stripe-reported figure. */
function BillingAdmin() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'billing'],
    queryFn: () => api.adminBilling(),
  })

  if (isLoading || !data) return <p className="mt-8 text-sm text-ink-muted">Loading…</p>
  if (isError) return <p className="mt-8 text-sm text-mark">Could not load billing data.</p>

  const counts = data.counts || {}
  const statusOrder = ['active', 'trialing', 'past_due', 'comped', 'canceled', 'none']
  const pastDue = data.past_due_accounts || []

  return (
    <div className="mt-8 space-y-6">
      <div className="neo-world neo-panel rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ink">Revenue</h2>
        {!data.billing_enabled ? (
          <p className="mt-3 text-sm text-ink-muted">
            Billing isn't configured yet (no Stripe keys) — every account may generate for free.
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-6 text-sm">
            <div>
              <div className="text-2xs uppercase tracking-wide text-ink-muted">Estimated MRR</div>
              <div className="font-mono text-lg text-ink">
                {formatCents(data.mrr_cents, data.price?.currency)}
              </div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wide text-ink-muted">Paying accounts</div>
              <div className="font-mono text-ink-soft">{data.paying_accounts}</div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wide text-ink-muted">Price</div>
              <div className="font-mono text-ink-soft">
                {data.price ? `${formatCents(data.price.amount, data.price.currency)} / ${data.price.interval}` : '—'}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="neo-world neo-panel rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ink">Accounts by status</h2>
        <div className="mt-3 flex flex-wrap gap-6 text-sm">
          {statusOrder
            .filter((s) => counts[s])
            .map((s) => (
              <div key={s}>
                <div className="text-2xs uppercase tracking-wide text-ink-muted">{STATUS_LABELS[s] || s}</div>
                <div className="font-mono text-ink-soft">{counts[s]}</div>
              </div>
            ))}
        </div>
      </div>

      <div className="neo-world neo-panel rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ink">Payment at risk</h2>
        <p className="mt-1 text-2xs text-ink-muted">
          Accounts whose card failed on renewal — Stripe will keep retrying, but access lapses if it never succeeds.
        </p>
        {pastDue.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">No accounts currently past due.</p>
        ) : (
          <ul className="mt-3 divide-y divide-edge">
            {pastDue.map((a) => (
              <li key={a.id} className="py-2 text-sm">
                <div className="font-medium text-ink">{a.name}</div>
                <div className="text-2xs text-ink-muted">{a.email}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/* The two weekly token caps entitlement.py enforces (backend/entitlement.py),
   editable here instead of only via config.py + a redeploy. Everything else
   in config.py — Stripe keys, retrieval floors, TTS model — stays env-only on
   purpose: those are either security-sensitive or measured constants (see
   config.py's own comments), not knobs an admin should turn casually. These
   two are the one pair actually likely to need tuning in response to real
   usage, so they get a form; nothing else does yet. */
function SettingsAdmin() {
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { data: appSettings, isLoading, isError } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.adminGetSettings(),
  })
  const { data: auditData, isLoading: auditLoading, isError: auditError } = useQuery({
    queryKey: ['admin', 'audit-log'],
    queryFn: () => api.adminAuditLog({ limit: 20 }),
  })
  const [freeCap, setFreeCap] = useState('')
  const [subscriberCap, setSubscriberCap] = useState('')
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)

  const startEditing = () => {
    setFreeCap(String(appSettings.free_weekly_token_cap))
    setSubscriberCap(String(appSettings.subscriber_weekly_token_cap))
    setEditing(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const free = Number(freeCap)
    const subscriber = Number(subscriberCap)
    if (!Number.isInteger(free) || free <= 0 || !Number.isInteger(subscriber) || subscriber <= 0) {
      toast.error('Both caps must be whole numbers greater than zero.')
      return
    }
    if (subscriber < free) {
      toast.error('Subscriber cap must be at least the free cap.')
      return
    }
    const ok = await confirm({
      title: 'Update weekly token caps?',
      body: 'This changes the usage limit for every account immediately — not just new signups.',
      confirmLabel: 'Update',
      tone: 'default',
    })
    if (!ok) return
    setSaving(true)
    try {
      await api.adminUpdateSettings(free, subscriber)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['admin', 'settings'] }),
        qc.invalidateQueries({ queryKey: ['admin', 'audit-log'] }),
      ])
      setEditing(false)
      toast.success('Token caps updated')
    } catch (err) {
      toast.apiError('Could not update settings', err)
    } finally {
      setSaving(false)
    }
  }

  const entries = auditData?.entries ?? []

  return (
    <div className="mt-8 space-y-6">
      <div className="neo-world neo-panel rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ink">Weekly token caps</h2>
        <p className="mt-1 text-2xs text-ink-muted">
          What entitlement.py enforces before refusing a generation — a rolling 7-day window, per account.
        </p>

        {isLoading || !appSettings ? (
          <p className="mt-3 text-sm text-ink-muted">Loading…</p>
        ) : isError ? (
          <p className="mt-3 text-sm text-mark">Could not load settings.</p>
        ) : editing ? (
          <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-2xs text-ink-muted">
              Free cap (tokens/week)
              <input
                type="number"
                min="1"
                value={freeCap}
                onChange={(e) => setFreeCap(e.target.value)}
                className="w-40 rounded-lg border border-edge bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1 text-2xs text-ink-muted">
              Subscriber cap (tokens/week)
              <input
                type="number"
                min="1"
                value={subscriberCap}
                onChange={(e) => setSubscriberCap(e.target.value)}
                className="w-40 rounded-lg border border-edge bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </label>
            <button type="submit" disabled={saving} className="btn text-xs">
              Save
            </button>
            <button
              type="button"
              className="text-xs text-ink-muted hover:text-ink"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-6 text-sm">
            <div>
              <div className="text-2xs uppercase tracking-wide text-ink-muted">Free</div>
              <div className="font-mono text-ink-soft">{appSettings.free_weekly_token_cap.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-2xs uppercase tracking-wide text-ink-muted">Subscriber</div>
              <div className="font-mono text-ink-soft">{appSettings.subscriber_weekly_token_cap.toLocaleString()}</div>
            </div>
            <button type="button" className="btn text-xs" onClick={startEditing}>
              Edit
            </button>
          </div>
        )}
      </div>

      <div className="neo-world neo-panel rounded-xl p-4">
        <h2 className="text-sm font-semibold text-ink">Recent admin activity</h2>
        <p className="mt-1 text-2xs text-ink-muted">
          Every comp grant/revoke, school change, and settings update — who did it and when.
        </p>

        {auditLoading ? (
          <p className="mt-3 text-sm text-ink-muted">Loading…</p>
        ) : auditError ? (
          <p className="mt-3 text-sm text-mark">Could not load the audit log.</p>
        ) : entries.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">No admin actions recorded yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-edge">
            {entries.map((entry) => (
              <li key={entry.id} className="py-2 text-sm text-ink-soft">
                <span className="text-2xs text-ink-faint">{relative(entry.created_at)}</span>
                {' — '}
                {describeAuditEntry(entry)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function AdminKpi({ label, value, detail, icon: Icon, tone = 'accent' }) {
  const iconClass = tone === 'ok' ? 'bg-ok-tint text-ok' : tone === 'flag' ? 'bg-flag-tint text-flag' : tone === 'mark' ? 'bg-mark-tint text-mark' : 'bg-accent-tint text-accent-text'
  return (
    <div className="neo-world neo-panel rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-ink">{value}</p>
          <p className="mt-1 text-xs text-ink-muted">{detail}</p>
        </div>
        <span className={`rounded-xl p-2 ${iconClass}`}><Icon size={17} aria-hidden="true" /></span>
      </div>
    </div>
  )
}

function AdminOverview({ accounts, onNavigate }) {
  const summary = useMemo(() => {
    const activeThisWeek = accounts.filter((account) => {
      if (!account.last_plan_at) return false
      return Date.now() - new Date(account.last_plan_at).getTime() <= 7 * 86400000
    }).length
    const paying = accounts.filter((account) => tier(account) === 'subscribed').length
    const contextReady = accounts.filter((account) => {
      const context = account.learning_context || {}
      return context.pacing_guides?.active_count > 0 || context.calendar?.status === 'confirmed'
    }).length
    const attention = accounts.filter((account) => {
      const cap = capStatusFor(account)
      const calendarStatus = account.learning_context?.calendar?.status
      const pacingReady = account.learning_context?.pacing_guides?.active_count > 0
      return cap.tone !== 'ok' || !pacingReady || calendarStatus === 'pending' || calendarStatus === 'rejected'
    }).length
    const tokens = accounts.reduce((sum, account) => sum + (account.tokens_7d || 0), 0)
    const topAccounts = [...accounts].sort((a, b) => (b.tokens_7d || 0) - (a.tokens_7d || 0)).slice(0, 5)
    return { activeThisWeek, paying, contextReady, attention, tokens, topAccounts }
  }, [accounts])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-2xs font-semibold uppercase tracking-[0.16em] text-accent-text">Operations center</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">Good afternoon, Josh</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">A quick read on customers, usage, and the planning context that keeps lesson generation reliable.</p>
        </div>
        <div className="flex items-center gap-2 text-2xs text-ink-muted">
          <span className="h-2 w-2 rounded-full bg-ok" /> Live account data
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminKpi label="Customers" value={accounts.length} detail={`${summary.activeThisWeek} active this week`} icon={Users} />
        <AdminKpi label="Paying customers" value={summary.paying} detail={accounts.length ? `${Math.round((summary.paying / accounts.length) * 100)}% of accounts` : 'No accounts yet'} icon={CircleDollarSign} tone="ok" />
        <AdminKpi label="Planning context" value={summary.contextReady} detail="Have a guide or confirmed calendar" icon={FileText} tone="ok" />
        <AdminKpi label="Needs attention" value={summary.attention} detail="Usage, billing, or context follow-up" icon={Activity} tone={summary.attention ? 'flag' : 'ok'} />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-accent/20 bg-accent-tint/40 p-3">
        <span className="mr-1 text-xs font-semibold text-ink">Jump to</span>
        <button type="button" className="btn inline-flex items-center gap-1.5 text-xs" onClick={() => onNavigate('users')}><Users size={13} aria-hidden="true" /> Customers</button>
        <button type="button" className="btn inline-flex items-center gap-1.5 text-xs" onClick={() => onNavigate('plans')}><BookOpen size={13} aria-hidden="true" /> Lesson plans</button>
        <button type="button" className="btn inline-flex items-center gap-1.5 text-xs" onClick={() => onNavigate('schools')}><Building2 size={13} aria-hidden="true" /> Schools</button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.45fr_1fr]">
        <div className="neo-world neo-panel rounded-2xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><BarChart3 size={16} className="text-accent-text" aria-hidden="true" /><h3 className="text-sm font-semibold text-ink">Usage pulse</h3></div>
              <p className="mt-1 text-2xs text-ink-muted">Token activity across the last seven days.</p>
            </div>
            <span className="font-mono text-sm text-ink-soft">{summary.tokens.toLocaleString()} tokens</span>
          </div>
          <div className="mt-4"><UsageTrendChart /></div>
        </div>

        <div className="neo-world neo-panel rounded-2xl p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2"><AlertTriangle size={16} className="text-flag" aria-hidden="true" /><h3 className="text-sm font-semibold text-ink">Needs attention</h3></div>
              <p className="mt-1 text-2xs text-ink-muted">Accounts worth opening first.</p>
            </div>
            <button type="button" className="text-2xs font-medium text-accent-text hover:underline" onClick={() => onNavigate('users')}>View all <ArrowUpRight size={12} className="inline" aria-hidden="true" /></button>
          </div>
          <div className="mt-4 space-y-2">
            {accounts.filter((account) => {
              const context = account.learning_context || {}
              return capStatusFor(account).tone !== 'ok' || !context.pacing_guides?.active_count || ['pending', 'rejected'].includes(context.calendar?.status)
            }).slice(0, 4).map((account) => (
              <button key={account.id} type="button" onClick={() => onNavigate('users')} className="flex w-full items-center justify-between gap-3 rounded-xl border border-edge bg-paper-sunken px-3 py-2 text-left transition-colors hover:border-accent/40">
                <span className="min-w-0"><span className="block truncate text-xs font-medium text-ink">{account.name || account.email}</span><span className="block truncate text-2xs text-ink-muted">{account.learning_context?.pacing_guides?.active_count ? 'Review usage' : 'Missing pacing guide'}</span></span>
                <ArrowUpRight size={14} className="shrink-0 text-ink-faint" aria-hidden="true" />
              </button>
            ))}
            {!summary.attention ? <p className="text-sm text-ok">Everything looks healthy.</p> : null}
          </div>
        </div>
      </div>

      <div className="neo-world neo-panel rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-ink">Most active customers</h3><p className="mt-1 text-2xs text-ink-muted">Sorted by tokens used in the last seven days.</p></div><button type="button" className="text-2xs font-medium text-accent-text hover:underline" onClick={() => onNavigate('users')}>Open customer directory <ArrowUpRight size={12} className="inline" aria-hidden="true" /></button></div>
        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          {summary.topAccounts.map((account, index) => (
            <button key={account.id} type="button" onClick={() => onNavigate('users')} className="rounded-xl border border-edge bg-paper-sunken p-3 text-left transition-colors hover:border-accent/40">
              <div className="flex items-center justify-between gap-2"><span className="text-2xs font-mono text-ink-faint">0{index + 1}</span><span className="text-2xs font-mono text-ink-muted">{(account.tokens_7d || 0).toLocaleString()}</span></div>
              <p className="mt-2 truncate text-xs font-medium text-ink">{account.name || account.email}</p>
              <p className="mt-0.5 truncate text-2xs text-ink-muted">{account.email}</p>
            </button>
          ))}
          {!summary.topAccounts.length ? <p className="text-sm text-ink-muted">No customer activity yet.</p> : null}
        </div>
      </div>
    </div>
  )
}

function CustomerDetail({ account, onClose, onToggleComp, onToggleBlocked, pending }) {
  return (
    <aside className="mt-5 rounded-2xl border border-accent/30 bg-accent-tint/35 p-4" aria-label={`Customer profile for ${account.name || account.email}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-contrast"><UserRound size={18} aria-hidden="true" /></span><div><div className="flex flex-wrap items-center gap-2"><p className="text-lg font-semibold text-ink">{account.name || 'Unnamed customer'}</p>{account.is_blocked ? <BlockedPill /> : null}</div><p className="text-xs text-ink-muted">{account.email}{account.school ? ` · ${account.school}` : ''}</p><p className="mt-1 text-2xs text-ink-faint">Joined {relative(account.created_at)} · Last plan {relative(account.last_plan_at)}</p></div></div>
        <button type="button" className="btn-icon" onClick={onClose} aria-label="Close customer profile"><X size={15} aria-hidden="true" /></button>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-4">
        <div className="rounded-xl bg-paper/70 p-3"><p className="text-2xs text-ink-muted">Plans built</p><p className="mt-1 font-mono text-lg text-ink">{account.plans_built}</p></div>
        <div className="rounded-xl bg-paper/70 p-3"><p className="text-2xs text-ink-muted">Tokens, 7d</p><p className="mt-1 font-mono text-lg text-ink">{(account.tokens_7d || 0).toLocaleString()}</p></div>
        <div className="rounded-xl bg-paper/70 p-3"><p className="text-2xs text-ink-muted">Subscription</p><div className="mt-2"><StatusPill status={account.subscription_status} /></div></div>
        <div className="rounded-xl bg-paper/70 p-3"><p className="text-2xs text-ink-muted">Capacity</p><div className="mt-2"><CapStatusBadge account={account} /></div></div>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
        <div><p className="text-2xs font-semibold uppercase tracking-wide text-ink-muted">Planning context</p><div className="mt-2"><PlanningContext account={account} /></div><p className="mt-2 text-2xs text-ink-muted">Pacing guides are customer/class resources. The calendar status is shared at the school level.</p></div>
        <div className="flex flex-wrap gap-2"><CustomCapEditor account={account} /><button type="button" className="btn text-xs" disabled={pending === account.id} onClick={() => onToggleComp(account)}>{account.subscription_status === 'comped' ? 'Revoke unlimited' : 'Grant unlimited'}</button><button type="button" className={`btn text-xs ${account.is_blocked ? '' : 'text-mark'}`} disabled={pending === account.id} onClick={() => onToggleBlocked(account)}>{account.is_blocked ? 'Unblock account' : 'Block account'}</button></div>
      </div>
      {account.is_blocked ? <p className="mt-3 flex items-center gap-1.5 text-2xs font-medium text-mark"><Ban size={12} aria-hidden="true" /> This account cannot log in or use the app. Blocking does not delete its data or cancel billing.</p> : null}
    </aside>
  )
}

function AdminCustomers({ accounts, sorted, isLoading, isError, search, setSearch, statusFilter, setStatusFilter, contextFilter, setContextFilter, sort, onSort, selected, toggleSelect, allVisibleSelected, toggleSelectAllVisible, selectedCount, clearSelection, bulkBusy, bulkCap, setBulkCap, bulkComp, bulkSetCap, pending, toggleComp, toggleBlocked }) {
  const [profileId, setProfileId] = useState(null)
  const profile = accounts.find((account) => account.id === profileId)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-2xs font-semibold uppercase tracking-[0.16em] text-accent-text">Customer relationship management</p><h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">Customers</h2><p className="mt-1 max-w-2xl text-sm text-ink-muted">Search the directory, open a customer profile, and see the context that affects their experience.</p></div>
        <NewBetaAccountForm />
      </div>

      <div className="grid gap-3 sm:grid-cols-3"><AdminKpi label="Directory" value={accounts.length} detail="Total accounts" icon={Users} /><AdminKpi label="With pacing guides" value={accounts.filter((account) => account.learning_context?.pacing_guides?.active_count > 0).length} detail="At least one active guide" icon={FileText} tone="ok" /><AdminKpi label="School calendars" value={accounts.filter((account) => account.learning_context?.calendar?.status === 'confirmed').length} detail="Accounts in confirmed schools" icon={CalendarCheck2} tone="ok" /></div>

      <div className="neo-world neo-panel rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1"><Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, email, or school…" aria-label="Search customers" className="w-full rounded-xl border border-edge bg-paper py-2.5 pl-9 pr-3 text-sm text-ink outline-none focus:border-accent" />{search ? <button type="button" onClick={() => setSearch('')} aria-label="Clear customer search" className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"><X size={14} aria-hidden="true" /></button> : null}</div>
          <select value={contextFilter} onChange={(e) => setContextFilter(e.target.value)} aria-label="Filter customer context" className="rounded-xl border border-edge bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-accent"><option value="all">All context</option><option value="needs_attention">Needs attention</option><option value="pacing">Has pacing guide</option><option value="calendar">Confirmed calendar</option></select>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5"><span className="mr-1 text-2xs font-semibold uppercase tracking-wide text-ink-muted">Lifecycle</span>{STATUS_FILTERS.map((filter) => <button key={filter.key} type="button" onClick={() => setStatusFilter(filter.key)} aria-pressed={statusFilter === filter.key} className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${statusFilter === filter.key ? 'bg-ink text-paper' : 'bg-paper-inset text-ink-muted hover:text-ink'}`}>{filter.label}</button>)}</div>
      </div>

      {selectedCount > 0 ? <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-accent/30 bg-accent-tint px-4 py-3"><span className="text-xs font-medium text-accent-text">{selectedCount} selected</span><button type="button" className="btn text-xs" disabled={bulkBusy} onClick={() => bulkComp(true)}>Grant unlimited</button><button type="button" className="btn text-xs" disabled={bulkBusy} onClick={() => bulkComp(false)}>Revoke unlimited</button><input type="number" min={0} step={1000} value={bulkCap} onChange={(e) => setBulkCap(e.target.value)} placeholder="tier default" aria-label="Custom weekly token cap" className="w-28 rounded-lg border border-edge bg-paper px-2 py-1.5 text-xs text-ink outline-none focus:border-accent" /><button type="button" className="btn text-xs" disabled={bulkBusy} onClick={bulkSetCap}>Set cap</button><button type="button" className="ml-auto text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline" onClick={clearSelection}>Clear</button></div> : null}

      {isLoading ? <p className="text-sm text-ink-muted">Loading customers…</p> : isError ? <p className="text-sm text-mark">Could not load customers.</p> : sorted.length === 0 ? <div className="neo-world neo-panel rounded-2xl p-8 text-center"><Users size={24} className="mx-auto text-ink-faint" aria-hidden="true" /><p className="mt-2 text-sm font-medium text-ink">No customers match those filters.</p><p className="mt-1 text-xs text-ink-muted">Try clearing the search or choosing a different context.</p></div> : <>
      <div className="hidden overflow-x-auto rounded-2xl border border-edge lg:block"><table className="w-full text-sm"><thead><tr className="border-b border-edge bg-paper-sunken text-left text-2xs uppercase tracking-wide text-ink-muted"><th className="w-10 px-3 py-3"><input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAllVisible} aria-label="Select all visible customers" /></th><SortHeader label="Customer" sortKey="name" sort={sort} onSort={onSort} /><SortHeader label="Lifecycle" sortKey="status" sort={sort} onSort={onSort} /><SortHeader label="Activity" sortKey="tokens_7d" sort={sort} onSort={onSort} /><th className="px-3 py-3 font-medium">Planning context</th><th className="px-3 py-3 font-medium">Actions</th></tr></thead><tbody>{sorted.map((account) => <tr key={account.id} className="border-b border-edge last:border-0 hover:bg-paper-sunken/50"><td className="px-3 py-3"><input type="checkbox" checked={selected.has(account.id)} onChange={() => toggleSelect(account.id)} aria-label={`Select ${account.email}`} /></td><td className="px-3 py-3"><button type="button" onClick={() => setProfileId(account.id)} className="text-left"><span className="block font-medium text-ink hover:text-accent-text">{account.name || 'Unnamed customer'}</span><span className="mt-0.5 block text-2xs text-ink-muted">{account.email}{account.school ? ` · ${account.school}` : ''}</span></button></td><td className="px-3 py-3"><div className="flex flex-col items-start gap-1"><StatusPill status={account.subscription_status} />{account.is_blocked ? <BlockedPill /> : null}<CapStatusBadge account={account} /></div></td><td className="px-3 py-3"><span className="block font-mono text-ink-soft">{(account.tokens_7d || 0).toLocaleString()} <span className="font-sans text-2xs text-ink-muted">tokens</span></span><span className="mt-0.5 block text-2xs text-ink-muted">{account.plans_built} plans · {relative(account.last_plan_at)}</span></td><td className="px-3 py-3"><PlanningContext account={account} /></td><td className="px-3 py-3"><div className="flex items-center gap-1.5"><button type="button" className="btn inline-flex items-center gap-1 text-xs" onClick={() => setProfileId(account.id)}><UserRound size={12} aria-hidden="true" /> Open</button><button type="button" className="btn-icon" aria-label={`More actions for ${account.email}`} title="More actions"><MoreHorizontal size={15} aria-hidden="true" /></button></div></td></tr>)}</tbody></table></div>
      <ul className="flex flex-col gap-3 lg:hidden">{sorted.map((account) => <li key={account.id} className="neo-world neo-panel rounded-2xl p-4"><div className="flex items-start gap-3"><input type="checkbox" checked={selected.has(account.id)} onChange={() => toggleSelect(account.id)} aria-label={`Select ${account.email}`} className="mt-1" /><button type="button" onClick={() => setProfileId(account.id)} className="min-w-0 flex-1 text-left"><span className="block truncate font-medium text-ink">{account.name || 'Unnamed customer'}</span><span className="mt-0.5 block truncate text-2xs text-ink-muted">{account.email}</span></button><div className="flex shrink-0 flex-col items-end gap-1"><StatusPill status={account.subscription_status} />{account.is_blocked ? <BlockedPill /> : null}</div></div><div className="mt-3"><PlanningContext account={account} /></div><div className="mt-3 flex items-center justify-between border-t border-edge pt-3"><span className="text-2xs text-ink-muted">{(account.tokens_7d || 0).toLocaleString()} tokens · {account.plans_built} plans</span><button type="button" className="btn text-xs" onClick={() => setProfileId(account.id)}>Open profile</button></div></li>)}</ul>
      </>}
      {profile ? <CustomerDetail account={profile} onClose={() => setProfileId(null)} onToggleComp={toggleComp} onToggleBlocked={toggleBlocked} pending={pending} /> : null}
    </div>
  )
}

export function AdminPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { activeClass: _activeClass } = useActiveClass()



  // -- Data fetching for Accounts --
  const [pending, setPending] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [contextFilter, setContextFilter] = useState('all')
  const [activeTab, setActiveTab] = useState('overview')
  const [sort, setSort] = useState({ key: 'joined', dir: 'desc' })
  const [selected, setSelected] = useState(() => new Set())
  const [bulkCap, setBulkCap] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'accounts'],
    queryFn: () => api.adminListAccounts(),
  })
  const accounts = data?.accounts ?? []

  const onSort = (key) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }

  const q = search.trim().toLowerCase()
  const filtered = accounts
    .filter((a) => (q ? [a.name, a.email, a.school].filter(Boolean).some((value) => value.toLowerCase().includes(q)) : true))
    .filter((a) => (statusFilter === 'all' ? true : tier(a) === statusFilter))
    .filter((a) => {
      const context = a.learning_context || {}
      if (contextFilter === 'pacing') return context.pacing_guides?.active_count > 0
      if (contextFilter === 'calendar') return context.calendar?.status === 'confirmed'
      if (contextFilter === 'needs_attention') {
        return capStatusFor(a).tone !== 'ok' || !context.pacing_guides?.active_count || ['pending', 'rejected'].includes(context.calendar?.status)
      }
      return true
    })
  const accessor = SORT_ACCESSORS[sort.key] || SORT_ACCESSORS.joined
  const sorted = [...filtered].sort((a, b) => {
    const av = accessor(a)
    const bv = accessor(b)
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sort.dir === 'asc' ? cmp : -cmp
  })

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allVisibleSelected = sorted.length > 0 && sorted.every((a) => selected.has(a.id))
  const toggleSelectAllVisible = () => {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        sorted.forEach((a) => next.delete(a.id))
        return next
      }
      const next = new Set(prev)
      sorted.forEach((a) => next.add(a.id))
      return next
    })
  }
  const clearSelection = () => setSelected(new Set())

  const toggleComp = async (account) => {
    const nextComped = account.subscription_status !== 'comped'
    const ok = await confirm({
      title: nextComped ? `Grant ${account.email} unlimited access?` : `Revoke ${account.email}'s unlimited access?`,
      body: nextComped
        ? 'They will never hit the free-week limit until this is revoked.'
        : 'They will fall back to the ordinary one-week-free limit.',
      confirmLabel: nextComped ? 'Grant' : 'Revoke',
      tone: nextComped ? 'default' : 'danger',
    })
    if (!ok) return
    setPending(account.id)
    try {
      await api.adminSetComped(account.id, nextComped)
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      toast.success(
        nextComped ? `${account.email} now has unlimited access` : `${account.email} back to the ordinary free week`
      )
    } catch (err) {
      toast.apiError("Couldn't update that account", err)
    } finally {
      setPending(null)
    }
  }

  const toggleBlocked = async (account) => {
    const nextBlocked = !account.is_blocked
    const ok = await confirm({
      title: nextBlocked ? `Block ${account.email}?` : `Unblock ${account.email}?`,
      body: nextBlocked
        ? 'They will be signed out of every device and will not be able to log in. Their data and billing remain unchanged.'
        : 'They will be able to log in and use the app again. Their data and billing remain unchanged.',
      confirmLabel: nextBlocked ? 'Block account' : 'Unblock account',
      tone: nextBlocked ? 'danger' : 'default',
    })
    if (!ok) return
    setPending(account.id)
    try {
      await api.adminSetBlocked(account.id, nextBlocked)
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      toast.success(nextBlocked ? `${account.email} is blocked` : `${account.email} is unblocked`)
    } catch (err) {
      toast.apiError("Couldn't update that account", err)
    } finally {
      setPending(null)
    }
  }

  const bulkComp = async (comped) => {
    const ids = [...selected]
    if (!ids.length) return
    const ok = await confirm({
      title: comped
        ? `Grant unlimited access to ${ids.length} account${ids.length === 1 ? '' : 's'}?`
        : `Revoke unlimited access from ${ids.length} account${ids.length === 1 ? '' : 's'}?`,
      body: comped
        ? 'None of them will hit the free-week limit until this is revoked.'
        : 'They will all fall back to the ordinary one-week-free limit.',
      confirmLabel: comped ? 'Grant' : 'Revoke',
      tone: comped ? 'default' : 'danger',
    })
    if (!ok) return
    setBulkBusy(true)
    try {
      const results = await Promise.allSettled(ids.map((id) => api.adminSetComped(id, comped)))
      const failed = results.filter((r) => r.status === 'rejected').length
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      if (failed) {
        toast.error(`${ids.length - failed} of ${ids.length} updated — ${failed} failed`)
      } else {
        toast.success(`${ids.length} account${ids.length === 1 ? '' : 's'} updated`)
      }
      clearSelection()
    } finally {
      setBulkBusy(false)
    }
  }

  const bulkSetCap = async () => {
    const ids = [...selected]
    if (!ids.length) return
    const cap = bulkCap === '' ? null : Math.max(0, parseInt(bulkCap, 10) || 0)
    const ok = await confirm({
      title:
        cap == null
          ? `Clear the custom cap on ${ids.length} account${ids.length === 1 ? '' : 's'}?`
          : `Cap ${ids.length} account${ids.length === 1 ? '' : 's'} at ${cap.toLocaleString()} tokens/week?`,
      body:
        cap == null
          ? 'Each falls back to its ordinary tier default.'
          : 'Overrides each account’s tier default until cleared, in either direction.',
      confirmLabel: cap == null ? 'Clear' : 'Set cap',
    })
    if (!ok) return
    setBulkBusy(true)
    try {
      const results = await Promise.allSettled(ids.map((id) => api.adminSetCustomCap(id, cap)))
      const failed = results.filter((r) => r.status === 'rejected').length
      await qc.invalidateQueries({ queryKey: ['admin', 'accounts'] })
      if (failed) {
        toast.error(`${ids.length - failed} of ${ids.length} updated — ${failed} failed`)
      } else {
        toast.success(`${ids.length} account${ids.length === 1 ? '' : 's'} updated`)
      }
      clearSelection()
      setBulkCap('')
    } finally {
      setBulkBusy(false)
    }
  }

  // -- Tabs --
  const TABS = React.useMemo(() => [
    { id: 'overview', label: 'Overview' },
    { id: 'users', label: 'Customers', count: accounts.length || undefined },
    { id: 'plans', label: 'Lesson Plans' },
    { id: 'standards', label: 'Standards Check' },
    { id: 'schools', label: 'Schools' },
    { id: 'billing', label: 'Billing' },
    { id: 'settings', label: 'Settings' },
  ], [accounts.length])

  return (
    <SplitLayout
      title="Admin"
      icon={ShieldCheck}
      tabs={TABS}
      backPath="/"
      contentMaxWidth="max-w-6xl"
      activeTab={activeTab}
      onTabChange={setActiveTab}
      mobileTabs={TABS}
    >
      <div className="w-full max-w-6xl pb-32">
            
            {/* Overview Section */}
            <div id="section-overview" className={activeTab === 'overview' ? '' : 'hidden'}>
              {isLoading ? (
                <p className="text-sm text-ink-muted">Loading…</p>
              ) : isError ? (
                <p className="text-sm text-mark">{error?.message || 'Could not load accounts.'}</p>
              ) : (
                <AdminOverview accounts={accounts} onNavigate={setActiveTab} />
              )}
            </div>

            {/* Customer directory */}
            <div id="section-users" className={activeTab === 'users' ? '' : 'hidden'}>
              <AdminCustomers
                accounts={accounts}
                sorted={sorted}
                isLoading={isLoading}
                isError={isError}
                search={search}
                setSearch={setSearch}
                statusFilter={statusFilter}
                setStatusFilter={setStatusFilter}
                contextFilter={contextFilter}
                setContextFilter={setContextFilter}
                sort={sort}
                onSort={onSort}
                selected={selected}
                toggleSelect={toggleSelect}
                allVisibleSelected={allVisibleSelected}
                toggleSelectAllVisible={toggleSelectAllVisible}
                selectedCount={selected.size}
                clearSelection={clearSelection}
                bulkBusy={bulkBusy}
                bulkCap={bulkCap}
                setBulkCap={setBulkCap}
                bulkComp={bulkComp}
                bulkSetCap={bulkSetCap}
                pending={pending}
                toggleComp={toggleComp}
                toggleBlocked={toggleBlocked}
              />
            </div>

            {/* Users Section */}
            {activeTab === 'legacy' && <div className="hidden">
              <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-xl font-bold text-ink">User Management</h2>
                <NewBetaAccountForm />
              </div>
              {isLoading ? (
                <p className="text-sm text-ink-muted">Loading…</p>
              ) : isError ? (
                <p className="text-sm text-mark">Could not load users.</p>
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-1.5">
                      {STATUS_FILTERS.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          onClick={() => setStatusFilter(f.key)}
                          aria-pressed={statusFilter === f.key}
                          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                            statusFilter === f.key ? 'bg-paper-sunken text-ink' : 'bg-paper-inset text-ink-muted hover:text-ink'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                    {accounts.length ? (
                      <div className="relative w-full max-w-56">
                        <Search
                          size={14}
                          aria-hidden="true"
                          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
                        />
                        <input
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Find an account…"
                          aria-label="Search accounts by name or email"
                          className="w-full rounded-lg border border-edge bg-paper py-1.5 pl-8 pr-7 text-sm text-ink outline-none focus:border-accent"
                        />
                        {search ? (
                          <button
                            type="button"
                            onClick={() => setSearch('')}
                            aria-label="Clear search"
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink"
                          >
                            <X size={13} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {selected.size > 0 ? (
                    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent-tint px-3 py-2">
                      <span className="text-xs font-medium text-accent-text">
                        {selected.size} selected
                      </span>
                      <button type="button" className="btn text-xs" disabled={bulkBusy} onClick={() => bulkComp(true)}>
                        Grant unlimited
                      </button>
                      <button type="button" className="btn text-xs" disabled={bulkBusy} onClick={() => bulkComp(false)}>
                        Revoke unlimited
                      </button>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          step={1000}
                          value={bulkCap}
                          onChange={(e) => setBulkCap(e.target.value)}
                          placeholder="tier default"
                          aria-label="Custom weekly token cap for selected accounts"
                          className="w-28 rounded-md border border-edge bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-accent"
                        />
                        <button type="button" className="btn text-xs" disabled={bulkBusy} onClick={bulkSetCap}>
                          Set cap
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="ml-auto text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                  ) : null}

                  {sorted.length === 0 && (search || statusFilter !== 'all') ? (
                    <p className="text-sm text-ink-muted">No account matches.</p>
                  ) : (
                    <>
                      <div className="hidden lg:block">
                        <div className="neo-world neo-panel overflow-x-auto rounded-xl">
                          <table className="w-full text-sm whitespace-nowrap">
                            <thead>
                              <tr className="border-b border-edge bg-paper-sunken text-left text-2xs uppercase tracking-wide text-ink-muted">
                                <th className="w-8 px-3 py-2">
                                  <input
                                    type="checkbox"
                                    checked={allVisibleSelected}
                                    onChange={toggleSelectAllVisible}
                                    aria-label="Select every visible account"
                                  />
                                </th>
                                <SortHeader label="Account" sortKey="name" sort={sort} onSort={onSort} />
                                <SortHeader label="Status" sortKey="status" sort={sort} onSort={onSort} />
                                <th className="px-3 py-2 font-medium">Cap status</th>
                                <SortHeader label="Plans built" sortKey="plans_built" sort={sort} onSort={onSort} />
                                <SortHeader label="Tokens 7d" sortKey="tokens_7d" sort={sort} onSort={onSort} />
                                <th className="px-3 py-2 font-medium">Est. cost 7d</th>
                                <SortHeader label="Avg/day (30d)" sortKey="avg_day" sort={sort} onSort={onSort} />
                                <SortHeader label="Last active" sortKey="last_active" sort={sort} onSort={onSort} />
                                <SortHeader label="Joined" sortKey="joined" sort={sort} onSort={onSort} />
                                <th className="px-3 py-2 font-medium">Planning context</th>
                                <th className="px-3 py-2 font-medium">Custom cap</th>
                                <th className="px-3 py-2 font-medium" />
                              </tr>
                            </thead>
                            <tbody>
                              {sorted.map((a) => (
                                <tr key={a.id} className="border-b border-edge last:border-0">
                                  <td className="px-3 py-2">
                                    <input
                                      type="checkbox"
                                      checked={selected.has(a.id)}
                                      onChange={() => toggleSelect(a.id)}
                                      aria-label={`Select ${a.email}`}
                                    />
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="font-medium text-ink">{a.name}</div>
                                    <div className="text-2xs text-ink-muted">
                                      {a.email}
                                      {a.is_admin ? ' · admin' : ''}
                                    </div>
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="flex flex-col items-start gap-1">
                                      <StatusPill status={a.subscription_status} />
                                      <TrialBadge account={a} />
                                    </div>
                                  </td>
                                  <td className="px-3 py-2">
                                    <CapStatusBadge account={a} />
                                  </td>
                                  <td className="px-3 py-2 font-mono text-ink-soft">{a.plans_built}</td>
                                  <td className="px-3 py-2 font-mono text-ink-soft">{(a.tokens_7d || 0).toLocaleString()}</td>
                                  <td className="px-3 py-2 font-mono text-ink-soft">{estCost(a.tokens_7d || 0)}</td>
                                  <td className="px-3 py-2 font-mono text-ink-soft">{(a.tokens_avg_day_30d || 0).toLocaleString()}</td>
                                  <td className="px-3 py-2 text-ink-soft">{relative(a.last_plan_at)}</td>
                                  <td className="px-3 py-2 text-ink-soft">{relative(a.created_at)}</td>
                                  <td className="px-3 py-2">
                                    <PlanningContext account={a} />
                                  </td>
                                  <td className="px-3 py-2">
                                    <CustomCapEditor account={a} />
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                                      <BetaAccountActions account={a} pending={pending} setPending={setPending} />
                                      <button
                                        type="button"
                                        className="btn text-xs"
                                        disabled={pending === a.id}
                                        onClick={() => toggleComp(a)}
                                      >
                                        {a.subscription_status === 'comped' ? 'Revoke unlimited' : 'Grant unlimited'}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <ul className="flex flex-col gap-3 lg:hidden">
                        {sorted.map((a) => (
                          <li key={a.id} className="neo-world neo-panel rounded-xl p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex min-w-0 items-start gap-2">
                                <input
                                  type="checkbox"
                                  checked={selected.has(a.id)}
                                  onChange={() => toggleSelect(a.id)}
                                  aria-label={`Select ${a.email}`}
                                  className="mt-1 shrink-0"
                                />
                                <div className="min-w-0">
                                  <div className="truncate font-medium text-ink">{a.name}</div>
                                  <div className="truncate text-2xs text-ink-muted">
                                    {a.email}
                                    {a.is_admin ? ' · admin' : ''}
                                  </div>
                                </div>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1">
                                <StatusPill status={a.subscription_status} />
                                <CapStatusBadge account={a} />
                                <TrialBadge account={a} />
                              </div>
                            </div>
                            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                              <dt className="text-ink-muted">Plans built</dt>
                              <dd className="text-right font-mono text-ink-soft">{a.plans_built}</dd>
                              <dt className="text-ink-muted">Tokens 7d</dt>
                              <dd className="text-right font-mono text-ink-soft">{(a.tokens_7d || 0).toLocaleString()}</dd>
                              <dt className="text-ink-muted">Est. cost 7d</dt>
                              <dd className="text-right font-mono text-ink-soft">{estCost(a.tokens_7d || 0)}</dd>
                              <dt className="text-ink-muted">Avg/day (30d)</dt>
                              <dd className="text-right font-mono text-ink-soft">{(a.tokens_avg_day_30d || 0).toLocaleString()}</dd>
                              <dt className="text-ink-muted">Last active</dt>
                              <dd className="text-right text-ink-soft">{relative(a.last_plan_at)}</dd>
                              <dt className="text-ink-muted">Joined</dt>
                              <dd className="text-right text-ink-soft">{relative(a.created_at)}</dd>
                            </dl>
                            <div className="mt-3 border-t border-edge pt-3">
                              <div className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-ink-muted">
                                Planning context
                              </div>
                              <PlanningContext account={a} />
                            </div>
                            <div className="mt-3 flex flex-col gap-2 border-t border-edge pt-3">
                              <label className="text-2xs font-medium uppercase tracking-wider text-ink-muted">
                                Custom weekly cap
                              </label>
                              <CustomCapEditor account={a} />
                              <BetaAccountActions account={a} pending={pending} setPending={setPending} />
                              <button
                                type="button"
                                className="btn w-full text-xs"
                                disabled={pending === a.id}
                                onClick={() => toggleComp(a)}
                              >
                                {a.subscription_status === 'comped' ? 'Revoke unlimited' : 'Grant unlimited'}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  <p className="mt-4 text-2xs text-ink-muted">
                    "Grant unlimited" sets the account to comped — the same status your own account has. It bypasses
                    the free-week limit entirely and never expires on its own; use "Revoke unlimited" to put an
                    account back on the ordinary free week. A custom cap is a middle ground — it overrides the tier
                    default for that one account only, in either direction, until cleared.
                  </p>
                </>
              )}
            </div>}

            {/* Lesson Plans Section */}
            <div id="section-plans" className={activeTab === 'plans' ? '' : 'hidden'}>
              <div className="mb-6"><p className="text-2xs font-semibold uppercase tracking-[0.16em] text-accent-text">Operations</p><h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">Lesson plans</h2><p className="mt-1 text-sm text-ink-muted">Review, search, and download the plans your customers have produced.</p></div>
              <AdminLessonPlans accounts={accounts} />
            </div>

            {/* Standards Section */}
            <div id="section-standards" className={activeTab === 'standards' ? '' : 'hidden'}>
              <div className="mb-6"><p className="text-2xs font-semibold uppercase tracking-[0.16em] text-accent-text">Quality control</p><h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">Standards check</h2><p className="mt-1 text-sm text-ink-muted">Catch standards that do not match the plan’s course or grade before they become support issues.</p></div>
              <StandardsCheckSection />
            </div>

            {/* Schools Section */}
            <div id="section-schools" className={activeTab === 'schools' ? '' : 'hidden'}>
              <div className="mb-6"><p className="text-2xs font-semibold uppercase tracking-[0.16em] text-accent-text">Workspace context</p><h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">Schools & calendars</h2><p className="mt-1 text-sm text-ink-muted">Manage school records, calendar submissions, and template processing queues.</p></div>
              <SchoolsAdmin />
            </div>

            {/* Billing Section */}
            <div id="section-billing" className={activeTab === 'billing' ? '' : 'hidden'}>
              <div className="mb-6"><p className="text-2xs font-semibold uppercase tracking-[0.16em] text-accent-text">Revenue operations</p><h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">Billing</h2><p className="mt-1 text-sm text-ink-muted">See revenue, subscription health, and payment risk in one place.</p></div>
              <BillingAdmin />
            </div>

            {/* Settings Section */}
            <div id="section-settings" className={activeTab === 'settings' ? '' : 'hidden'}>
              <div className="mb-6"><p className="text-2xs font-semibold uppercase tracking-[0.16em] text-accent-text">System controls</p><h2 className="mt-1 text-2xl font-bold tracking-tight text-ink">Settings</h2><p className="mt-1 text-sm text-ink-muted">Tune usage controls and review the admin audit trail.</p></div>
              <SettingsAdmin />
            </div>

          </div>
    </SplitLayout>
  )
}
