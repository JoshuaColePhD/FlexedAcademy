import { useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, SlidersHorizontal } from 'lucide-react'
import { useAsync } from '../hooks/useAsync'
import { api } from '../lib/api'
import { errorParts } from '../lib/apiError'

/* The home screen: a teacher's year, one row per week.
 *
 * This replaces a centred greeting over a text box. That layout was the Claude
 * desktop home screen, and on a lesson planner it answered the wrong question —
 * it asked what you wanted to say, when what a teacher needs to see is which
 * weeks are still unplanned and what is coming.
 *
 * Every date here comes from backend/context/school_calendar.md, the same file
 * the generation prompt quotes. Nothing is computed in the browser. That is the
 * fix for weeks being invented: "next Monday" used to be a Date() call with no
 * idea whether that week was Fall Break.
 */

const MONTH = { month: 'short', day: 'numeric' }

function range(startISO, endISO) {
  const s = new Date(`${startISO}T00:00:00`)
  const e = new Date(`${endISO}T00:00:00`)
  const sm = s.toLocaleDateString('en-US', MONTH)
  const em =
    s.getMonth() === e.getMonth()
      ? e.getDate()
      : e.toLocaleDateString('en-US', MONTH)
  return `${sm}–${em}`
}

/** One row. Dense on purpose — a teacher scanning for the next gap should get
 *  a dozen weeks on screen, not three cards. */
function WeekRow({ week, onPlan, onOpen, isFirstUpcoming }) {
  const closed = week.no_school
  const planned = week.has_plan

  return (
    <li
      className={`group flex items-center gap-3 border-b border-edge px-3 py-2 transition-colors last:border-b-0 ${
        week.is_current ? 'bg-accent-tint' : closed ? 'bg-paper-sunken/60' : 'hover:bg-paper-sunken/60'
      }`}
    >
      {/* Week number — the spine of the year, and what week_label is keyed on. */}
      <span
        className={`w-7 shrink-0 text-right font-mono text-xs tabular-nums ${
          week.is_current ? 'font-semibold text-accent' : 'text-ink-faint'
        }`}
      >
        {week.week}
      </span>

      <span className="w-[5.5rem] shrink-0 text-xs tabular-nums text-ink-muted">
        {range(week.start, week.end)}
      </span>

      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        {closed ? (
          <span className="truncate text-sm text-ink-muted">{week.notes || 'No school'}</span>
        ) : (
          <>
            {/* For a planned week, its unit — not its dates again; those are
                already the column to the left. A plan built before units were
                derived has none, and the ✓ Planned marker carries the meaning. */}
            <span className={`truncate text-sm ${planned ? 'text-ink' : 'text-ink-soft'}`}>
              {planned ? week.unit || '' : 'Not planned'}
            </span>
            {week.notes ? (
              /* A short week is worth knowing BEFORE building five days for it. */
              <span className="hidden shrink-0 truncate text-xs text-flag sm:inline">
                {week.notes}
              </span>
            ) : null}
          </>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-1">
        {closed ? null : planned ? (
          <>
            <span className="flex items-center gap-1 text-xs text-ok">
              <Check size={13} aria-hidden="true" />
              <span className="hidden sm:inline">Planned</span>
            </span>
            <button
              type="button"
              onClick={() => onOpen(week)}
              className="rounded-md px-2 py-1 text-xs font-medium text-ink-muted opacity-0 transition hover:bg-paper-inset hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
            >
              Open
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onPlan(week)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              isFirstUpcoming
                ? 'bg-accent text-ink-inverse hover:bg-accent-hover'
                : 'text-accent opacity-0 hover:bg-accent-tint focus-visible:opacity-100 group-hover:opacity-100'
            }`}
          >
            Plan it
            <ArrowRight size={12} aria-hidden="true" />
          </button>
        )}
      </span>
    </li>
  )
}

export function WeekBoard({ activeClass, onPlanWeek, onOpenPlan }) {
  const classId = activeClass?.id
  const state = useAsync((signal) => api.getWeeks(classId, { signal }), [classId])

  const weeks = useMemo(() => state.data?.weeks || [], [state.data])
  const currentRef = useRef(null)

  // Land on the current week rather than at the top of August.
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center' })
  }, [weeks.length])

  // The next week that actually needs planning — the one action on this screen
  // that gets a filled button.
  const firstUnplanned = weeks.find((w) => !w.has_plan && !w.no_school && !w.is_past)

  if (state.isError) {
    const { message, hint } = errorParts(state.error)
    return (
      <div className="mx-auto w-full max-w-measure px-5 py-10">
        <div className="rounded-xl border border-mark/25 bg-mark-tint p-4">
          <strong className="block text-sm font-semibold text-mark">
            Couldn’t load your year
          </strong>
          <p className="mt-1 text-sm text-ink-soft">{hint || message}</p>
          <p className="mt-2 text-xs text-ink-muted">
            If this is a fresh deploy, the classes migration may not have run yet.
          </p>
          <button
            type="button"
            onClick={state.run}
            className="mt-3 text-sm font-medium text-mark underline underline-offset-4"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  const planned = weeks.filter((w) => w.has_plan).length
  const teachable = weeks.filter((w) => !w.no_school).length

  return (
    <div className="mx-auto w-full max-w-measure px-5 py-8">
      <header className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          {activeClass?.name || state.data?.class?.name || 'Your year'}
        </h1>
        <p className="text-xs text-ink-muted">
          {state.isFirstLoad
            ? 'Loading the calendar…'
            : `${planned} of ${teachable} teaching weeks planned`}
        </p>
      </header>

      {!state.isFirstLoad && weeks.length === 0 ? (
        <p className="rounded-xl bg-paper-sunken p-4 text-sm text-ink-muted">
          No school calendar found. Add one at{' '}
          <code className="font-mono text-xs">backend/context/school_calendar.md</code> and it will
          show up here.
        </p>
      ) : (
        <ol className="overflow-hidden rounded-xl border border-edge bg-paper-raised">
          {weeks.map((w) => (
            <div key={w.week} ref={w.is_current ? currentRef : undefined}>
              <WeekRow
                week={w}
                onPlan={onPlanWeek}
                onOpen={onOpenPlan}
                isFirstUpcoming={firstUnplanned?.week === w.week}
              />
            </div>
          ))}
        </ol>
      )}

      {!activeClass && !state.isFirstLoad ? (
        <Link
          to="/my-class"
          className="mt-4 flex items-center gap-2 rounded-xl bg-paper-sunken px-4 py-3 text-sm text-ink-soft transition-colors hover:bg-paper-inset"
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          Set up a class so plans come out under the right course
          <ArrowRight size={13} aria-hidden="true" className="ml-auto text-ink-faint" />
        </Link>
      ) : null}
    </div>
  )
}
