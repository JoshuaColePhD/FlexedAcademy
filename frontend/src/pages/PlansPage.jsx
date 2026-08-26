import { SplitLayout } from "../components/SplitLayout"
import { Fragment, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Download, FileText, Search, Trash2, CheckSquare, Square, LayoutGrid, List as ListIcon } from 'lucide-react'
import { api } from '../lib/api'
import { copyPlanShareLink } from '../lib/shareLink'
import { useToast } from '../lib/toastContext'
import { useConfirm } from '../lib/confirmContext'
import { useActiveClass, useCalendar, usePlanWeeks, useDeletePlan } from '../hooks/useAppData'
import { errorParts } from '../lib/apiError'
import { SkeletonText } from '../components/Skeleton'
import { getContextualSuggestions } from '../lib/contextualSuggestions'
import { ContextualSuggestionList } from '../components/ContextualSuggestionList'

/* Every plan this class has ever produced, in one place — one card per
 * calendar week, not one row per raw generation.
 *
 * The sidebar's "Recent" list is chats, not plans — a conversation that
 * revised a week three times is one row there, and a plan built without ever
 * being revisited is easy to lose track of once it scrolls out of "Recent".
 * This reads straight from the same durable record the calendar and the
 * paywall's free-week counter already trust (backend/db.py's `plans` table),
 * so it is never out of sync with what actually got built.
 *
 * Grouped by week (db.list_plan_weeks) rather than the flat, ungrouped
 * history GET /api/plans still serves elsewhere (e.g. ChatPage's own
 * plan-for-this-chat lookup): regenerating a week used to just add another
 * row with the same week_label, so the same week showed up twice, three
 * times, however many times it had been rebuilt — with no way to tell which
 * was current without opening each one.
 */

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
  const toast = useToast()
  // Plans built before chat_id was tracked (or ever) have nowhere for a
  // click to go — same fallback ClassWeeks uses for an orphaned week.
  const openable = Boolean(plan.chat_id)
  const label = plan.week_label || 'Untitled week'

  const content = (
    <>
      {selectionMode ? (
        selected ? (
          <CheckSquare size={16} aria-hidden="true" className="shrink-0 text-accent" />
        ) : (
          <Square size={16} aria-hidden="true" className="shrink-0 text-ink-muted/50" />
        )
      ) : (
        <div className="p-2 bg-paper/50 rounded-md border border-edge/20 shrink-0 group-hover:border-edge/50 transition-colors">
          <FileText size={16} aria-hidden="true" className="text-ink-muted" />
        </div>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink group-hover:text-accent transition-colors">
          {label}
          {plan.unit && <span className="ml-1.5 text-xs font-normal text-ink-muted">Unit {plan.unit}</span>}
        </span>
        <span className="flex items-center gap-2 truncate text-xs text-ink-muted mt-0.5">
          {plan.course && (
             <span className="bg-edge/30 text-ink-soft px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider">{plan.course}</span>
          )}
          {formatDate(plan.created_at)}
        </span>
      </span>
    </>
  )

  if (selectionMode) {
    return (
      <li className={`group flex items-center gap-1 px-3 py-2.5 transition-colors border-b border-edge/10 last:border-0 ${closing ? ' fa-row-exit' : ''}`}>
        <button
          type="button"
          onClick={() => onToggleSelect(plan.id)}
          className={`flex min-h-touch min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-all ${
            selected ? 'bg-accent/10 border-accent/30' : 'hover:bg-paper-sunken'
          }`}
        >
          {content}
        </button>
      </li>
    )
  }

  return (
    <li className={`group flex items-center gap-1 px-3 py-2.5 transition-colors hover:bg-paper/30 border-b border-edge/10 last:border-0 ${closing ? ' fa-row-exit' : ''}`}>
      {openable ? (
        <Link
          to={`/c/${classId}/chat/${plan.chat_id}`}
          className="flex min-h-touch min-w-0 flex-1 items-center gap-3 rounded-lg px-2 transition-colors"
        >
          {content}
        </Link>
      ) : (
        <span className="flex min-h-touch min-w-0 flex-1 items-center gap-3 px-2 opacity-60">{content}</span>
      )}
      <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pr-2">
        <button
          type="button"
          className="p-1.5 text-ink-muted hover:text-ink hover:bg-paper rounded-md transition-colors shadow-sm border border-transparent hover:border-edge/20"
          onClick={() => copyPlanShareLink(plan.id, toast)}
          title="Copy Link"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
        </button>
        <a
          className="p-1.5 text-ink-muted hover:text-ink hover:bg-paper rounded-md transition-colors shadow-sm border border-transparent hover:border-edge/20"
          href={api.planDownloadUrl(plan.id)}
          download
          title="Download"
        >
          <Download size={14} />
        </a>
        <button
          type="button"
          className="p-1.5 text-ink-muted hover:text-mark hover:bg-mark-tint rounded-md transition-colors shadow-sm border border-transparent hover:border-mark/20"
          onClick={() => onDelete(plan)}
          disabled={deleting}
          title="Delete"
        >
          <Trash2 size={14} />
        </button>
      </span>
    </li>
  )
}

function CardContent({ plan, label }) {
  return (
    <>
      <div className="flex items-start gap-3 mb-2">
        <div className="p-2.5 bg-paper rounded-lg border border-edge/20 shadow-sm shrink-0">
          <FileText size={20} className="text-ink-muted" />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <h3 className="text-sm font-bold text-ink truncate group-hover:text-accent transition-colors pr-6">
            {label}
          </h3>
          <p className="text-xs font-medium text-ink-muted truncate mt-0.5">
            {plan.unit ? `Unit ${plan.unit}` : 'No unit'}
          </p>
        </div>
      </div>
      {plan.course && (
        <span className="inline-block mt-1 text-[10px] font-bold uppercase tracking-wider text-ink-soft bg-edge/30 px-2 py-0.5 rounded">
          {plan.course}
        </span>
      )}
    </>
  )
}

function PlanCard({ plan, classId, onDelete, deleting, closing, selectionMode, selected, onToggleSelect }) {
  const toast = useToast()
  const openable = Boolean(plan.chat_id)
  const label = plan.week_label || 'Untitled week'

  return (
    <div className={`group relative flex flex-col rounded-xl border border-edge/30 bg-paper-sunken/40 p-4 transition-all hover:bg-paper-sunken hover:shadow-md hover:border-edge/50 ${closing ? 'fa-row-exit' : ''} ${selected ? 'ring-2 ring-accent border-accent/50 bg-accent/5' : ''}`}>
      {selectionMode && (
        <button
          type="button"
          onClick={() => onToggleSelect(plan.id)}
          className="absolute top-3 right-3 z-10"
        >
          {selected ? (
            <CheckSquare size={18} className="text-accent bg-paper rounded" />
          ) : (
            <Square size={18} className="text-ink-muted bg-paper rounded opacity-50 group-hover:opacity-100 transition-opacity" />
          )}
        </button>
      )}

      {openable ? (
        <Link to={`/c/${classId}/chat/${plan.chat_id}`} className="flex-1 outline-none">
          <CardContent plan={plan} label={label} />
        </Link>
      ) : (
        <div className="flex-1 opacity-60">
          <CardContent plan={plan} label={label} />
        </div>
      )}

      <div className="mt-4 pt-3 flex items-center justify-between border-t border-edge/20">
        <span className="text-[11px] font-medium text-ink-muted bg-paper px-2 py-0.5 rounded-md border border-edge/20">
          {formatDate(plan.created_at)}
        </span>
        <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            className="p-1.5 text-ink-muted hover:text-ink hover:bg-paper rounded transition-colors"
            onClick={() => copyPlanShareLink(plan.id, toast)}
            title="Copy Link"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
          </button>
          <a
            className="p-1.5 text-ink-muted hover:text-ink hover:bg-paper rounded transition-colors"
            href={api.planDownloadUrl(plan.id)}
            download
            title="Download"
          >
            <Download size={14} />
          </a>
          <button
            type="button"
            className="p-1.5 text-ink-muted hover:text-mark hover:bg-mark-tint rounded transition-colors"
            onClick={() => onDelete(plan)}
            disabled={deleting}
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function PlansPage() {
  const { classId, activeClass } = useActiveClass()
  const navigate = useNavigate()
  const { data: calendar } = useCalendar(classId)
  const { data, isLoading, isError, error } = usePlanWeeks()
  const deletePlan = useDeletePlan()
  const confirm = useConfirm()
  const toast = useToast()
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState(null)
  /* Deletion goes through react-query invalidation, not a local splice —
     the row actually disappears from `weeks` whenever the refetch lands,
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

  const [viewMode, setViewMode] = useState('grid')
  const [filterCourse, setFilterCourse] = useState('All')
  const [sortOrder, setSortOrder] = useState('Newest')

  const weeks = data?.weeks || []
  const courses = ['All', ...new Set(weeks.map(w => w.latest.course).filter(Boolean))]

  const currentWeek = calendar?.weeks?.find((week) => week.is_current) || null
  const currentPlan = weeks.find((week) => String(week.week_number) === String(currentWeek?.week))?.latest || null
  const contextualSuggestions = calendar
    ? getContextualSuggestions({
        activeClass,
        calendar,
        conversationWeek: currentWeek?.week,
        effectiveWeek: currentWeek?.week,
        activeChat: currentPlan?.chat_id ? { id: currentPlan.chat_id } : null,
        artifact: currentPlan ? { planId: currentPlan.id } : null,
        surface: 'library',
      })
    : []

  let filtered = search.trim() ? weeks.filter((w) => matchesSearch(w.latest, search)) : [...weeks]
  
  if (filterCourse !== 'All') {
    filtered = filtered.filter(w => w.latest.course === filterCourse)
  }

  filtered.sort((a, b) => {
    const dateA = new Date(a.latest.created_at).getTime()
    const dateB = new Date(b.latest.created_at).getTime()
    return sortOrder === 'Newest' ? dateB - dateA : dateA - dateB
  })

  // Selection/bulk-delete is scoped to the top-level (latest-per-week) rows
  // only — a revision is a single, deliberate delete from inside its own
  // "earlier versions" disclosure, not part of a big multi-select.
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
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
      setSelectedIds(new Set(filtered.map((w) => w.latest.id)))
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
      // succeed are already gone from `weeks`, so un-flagging them is a
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

  const tabs = courses.map(c => ({
    id: c,
    label: c === 'All' ? 'All Courses' : c,
  }))

  return (
    <SplitLayout
      title="Library"
      icon={FileText}
      tabs={tabs}
      activeTab={filterCourse}
      onTabChange={setFilterCourse}
      backPath="/"
    >
      <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2">
          <div>
            <h1 className="text-xl font-bold text-ink flex items-center gap-2">
              Library{activeClass?.name ? <span className="text-ink-muted font-medium">/ {activeClass.name}</span> : ''}
            </h1>
            {weeks.length > 0 && (
              <p className="text-xs text-ink-muted mt-1 font-medium">
                You've built {weeks.length} plan{weeks.length === 1 ? '' : 's'} so far
              </p>
            )}
          </div>
          <Link
            to={`/c/${classId}`}
            className="neo-raised inline-flex items-center gap-1.5 rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-paper transition-all hover:bg-ink/90 shadow-sm shrink-0 w-fit"
          >
            <span className="text-lg leading-none mt-[-2px]">+</span> New Plan
          </Link>
        </header>

        {contextualSuggestions.length > 0 ? (
          <section className="neo-panel rounded-xl bg-paper-raised/30 p-2" aria-label="Suggested actions">
            <ContextualSuggestionList
              suggestions={contextualSuggestions}
              onSelect={(suggestion) => {
                if ((suggestion.action === 'open-chat' || suggestion.action === 'review-plan') && suggestion.chatId) {
                  navigate(`/c/${classId}/chat/${suggestion.chatId}`)
                  return
                }
                navigate(`/c/${classId}${suggestion.weekNumber ? `?week=${suggestion.weekNumber}` : ''}`)
              }}
            />
          </section>
        ) : null}
        
        {weeks.length > 0 && (
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

        {weeks.length > 0 ? (
          <div className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="neo-inset flex flex-1 max-w-sm items-center gap-2 rounded-lg bg-paper-sunken px-3 py-2">
              <Search size={14} aria-hidden="true" className="shrink-0 text-ink-muted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your library..."
                aria-label="Search plans"
                className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted font-medium"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 bg-paper-raised/50 rounded-lg p-1 border border-edge/30">
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  className="bg-transparent text-xs font-semibold text-ink pl-2 pr-6 py-1 outline-none cursor-pointer appearance-none"
                  style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' fill=\'none\' viewBox=\'0 0 24 24\' stroke=\'%23a3a3a3\' stroke-width=\'2\' stroke-linecap=\'round\' stroke-linejoin=\'round\'%3E%3Cpolyline points=\'6 9 12 15 18 9\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.2rem center', backgroundSize: '12px' }}
                >
                  <option value="Newest">Newest First</option>
                  <option value="Oldest">Oldest First</option>
                </select>
              </div>

              <div className="flex items-center rounded-lg bg-paper-raised/80 p-1 border border-edge/30 ml-auto md:ml-2">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-1.5 rounded-md transition-all ${viewMode === 'grid' ? 'bg-paper shadow-sm text-ink' : 'text-ink-muted hover:text-ink'}`}
                  title="Grid View"
                >
                  <LayoutGrid size={14} />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-1.5 rounded-md transition-all ${viewMode === 'list' ? 'bg-paper shadow-sm text-ink' : 'text-ink-muted hover:text-ink'}`}
                  title="List View"
                >
                  <ListIcon size={14} />
                </button>
              </div>
            </div>
          </div>
        ) : null}

          {isLoading ? (
            <div className="neo-panel rounded-xl bg-paper/40 backdrop-blur-md border border-white/5 shadow-sm px-4 py-6">
              <SkeletonText lines={4} />
            </div>
          ) : isError ? (
            <p className="rounded-lg bg-mark-tint px-3 py-2.5 text-sm text-mark">
              Couldn’t load your plans. {errorParts(error).message}
            </p>
          ) : filtered.length ? (
            viewMode === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-8">
                {filtered.map((week) => (
                  <PlanCard
                    key={week.week_number ?? week.latest.id}
                    plan={week.latest}
                    classId={classId}
                    onDelete={handleDelete}
                    deleting={deletingId === week.latest.id}
                    closing={deletingIds.has(week.latest.id)}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(week.latest.id)}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            ) : (
              <ul className="neo-panel divide-y divide-edge/30 overflow-hidden rounded-xl bg-paper/40 backdrop-blur-md border border-white/5 shadow-sm mb-8">
                {filtered.map((week) => (
                  <Fragment key={week.week_number ?? week.latest.id}>
                    <PlanRow
                      plan={week.latest}
                      classId={classId}
                      onDelete={handleDelete}
                      deleting={deletingId === week.latest.id}
                      closing={deletingIds.has(week.latest.id)}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(week.latest.id)}
                      onToggleSelect={toggleSelect}
                    />
                    {week.revisions.length > 0 && (
                      <li className="px-2 pb-1.5 pl-9">
                        <details>
                          <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">
                            {week.revisions.length} earlier version{week.revisions.length === 1 ? '' : 's'}
                          </summary>
                          <ul className="mt-1 divide-y divide-edge/60 overflow-hidden rounded-lg bg-paper-sunken/40">
                            {week.revisions.map((rev) => (
                              <PlanRow
                                key={rev.id}
                                plan={rev}
                                classId={classId}
                                onDelete={handleDelete}
                                deleting={deletingId === rev.id}
                                closing={deletingIds.has(rev.id)}
                                selectionMode={false}
                                selected={false}
                                onToggleSelect={() => {}}
                              />
                            ))}
                          </ul>
                        </details>
                      </li>
                    )}
                  </Fragment>
                ))}
              </ul>
            )
          ) : weeks.length ? (
            <div className="flex flex-col items-center justify-center p-12 text-center mt-8">
              <Search size={32} className="text-ink-muted/30 mb-3" />
              <p className="text-sm font-medium text-ink">No plans found</p>
              <p className="text-sm text-ink-muted mt-1">We couldn't find any plans matching “{search}”.</p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center p-12 bg-paper/30 backdrop-blur-md rounded-2xl border border-dashed border-edge/50 text-center mt-4">
              <div className="bg-paper shadow-sm rounded-full p-4 mb-4 border border-edge/30">
                <FileText size={32} className="text-ink-muted" />
              </div>
              <h2 className="text-lg font-bold text-ink mb-2">Your library is empty</h2>
              <p className="text-sm text-ink-muted max-w-sm mb-6">
                When you build a weekly plan with the AI, it automatically saves here so you can download, share, and reuse it anytime.
              </p>
              <Link
                to={`/c/${classId}`}
                className="neo-raised inline-flex items-center gap-2 rounded-lg bg-ink px-5 py-2.5 text-sm font-semibold text-paper transition-all hover:bg-ink/90 shadow-md"
              >
                <span className="text-lg leading-none mt-[-2px]">+</span> Start Your First Plan
              </Link>
            </div>
          )}
        </div>
    </SplitLayout>
  )
}
