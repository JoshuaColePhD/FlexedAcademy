import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, ShieldCheck, Trash2 } from 'lucide-react'
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
 */

const TABS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'schools', label: 'Schools' },
  { id: 'settings', label: 'Settings' },
]

/* One human-readable line per admin_audit_log row (backend/db.py migration
   27). Kept next to the log fetch rather than in a shared util — nothing
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

function relative(iso) {
  if (!iso) return 'never'
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
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

        {isLoading ? (
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

export function AdminPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [pending, setPending] = useState(null)
  const [tab, setTab] = useState('accounts')
  useDocumentTitle(TABS.find((t) => t.id === tab)?.label || 'Admin')

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin', 'accounts'],
    queryFn: () => api.adminListAccounts(),
  })

  const accounts = data?.accounts ?? []

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

      <div className="mb-6 flex items-center gap-2">
        <ShieldCheck size={18} aria-hidden="true" className="text-ink-muted" />
        <h1 className="text-lg font-semibold text-ink">Admin</h1>
      </div>

      <div className="mb-6 flex gap-1 border-b border-edge">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'border-b-2 border-accent text-ink'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== 'accounts' ? null : isLoading ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-mark">{error?.message || 'Could not load accounts.'}</p>
      ) : (
        // neo-world on the wrapper too, not just neo-panel: /admin is routed
        // OUTSIDE AppShell (App.jsx), so --neo-dark/--neo-light are otherwise
        // undeclared here and the emboss — the table's and every .btn inside
        // it — silently computes to nothing. Same one-element pattern
        // LessonQuestions and WeekStrip already use.
        <div className="neo-world neo-panel overflow-x-auto rounded-xl">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-edge bg-paper-sunken text-left text-2xs uppercase tracking-wide text-ink-muted">
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Plans built</th>
                <th className="px-3 py-2 font-medium">Tokens 7d</th>
                <th className="px-3 py-2 font-medium">Tokens 30d</th>
                <th className="px-3 py-2 font-medium">Avg/day</th>
                <th className="px-3 py-2 font-medium">Last active</th>
                <th className="px-3 py-2 font-medium">Joined</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
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
                  <td className="px-3 py-2 font-mono text-ink-soft">{a.plans_built}</td>
                  <td className="px-3 py-2 font-mono text-ink-soft">{(a.tokens_7d || 0).toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono text-ink-soft">{(a.tokens_30d || 0).toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono text-ink-soft">{(a.tokens_avg_day_30d || 0).toLocaleString()}</td>
                  <td className="px-3 py-2 text-ink-soft">{relative(a.last_plan_at)}</td>
                  <td className="px-3 py-2 text-ink-soft">{relative(a.created_at)}</td>
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
      )}

      {/* --ink-muted, not --ink-faint: this explains real behavior (what
          the buttons above actually do), not a decorative caption —
          --ink-faint reads under 3:1 against --paper in light mode. */}
      {tab === 'accounts' && (
        <p className="mt-4 text-2xs text-ink-muted">
          "Grant unlimited" sets the account to comped — the same status your own account has. It bypasses
          the free-week limit entirely and never expires on its own; use "Revoke unlimited" to put an
          account back on the ordinary free week.
        </p>
      )}

      {tab === 'schools' && <SchoolsAdmin />}
      {tab === 'settings' && <SettingsAdmin />}
    </div>
  )
}
