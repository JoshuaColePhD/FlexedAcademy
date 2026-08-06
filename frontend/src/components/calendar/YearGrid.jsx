import { Fragment, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check } from 'lucide-react'
import { dayNum, monthKey, monthLabel, shortRange, todayISO } from '../../lib/dates'

/* The year, spatially.
 *
 * A school year is 43 weeks x 5 days. That is not a month grid — it is a ribbon
 * five columns wide — so this is five columns at EVERY breakpoint, running
 * vertically, sectioned by sticky month headers. The phone layout is then the
 * desktop layout minus the right-hand rail rather than a second design, and the
 * spatial structure survives all the way down to 375px.
 *
 * This replaces a flat one-row-per-week list. The list could say "week 15 has a
 * closure"; it could not say WHICH day, because the data didn't carry days.
 * Now it does (schoolcal.week_days), so Veterans Day shades the Wednesday cell
 * and Fall Break shades the whole row.
 *
 * Rule 4 is enforced hard here: planned weeks are --ok, closures are a hatch,
 * and the ONLY blue on the board is the single week that needs planning next.
 * That is what makes the year readable as a to-do list rather than decoration.
 */

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

/** Backfill for a board served before the day-level calendar shipped, so the
 *  grid renders rather than collapsing if the two get out of step. */
function daysFor(week) {
  if (week.days?.length) return week.days
  const start = new Date(`${week.start}T00:00:00`)
  const monday = new Date(start)
  monday.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return {
      date: d.toISOString().slice(0, 10),
      dow: DOW[i],
      is_school: !week.no_school,
      note: week.no_school ? week.notes || 'No school' : '',
    }
  })
}

function DayCell({ day, isToday }) {
  const closed = !day.is_school
  return (
    <div
      className={`relative flex min-h-[3.25rem] flex-col justify-between px-1.5 py-1 sm:px-2 ${
        closed ? 'bg-paper-sunken bg-hatch-closed' : 'bg-paper-raised'
      }`}
    >
      <span
        className={`text-right text-2xs tabular-nums ${
          closed ? 'text-ink-faint' : 'text-ink-soft'
        } ${isToday ? 'ml-auto grid h-5 w-5 place-items-center rounded-full ring-2 ring-ink' : ''}`}
      >
        {dayNum(day.date)}
      </span>
      {day.note ? (
        <span className="truncate text-[0.625rem] leading-tight text-ink-muted" title={day.note}>
          {day.note}
        </span>
      ) : null}
    </div>
  )
}

function WeekRow({ week, classId, isNext, today, rowRef }) {
  const days = daysFor(week)
  const to = `/c/${classId}/week/${week.week}`

  return (
    <div
      ref={rowRef}
      className={`contents ${week.is_current ? 'is-current' : ''}`}
      data-current={week.is_current || undefined}
    >
      {/* week number — the spine of the year, and what the URL is keyed on */}
      <Link
        to={to}
        className={`year-wk hidden items-center justify-end px-1.5 sm:flex ${
          week.is_current ? 'font-semibold text-accent-text' : 'text-ink-faint'
        }`}
        aria-label={`Week ${week.week}, ${shortRange(week.start, week.end)}`}
      >
        {String(week.week).padStart(2, '0')}
      </Link>

      {days.map((d) => (
        <Link key={d.date} to={to} className="contents">
          <DayCell day={d} isToday={d.date === today} />
        </Link>
      ))}

      {/* The rail: what the week is about, or what it needs.
          A column, not a row — the action and the calendar note were competing
          for 14rem and both losing. The note is secondary here anyway; the day
          cells already carry the closure in the column it falls in. */}
      <div className="year-rail flex min-w-0 flex-col justify-center gap-0.5 bg-paper-raised px-2 py-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-2xs tabular-nums text-ink-faint sm:hidden">
            {String(week.week).padStart(2, '0')}
          </span>
          {week.no_school ? (
            <span className="truncate text-xs text-ink-muted">{week.notes || 'No school'}</span>
          ) : week.has_plan ? (
            <Link to={to} className="flex min-w-0 flex-1 items-center gap-1.5 hover:underline">
              <Check size={13} aria-hidden="true" className="shrink-0 text-ok" />
              <span className="truncate text-xs text-ink">{week.unit || 'Planned'}</span>
            </Link>
          ) : isNext ? (
            <Link
              to={to}
              className="flex min-h-touch min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-semibold text-ink-inverse transition-colors hover:bg-accent-hover"
            >
              Plan it <ArrowRight size={12} aria-hidden="true" className="shrink-0" />
            </Link>
          ) : (
            <Link
              to={to}
              className={`min-w-0 flex-1 truncate text-xs hover:underline ${
                week.is_past ? 'text-ink-faint' : 'text-ink-muted'
              }`}
            >
              {week.is_past ? 'Not planned' : 'Plan'}
            </Link>
          )}
        </div>
        {week.notes && !week.no_school ? (
          <span className="truncate text-2xs text-flag" title={week.notes}>
            {week.notes}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export function YearGrid({ weeks, classId, nextWeekNo }) {
  const currentRef = useRef(null)
  const today = todayISO()

  // Land on the current week rather than at the top of August.
  useEffect(() => {
    if (!currentRef.current) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    currentRef.current.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  }, [weeks?.length])

  let lastMonth = null

  return (
    <div className="year-grid">
      <div className="year-head" aria-hidden="true" />
      {DOW.map((d) => (
        <div key={d} className="year-head">{d}</div>
      ))}
      <div className="year-head year-rail" />

      {(weeks || []).map((w) => {
        const key = monthKey(w.start)
        const newMonth = key !== lastMonth
        lastMonth = key
        return (
          <Fragment key={w.week}>
            {newMonth ? (
              <h2 className="year-month">{monthLabel(w.start)}</h2>
            ) : null}
            <WeekRow
              week={w}
              classId={classId}
              isNext={w.week === nextWeekNo}
              today={today}
              rowRef={w.is_current ? currentRef : undefined}
            />
          </Fragment>
        )
      })}
    </div>
  )
}
