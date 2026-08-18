import React, { useEffect, useMemo, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  FileText,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { useActiveClass } from '../hooks/useAppData'
import { AccountMenu } from '../components/AccountMenu'

/* Account management, as a page instead of a Supabase SQL editor tab.
 *
 * This replaces exactly one workflow: "who's signed up, are they paying, and
 * give this one unlimited access" — the three questions that used to mean
 * either running SQL by hand against production or asking someone who could.
 * It is deliberately narrow. It does not manage classes, plans, or content —
 * those already have owners (the teacher who made them).
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

/* Four numbers worth seeing before scrolling into the table at all — how
   many accounts exist, how many of those are real subscribers vs comped vs
   just on the free week, and what the whole roster is costing right now.
   Plain divs, not a chart: this is a glance, not an analysis. */
function StatCard({ label, value }) {
  return (
    <div className="neo-world neo-panel rounded-xl p-3">
      <p className="text-2xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink">{value}</p>
    </div>
  )
}

function StatsCards({ accounts }) {
  const stats = useMemo(() => {
    let subscribed = 0
    let comped = 0
    let cost7d = 0
    for (const a of accounts) {
      const t = tier(a)
      if (t === 'subscribed') subscribed += 1
      else if (t === 'comped') comped += 1
      cost7d += a.tokens_7d || 0
    }
    return { subscribed, comped, cost7d }
  }, [accounts])

  return (
    <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Accounts" value={accounts.length} />
      <StatCard label="Subscribed" value={stats.subscribed} />
      <StatCard label="Comped" value={stats.comped} />
      <StatCard label="Est. cost, 7d" value={estCost(stats.cost7d)} />
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
      await api.adminActivateTemplate(template.school_id)
      toast.success(`${template.school_name} marked as active`)
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
                    uploaded by {t.uploader_name || t.uploader_email || t.uploaded_by} on{' '}
                    {new Date(t.created_at).toLocaleDateString()}
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
                    Mark Active
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
                uploaded by {t.uploader_name || t.uploader_email || t.uploaded_by} · activated{' '}
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

export function AdminPage() {
  useDocumentTitle('Accounts')
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const { activeClass } = useActiveClass()

  const [activeTab, setActiveTab] = useState('overview')
  const scrollContainerRef = React.useRef(null)

  // -- Data fetching for Accounts --
  const [pending, setPending] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
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
    .filter((a) => (q ? a.name?.toLowerCase().includes(q) || a.email?.toLowerCase().includes(q) : true))
    .filter((a) => (statusFilter === 'all' ? true : tier(a) === statusFilter))
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

  // -- Scroll Spy Logic --
  const tabs = React.useMemo(() => [
    { id: 'overview', label: 'Overview' },
    { id: 'users', label: 'User Management' },
    { id: 'standards', label: 'Standards Check' },
    { id: 'schools', label: 'Schools' },
  ], [])

  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        let maxRatio = 0
        let visibleId = null
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > maxRatio) {
            maxRatio = entry.intersectionRatio
            visibleId = entry.target.id
          }
        })
        if (visibleId) {
          setActiveTab(visibleId.replace('section-', ''))
        }
      },
      {
        root: scrollContainerRef.current,
        threshold: [0.1, 0.5, 0.9],
        rootMargin: '-10% 0px -40% 0px',
      }
    )

    tabs.forEach((tab) => {
      const el = document.getElementById(`section-${tab.id}`)
      if (el) observer.observe(el)
    })

    return () => observer.disconnect()
  }, [tabs])

  const scrollToSection = (id) => {
    setActiveTab(id)
    const el = document.getElementById(`section-${id}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5">
      
      {/* Left Sidebar */}
      <div className="hidden md:flex w-64 shrink-0 flex-col border-r border-edge bg-paper-sunken">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <Link
            to="/"
            aria-label="Back"
            className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </Link>
          <div className="flex items-center gap-1.5">
            <ShieldCheck size={16} aria-hidden="true" className="text-ink-muted" />
            <h1 className="text-sm font-semibold text-ink">Admin</h1>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto py-2">
          <nav className="flex flex-col px-2 gap-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => scrollToSection(tab.id)}
                className={`flex items-center justify-between min-h-touch rounded-lg px-2 text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'bg-paper-inset font-medium text-ink'
                    : 'text-ink-soft hover:bg-paper-inset hover:text-ink'
                }`}
              >
                <span className="truncate">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>

        <div className="shrink-0 border-t border-edge">
          {/* Every plan this class has ever built, placed at the bottom near account settings. */}
          <NavLink
            to={activeClass ? `/c/${activeClass.id}/plans` : '/c/default/plans'}
            className={({ isActive }) =>
              `flex min-h-touch items-center gap-2.5 px-4 text-sm transition-colors ${
                isActive ? 'text-ink' : 'text-ink-soft hover:text-ink'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <FileText
                  size={15}
                  aria-hidden="true"
                  style={isActive ? { color: 'rgb(var(--rail-pop-rgb))' } : undefined}
                />
                Library
              </>
            )}
          </NavLink>
          <AccountMenu classPath={activeClass ? `/c/${activeClass.id}` : '/c/default'} />
        </div>
      </div>

      {/* Right Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="flex md:hidden h-14 shrink-0 items-center border-b border-edge bg-paper px-4 z-10 gap-3">
          <Link to="/" className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-paper-inset hover:text-ink"><ArrowLeft size={16}/></Link>
          <div className="text-sm font-semibold text-ink truncate">{tabs.find(t => t.id === activeTab)?.label}</div>
        </header>
        <header className="hidden md:flex h-14 shrink-0 items-center border-b border-edge bg-paper px-8 z-10">
          <div className="text-sm font-medium text-ink-muted">
            {tabs.find(t => t.id === activeTab)?.label}
          </div>
        </header>

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-8 py-8 scroll-smooth">
          <div className="w-full max-w-6xl flex flex-col gap-16 pb-32">
            
            {/* Overview Section */}
            <div id="section-overview" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Overview</h2>
              {isLoading ? (
                <p className="text-sm text-ink-muted">Loading…</p>
              ) : isError ? (
                <p className="text-sm text-mark">{error?.message || 'Could not load accounts.'}</p>
              ) : (
                <>
                  <StatsCards accounts={accounts} />
                  <UsageTrendChart />
                </>
              )}
            </div>

            {/* Users Section */}
            <div id="section-users" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">User Management</h2>
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
                                    <StatusPill status={a.subscription_status} />
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
                                    <CustomCapEditor account={a} />
                                  </td>
                                  <td className="px-3 py-2 text-right">
                                    <button
                                      type="button"
                                      className="btn text-xs"
                                      disabled={pending === a.id}
                                      onClick={() => toggleComp(a)}
                                    >
                                      {a.subscription_status === 'comped' ? 'Revoke unlimited' : 'Grant unlimited'}
                                    </button>
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
                            <div className="mt-3 flex flex-col gap-2 border-t border-edge pt-3">
                              <label className="text-2xs font-medium uppercase tracking-wider text-ink-muted">
                                Custom weekly cap
                              </label>
                              <CustomCapEditor account={a} />
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
            </div>

            {/* Standards Section */}
            <div id="section-standards" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Standards Check</h2>
              <StandardsCheckSection />
            </div>

            {/* Schools Section */}
            <div id="section-schools" className="scroll-mt-8">
              <h2 className="text-xl font-bold text-ink mb-6">Schools & Calendars</h2>
              <SchoolsAdmin />
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}
