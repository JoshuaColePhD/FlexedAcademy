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

/* A read-only trail of sensitive actions — comping an account, registering
   or removing a school, a teacher exporting or deleting their own data —
   backed by backend/db.py's audit_log table. Nothing here is editable; it
   exists so "who changed this account, and when" has an answer that isn't
   grepping server logs. */
function AuditLogPanel() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'audit-log'],
    queryFn: () => api.adminAuditLog(),
  })
  const entries = data?.entries ?? []

  return (
    <div className="neo-world neo-panel mt-8 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-ink">Audit log</h2>
      <p className="mt-1 text-2xs text-ink-muted">
        The most recent 200 sensitive actions — admin account changes, and teachers exporting or
        deleting their own data.
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-ink-muted">Loading…</p>
      ) : isError ? (
        <p className="mt-3 text-sm text-mark">Could not load the audit log.</p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">No actions recorded yet.</p>
      ) : (
        <ul className="mt-3 max-h-80 divide-y divide-edge overflow-y-auto">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="text-ink">{e.action}</span>
              <span className="truncate text-2xs text-ink-muted">
                {e.target_user_id ? `target: ${e.target_user_id}` : ''}
              </span>
              <span className="whitespace-nowrap text-2xs text-ink-faint">{relative(e.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function AdminPage() {
  useDocumentTitle('Accounts')
  const toast = useToast()
  const confirm = useConfirm()
  const qc = useQueryClient()
  const [pending, setPending] = useState(null)

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
        <h1 className="text-lg font-semibold text-ink">Accounts</h1>
      </div>

      {isLoading ? (
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
      <p className="mt-4 text-2xs text-ink-muted">
        "Grant unlimited" sets the account to comped — the same status your own account has. It bypasses
        the free-week limit entirely and never expires on its own; use "Revoke unlimited" to put an
        account back on the ordinary free week.
      </p>

      <SchoolsAdmin />
      <AuditLogPanel />
    </div>
  )
}
