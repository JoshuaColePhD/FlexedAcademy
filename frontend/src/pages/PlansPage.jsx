import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Download, FileText, Search, Trash2, CheckSquare, Square } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useActiveClass, usePlans, useDeletePlan } from '../hooks/useAppData'
import { errorParts } from '../lib/apiError'
import { SkeletonText } from '../components/Skeleton'
import { unitSuffix } from '../lib/planShape'

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

function PlanRow({ plan, classId, onDelete, deleting, closing, selectionMode, selected, onToggleSelect }) {
  // Plans built before chat_id was tracked (or ever) have nowhere for a
  // click to go — same fallback ClassWeeks uses for an orphaned week.
  const openable = Boolean(plan.chat_id)
  const label = plan.week_label || 'Untitled week'

  const content = (
    <>
      {selectionMode ? (
        selected ? (
          <CheckSquare size={15} aria-hidden="true" className="shrink-0 text-accent" />
        ) : (
          <Square size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
        )
      ) : (
        <FileText size={15} aria-hidden="true" className="shrink-0 text-ink-muted" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">
          {label}
          {unitSuffix(plan.unit)}
        </span>
        <span className="block truncate text-xs text-ink-muted">
          {plan.course ? `${plan.course} · ` : ''}
          {formatDate(plan.created_at)}
        </span>
      </span>
    </>
  )

  if (selectionMode) {
    return (
      <li className={`group flex items-center gap-1 px-2 py-1${closing ? ' fa-row-exit' : ''}`}>
        {/* pressed-in, not a background tint — "selected" already reads as
            neo-inset everywhere else in this world (the sidebar's active chat,
            LessonQuestions' picked answer). */}
        <button
          type="button"
          onClick={() => onToggleSelect(plan.id)}
          className={`flex min-h-touch min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left transition-shadow ${
            selected ? 'neo-inset' : 'hover:bg-paper-sunken'
          }`}
        >
          {content}
        </button>
      </li>
    )
  }

  return (
    <li className={`group flex items-center gap-1 px-2 py-1${closing ? ' fa-row-exit' : ''}`}>
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
  /* Deletion goes through react-query invalidation, not a local splice —
     the row actually disappears from `plans` whenever the refetch lands,
     on its own schedule. Rather than choreograph an exit animation against
     that, just flag the row as closing (fa-row-exit, animation-fill-mode:
     both) the moment deletion is confirmed; it's already collapsed and
     invisible by the time the real removal happens, so there's nothing to
     desync. Only ever cleared on failure — a successful id just stays
     here harmlessly once its row is gone. */
  const [deletingIds, setDeletingIds] = useState(new Set())

  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [isDeletingBulk, setIsDeletingBulk] = useState(false)

  const plans = data?.items || []
  const filtered = search.trim() ? plans.filter((p) => matchesSearch(p, search)) : plans

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filtered.map(p => p.id)))
    }
  }

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return
    const ok = await confirm({
      title: `Delete ${selectedIds.size} plan${selectedIds.size === 1 ? '' : 's'}?`,
      body: 'This removes the plans and their documents. The chats that built them are kept.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setDeletingIds((prev) => new Set([...prev, ...selectedIds]))
    setIsDeletingBulk(true)
    try {
      for (const id of selectedIds) {
        await deletePlan.mutateAsync(id)
      }
      setSelectedIds(new Set())
      setSelectionMode(false)
    } catch (err) {
      // Partial failure, and no per-id success tracking here: any that DID
      // succeed are already gone from `plans`, so un-flagging them is a
      // no-op; any that failed correctly revert to visible.
      setDeletingIds((prev) => {
        const next = new Set(prev)
        selectedIds.forEach((id) => next.delete(id))
        return next
      })
      toast.apiError('Could not delete all plans', err)
    } finally {
      setIsDeletingBulk(false)
    }
  }

  const handleDelete = async (plan) => {
    const ok = await confirm({
      title: `Delete “${plan.week_label || 'this plan'}”?`,
      body: 'This removes the plan and its document. The chat that built it is kept.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setDeletingIds((prev) => new Set(prev).add(plan.id))
    setDeletingId(plan.id)
    try {
      await deletePlan.mutateAsync(plan.id)
    } catch (err) {
      setDeletingIds((prev) => {
        const next = new Set(prev)
        next.delete(plan.id)
        return next
      })
      toast.apiError('Could not delete that plan', err)
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="column bg-paper/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5">
      <header className="flex h-14 shrink-0 items-center justify-between px-gutter">
        <h1 className="text-sm font-semibold text-ink">
          Library{activeClass?.name ? ` — ${activeClass.name}` : ''}
        </h1>
        <div className="flex items-center gap-3">
        </div>
      </header>

      <div className="page scroll-y">
        <div className="mx-auto w-full max-w-measure-form">
          {plans.length > 0 && (
            <div className="mb-2 flex items-center justify-end gap-3">
              {selectionMode ? (
                <>
                  <button
                    type="button"
                    disabled={isDeletingBulk}
                    onClick={toggleSelectAll}
                    className="neo-raised rounded-md bg-paper-raised px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper-sunken disabled:opacity-50"
                  >
                    {selectedIds.size === filtered.length && filtered.length > 0 ? 'Deselect all' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    disabled={selectedIds.size === 0 || isDeletingBulk}
                    onClick={handleBulkDelete}
                    className="neo-raised rounded-md bg-paper-raised px-2.5 py-1 text-xs font-medium text-mark hover:bg-paper-sunken disabled:opacity-50"
                  >
                    Delete ({selectedIds.size})
                  </button>
                  <button
                    type="button"
                    disabled={isDeletingBulk}
                    onClick={() => {
                      setSelectionMode(false)
                      setSelectedIds(new Set())
                    }}
                    className="neo-raised rounded-md px-2.5 py-1 text-xs font-medium text-ink-muted hover:text-ink disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setSelectionMode(true)}
                  className="neo-raised rounded-md bg-paper-raised px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper-sunken"
                >
                  Select multiple
                </button>
              )}
            </div>
          )}

          {plans.length > SEARCH_THRESHOLD ? (
            <div className="neo-inset mb-3 flex items-center gap-2 rounded-lg bg-paper-sunken px-2.5 py-1.5">
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
            <div className="neo-panel rounded-xl bg-paper-raised/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5 px-3 py-4">
              <SkeletonText lines={4} />
            </div>
          ) : isError ? (
            <p className="rounded-lg bg-mark-tint px-3 py-2.5 text-sm text-mark">
              Couldn’t load your plans. {errorParts(error).message}
            </p>
          ) : filtered.length ? (
            <ul className="neo-panel divide-y divide-edge overflow-hidden rounded-xl bg-paper-raised/30 backdrop-blur-3xl saturate-[1.2] border border-white/5 shadow-inner shadow-white/5">
              {filtered.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  classId={classId}
                  onDelete={handleDelete}
                  deleting={deletingId === plan.id}
                  closing={deletingIds.has(plan.id)}
                  selectionMode={selectionMode}
                  selected={selectedIds.has(plan.id)}
                  onToggleSelect={toggleSelect}
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
