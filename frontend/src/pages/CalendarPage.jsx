import { Link } from 'react-router-dom'
import { ArrowRight, SlidersHorizontal } from 'lucide-react'
import { useActiveClass, useCalendar } from '../hooks/useAppData'
import { firstUnplanned, plannedCount } from '../lib/queue'
import { errorParts } from '../lib/apiError'
import { YearGrid } from '../components/calendar/YearGrid'
import { NextUp } from '../components/NextUp'
import { SkeletonText } from '../components/Skeleton'

/* Home.
 *
 * This is a place now, not a state of a chat. The old home screen was whatever
 * ChatPage rendered when messages.length === 0, which is why no plan had a URL,
 * why the back button did nothing, and why the "Open" button on a planned week
 * was a silent no-op — there was nowhere for it to go.
 *
 * And there is no composer docked at the bottom of it any more. A year plus a
 * chat box reads as "chat app that also has a calendar".
 */
export function CalendarPage() {
  const { classId, activeClass, isLoading: classesLoading } = useActiveClass()
  const { data, isLoading, isError, error, refetch } = useCalendar(classId)

  const weeks = data?.weeks || []
  const next = firstUnplanned(weeks)
  const { planned, teachable } = plannedCount(weeks)

  if (isError) {
    const { message, hint } = errorParts(error)
    return (
      <div className="page">
        <div className="mx-auto w-full max-w-measure">
          <div className="rounded-xl border border-mark/25 bg-mark-tint p-4">
            <strong className="block text-sm font-semibold text-mark">Couldn’t load your year</strong>
            <p className="mt-1 text-sm text-ink-soft">{hint || message}</p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-3 min-h-touch text-sm font-medium text-mark underline underline-offset-4"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page scroll-y">
      <div className="mx-auto flex w-full max-w-measure-wide flex-col gap-4">
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-xl font-semibold tracking-display text-ink">
            {activeClass?.name || data?.class?.name || 'Your year'}
          </h1>
          <p className="font-mono text-xs tabular-nums text-ink-muted">
            {isLoading ? 'Loading the calendar…' : `${planned} of ${teachable} teaching weeks planned`}
          </p>
        </header>

        {/* The queue, inline — the same cache entry the grid below reads, so the
            two cannot disagree about which week is next. */}
        <NextUp classId={classId} variant="inline" />

        {isLoading ? (
          <div className="rounded-xl border border-edge p-4">
            <SkeletonText lines={10} />
          </div>
        ) : weeks.length === 0 ? (
          <p className="rounded-xl bg-paper-sunken p-4 text-sm text-ink-muted">
            No school calendar found. Add one at{' '}
            <code className="font-mono text-xs">backend/context/school_calendar.md</code> and it
            will show up here.
          </p>
        ) : (
          <YearGrid weeks={weeks} classId={classId} nextWeekNo={next?.week} />
        )}

        {!activeClass && !classesLoading ? (
          <Link
            to={`/c/${classId}/class`}
            className="flex min-h-touch items-center gap-2 rounded-xl bg-paper-sunken px-4 py-3 text-sm text-ink-soft transition-colors hover:bg-paper-inset"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            Set up a class so plans come out under the right course
            <ArrowRight size={13} aria-hidden="true" className="ml-auto text-ink-faint" />
          </Link>
        ) : null}
      </div>
    </div>
  )
}
