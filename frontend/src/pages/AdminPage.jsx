import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { api } from '../lib/api'
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
    <div className="mx-auto max-w-3xl px-4 py-8">
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
        <div className="overflow-hidden rounded-xl border border-edge">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-paper-sunken text-left text-2xs uppercase tracking-wide text-ink-muted">
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Plans built</th>
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
    </div>
  )
}
