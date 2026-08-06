import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useCalendar } from '../hooks/useAppData'
import { firstUnplanned, weeksBehind } from '../lib/queue'
import { shortRange } from '../lib/dates'

/* The queue. One component, three placements — rail block, calendar header
 * line, phone bar — all reading the same cached week board as the grid.
 *
 * It is chrome, not a route: persistent because it lives in the frame, but it
 * never takes over the viewport and never blocks browsing the year. A "what's
 * next" mode that you have to leave to look around is a worse calendar.
 *
 * Rule 4 in force: this is the one blue thing. A week that needs planning is
 * the only thing in the app allowed to be accent, which is what lets a teacher
 * read the year as a to-do list from across the room.
 */

export function NextUp({ classId, variant = 'rail' }) {
  const { data, isLoading } = useCalendar(classId)
  const weeks = data?.weeks
  const next = firstUnplanned(weeks)
  const behind = weeksBehind(weeks)

  if (isLoading || !next) return null

  const to = `/c/${classId}/week/${next.week}`
  const dates = shortRange(next.start, next.end)

  if (variant === 'inline') {
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-ink-muted">
        <Link
          to={to}
          className="font-medium text-accent-text underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
        >
          Week {next.week} needs a plan
        </Link>
        <span className="text-xs">
          {dates}
          {behind ? ` · ${behind} earlier week${behind === 1 ? '' : 's'} unplanned` : ''}
        </span>
      </p>
    )
  }

  if (variant === 'bar') {
    return (
      <Link
        to={to}
        className="flex min-h-touch items-center gap-3 border-t border-edge bg-accent-tint px-gutter py-2.5"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-accent-text">
            Week {next.week} needs a plan
          </span>
          {/* Honest about the review-only phone scope: better than a button that
              opens a streaming UI this screen deliberately does not support. */}
          <span className="block truncate text-2xs text-ink-muted">
            {dates} · open on a computer to build it
          </span>
        </span>
        <ArrowRight size={15} aria-hidden="true" className="shrink-0 text-accent-text" />
      </Link>
    )
  }

  return (
    <div className="mx-2 mb-2 rounded-lg bg-accent-tint p-3">
      <p className="text-2xs font-semibold uppercase tracking-caps text-accent-text">Next up</p>
      <Link
        to={to}
        className="mt-1.5 flex items-baseline justify-between gap-2 text-sm font-medium text-ink hover:underline"
      >
        <span className="truncate">Week {next.week}</span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-muted">{dates}</span>
      </Link>
      {next.notes ? (
        <p className="mt-0.5 truncate text-2xs text-flag">{next.notes}</p>
      ) : null}
      <Link
        to={to}
        className="mt-2.5 flex min-h-touch items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-xs font-semibold text-ink-inverse transition-colors hover:bg-accent-hover"
      >
        Plan it <ArrowRight size={13} aria-hidden="true" />
      </Link>
      {behind ? (
        <p className="mt-2 text-2xs text-ink-muted">
          {behind} earlier week{behind === 1 ? '' : 's'} went unplanned
        </p>
      ) : null}
    </div>
  )
}
