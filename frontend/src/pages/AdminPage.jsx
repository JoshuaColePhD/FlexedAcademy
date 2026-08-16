import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useDocumentTitle } from '../hooks/useDocumentTitle'

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
 * Widened on Josh's own ask ("needs to give me a lot more control"): the old
 * page could only tell an account "the ordinary tier cap" or "unlimited" —
 * nothing in between, and nothing said which accounts were actually close to
 * their cap RIGHT NOW versus just building steadily. Three additions, all
 * read-or-act on data the backend already had (list_accounts_with_stats
 * already computed tokens_7d/30d; this just adds the burst window and a
 * per-account override on top):
 *   - An estimated $ cost per account, not just a raw token count — the
 *     actual question a cap exists to answer.
 *   - An at-a-glance status (fine / near cap / capped right now), reading
 *     the same weekly+burst thresholds entitlement.py itself gates on.
 *   - A per-account cap override — the missing middle ground between the
 *     free tier and comped (unlimited).
 * Plus a search box (the table has no other way to find one account once
 * there are more than a screenful) and a card layout below `lg`, where a
 * 9-column table stops being something a phone or a tablet in portrait can
 * show without horizontal scrolling.
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

/* The cap actually in effect for one account, and how close it's running to
   it — same precedence entitlement.py itself uses (custom override, then
   tier default), and the same weekly+burst thresholds it gates generation
   on, just read here for DISPLAY rather than enforcement. */
function capStatusFor(account) {
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
    </div>
  )
}

export function AdminPage() {
  useDocumentTitle('Accounts')
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [pending, setPending] = useState(null)
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'accounts'],
    queryFn: () => api.adminListAccounts(),
  })

  const accounts = data?.accounts ?? []

  // Substring match on name/email — the table had no other way to find one
  // account among many besides scrolling and reading. No useMemo: `accounts`
  // is a fresh array every render already (data?.accounts ?? []), so memoizing
  // against it would never actually skip work — and an admin's account list
  // is small enough that filtering on every render costs nothing real.
  const q = search.trim().toLowerCase()
  const filtered = q
    ? accounts.filter((a) => a.name?.toLowerCase().includes(q) || a.email?.toLowerCase().includes(q))
    : accounts

  const toggleComp = async (account) => {
    const nextComped = account.subscription_status !== 'comped'
    // This fired on click with no confirmation at all — a misclick on the
    // wrong row changed someone else's billing status instantly, with no
    // undo but the same button in reverse. The rest of the app already has a
    // confirm dialog for exactly this weight of action (deleting a chat).
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

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link to="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
        <ArrowLeft size={15} aria-hidden="true" /> Back to the app
      </Link>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} aria-hidden="true" className="text-ink-muted" />
          <h1 className="text-lg font-semibold text-ink">Accounts</h1>
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

      {isLoading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-mark">{error?.message || 'Could not load accounts.'}</p>
      ) : filtered.length === 0 && search ? (
        <p className="text-sm text-ink-muted">No account matches “{search}.”</p>
      ) : (
        <>
          {/* Desktop: the full table, every column at once. Below `lg` a
              9-column table stops fitting without horizontal scroll, which
              is worse on a phone (or a tablet in portrait) than a second
              layout — see PlanDayCards/PlanTable's own two-views-by-width
              precedent (LessonPlanTable.jsx). */}
          <div className="hidden lg:block">
            {/* neo-world on the wrapper too, not just neo-panel: /admin is routed
                OUTSIDE AppShell (App.jsx), so --neo-dark/--neo-light are otherwise
                undeclared here and the emboss — the table's and every .btn inside
                it — silently computes to nothing. Same one-element pattern
                LessonQuestions and WeekStrip already use. */}
            <div className="neo-world neo-panel overflow-x-auto rounded-xl">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr className="border-b border-edge bg-paper-sunken text-left text-2xs uppercase tracking-wide text-ink-muted">
                    <th className="px-3 py-2 font-medium">Account</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Cap status</th>
                    <th className="px-3 py-2 font-medium">Plans built</th>
                    <th className="px-3 py-2 font-medium">Tokens 7d</th>
                    <th className="px-3 py-2 font-medium">Est. cost 7d</th>
                    <th className="px-3 py-2 font-medium">Avg/day (30d)</th>
                    <th className="px-3 py-2 font-medium">Last active</th>
                    <th className="px-3 py-2 font-medium">Joined</th>
                    <th className="px-3 py-2 font-medium">Custom cap</th>
                    <th className="px-3 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.id} className="border-b border-edge last:border-0">
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

          {/* Phone / tablet-portrait: one card per account, the same fields
              stacked instead of squeezed into columns nothing that width can
              show. */}
          <ul className="flex flex-col gap-3 lg:hidden">
            {filtered.map((a) => (
              <li key={a.id} className="neo-world neo-panel rounded-xl p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-ink">{a.name}</div>
                    <div className="truncate text-2xs text-ink-muted">
                      {a.email}
                      {a.is_admin ? ' · admin' : ''}
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

      {/* --ink-muted, not --ink-faint: this explains real behavior (what
          the buttons above actually do), not a decorative caption —
          --ink-faint reads under 3:1 against --paper in light mode. */}
      <p className="mt-4 text-2xs text-ink-muted">
        "Grant unlimited" sets the account to comped — the same status your own account has. It bypasses
        the free-week limit entirely and never expires on its own; use "Revoke unlimited" to put an
        account back on the ordinary free week. A custom cap is a middle ground — it overrides the tier
        default for that one account only, in either direction, until cleared.
      </p>

      <SchoolsAdmin />
    </div>
  )
}
