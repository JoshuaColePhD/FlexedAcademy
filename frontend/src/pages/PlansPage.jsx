import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, FileText, Search, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useActiveClass, usePlans, useDeletePlan } from '../hooks/useAppData'
import { errorParts } from '../lib/apiError'
import { SkeletonText } from '../components/Skeleton'

/* Every plan this class has ever produced, in one place.
 *
 * The sidebar's "Recent" list is chats, not plans — a conversation that
 * revised a week three times is one row there, and a plan built without ever
 * being revisited is easy to lose track of once it scrolls out of "Recent".
 * This reads straight from the same durable record the calendar and the
 * paywall's free-week counter already trust (backend/db.py's `plans` table),
 * so it is never out of sync with what actually got built.
 */

const SEARCH_THRESHOLD = 8

function matchesSearch(plan, query) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [plan.week_label, plan.unit, plan.course]
    .filter(Boolean)
    .some((s) => s.toLowerCase().includes(q))
}

function formatDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function PlanRow({ plan, classId, onDelete, deleting }) {
  // Plans built before chat_id was tracked (or ever) have nowhere for a
  // click to go — same fallback ClassWeeks uses for an orphaned week.
  const openable = Boolean(plan.chat_id)
  const label = plan.week_label || 'Untitled week'

  const content = (
    <>
      <FileText size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">
          {label}
          {plan.unit ? ` — ${plan.unit}` : ''}
        </span>
        <span className="block truncate text-xs text-ink-muted">
          {plan.course ? `${plan.course} · ` : ''}
          {formatDate(plan.created_at)}
        </span>
      </span>
    </>
  )

  return (
    <li className="group flex items-center gap-1 px-2 py-1">
      {openable ? (
        <Link
          to={`/c/${classId}/chat/${plan.chat_id}`}
          className="flex min-h-touch min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 transition-colors hover:bg-paper-sunken"
        >
          {content}
        </Link>
      ) : (
        <span className="flex min-h-touch min-w-0 flex-1 items-center gap-2.5 px-2 opacity-60">{content}</span>
      )}
      <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <a
          className="btn-icon"
          href={api.planDownloadUrl(plan.id)}
          download
          aria-label={`Download ${label}`}
          title="Download"
        >
          <Download size={13} aria-hidden="true" />
        </a>
        <button
          type="button"
          className="btn-icon"
          onClick={() => onDelete(plan)}
          disabled={deleting}
          aria-label={`Delete ${label}`}
          title="Delete"
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </span>
    </li>
  )
}

export function PlansPage() {
  const { classId, activeClass } = useActiveClass()
  const { data, isLoading, isError, error } = usePlans()
  const deletePlan = useDeletePlan()
  const confirm = useConfirm()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState(null)

  const plans = data?.items || []
  const filtered = search.trim() ? plans.filter((p) => matchesSearch(p, search)) : plans

  const handleDelete = async (plan) => {
    const ok = await confirm({
      title: `Delete “${plan.week_label || 'this plan'}”?`,
      body: 'This removes the plan and its document. The chat that built it is kept.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setDeletingId(plan.id)
    try {
      await deletePlan.mutateAsync(plan.id)
    } catch (err) {
      toast.apiError('Could not delete that plan', err)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="column">
      <header className="flex h-14 shrink-0 items-center px-gutter">
        <h1 className="text-sm font-semibold text-ink">
          My plans{activeClass?.name ? ` — ${activeClass.name}` : ''}
        </h1>
      </header>

      <div className="page scroll-y">
        <div className="mx-auto w-full max-w-measure-form">
          {plans.length > SEARCH_THRESHOLD ? (
            <div className="mb-3 flex items-center gap-2 rounded-lg bg-paper-sunken px-2.5 py-1.5">
              <Search size={13} aria-hidden="true" className="shrink-0 text-ink-muted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search plans"
                aria-label="Search plans"
                className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted"
              />
            </div>
          ) : null}

          {isLoading ? (
            <div className="rounded-xl border border-edge bg-paper-raised px-3 py-4">
              <SkeletonText lines={4} />
            </div>
          ) : isError ? (
            <p className="text-sm text-mark">Couldn’t load your plans. {errorParts(error).message}</p>
          ) : filtered.length ? (
            <ul className="divide-y divide-edge overflow-hidden rounded-xl border border-edge bg-paper-raised">
              {filtered.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  classId={classId}
                  onDelete={handleDelete}
                  deleting={deletingId === plan.id}
                />
              ))}
            </ul>
          ) : plans.length ? (
            <p className="text-sm text-ink-muted">No plans match “{search}”.</p>
          ) : (
            <p className="text-sm text-ink-muted">
              Nothing yet. Describe a week in a new chat and it will show up here once it's built.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
