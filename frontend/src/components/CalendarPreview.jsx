import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { shortRange } from '../lib/dates'

/* Read-only rendering of a parsed calendar submission's weeks — the same
 * list shape backend/schema.py's CALENDAR_JSON_SCHEMA produces and
 * schoolcal.py's file parser has always produced. It is intentionally shown
 * as a month grid here: teachers recognize a calendar at a glance more
 * quickly than a long sequence of week rows.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PREVIEW_ROWS = 12

function parseDate(value) {
  const [year, month, day] = String(value || '').slice(0, 10).split('-').map(Number)
  if (!year || !month || !day) return null
  const date = new Date(year, month - 1, day)
  return Number.isNaN(date.getTime()) ? null : date
}

function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function sameOrBefore(left, right) {
  return left.getTime() <= right.getTime()
}

function MonthGrid({ month, weeks }) {
  const firstDay = startOfMonth(month)
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const today = new Date()
  const leadingDays = firstDay.getDay()
  const cells = Array.from({ length: leadingDays + daysInMonth }, (_, index) => {
    if (index < leadingDays) return null
    return new Date(month.getFullYear(), month.getMonth(), index - leadingDays + 1)
  })

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-edge bg-paper/40">
      <div className="grid grid-cols-7 border-b border-edge bg-paper-sunken/60" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        {WEEKDAYS.map((day) => (
          <div key={day} className="py-1.5 text-center text-2xs font-semibold uppercase tracking-wide text-ink-faint">
            {day}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-edge/70" style={{ gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
        {cells.map((date, index) => {
          if (!date) return <div key={`blank-${index}`} className="min-h-14 bg-paper/30" aria-hidden="true" />

          const week = weeks.find((candidate) => {
            const start = parseDate(candidate.start)
            const end = parseDate(candidate.end) || start
            return start && end && sameOrBefore(start, date) && sameOrBefore(date, end)
          })
          const noSchool = Boolean(week?.no_school)
          const closure = Boolean(week?.closures)
          const active = Boolean(week)
          const isToday = date.getFullYear() === today.getFullYear()
            && date.getMonth() === today.getMonth()
            && date.getDate() === today.getDate()
          const tone = noSchool
            ? 'bg-mark-tint text-mark'
            : closure
              ? 'bg-flag-tint text-flag'
              : active
                ? 'bg-ok/10 text-ink'
                : 'bg-paper/30 text-ink-muted'

          return (
            <div
              key={dateKey(date)}
              title={week ? `Week ${String(week.week).padStart(2, '0')}${week.notes ? ` · ${week.notes}` : ''}` : undefined}
              aria-current={isToday ? 'date' : undefined}
              className={`relative min-h-14 p-1.5 ${tone}`}
            >
              <span className={`text-xs font-medium ${active ? 'text-ink' : 'text-ink-faint'}`}>{date.getDate()}</span>
              {isToday ? (
                <span
                  className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-red-500 shadow-[0_0_0_2px_var(--paper-raised)]"
                  title="Today"
                  aria-label="Today"
                />
              ) : null}
              {week ? (
                <span className="absolute bottom-1 right-1 text-[9px] font-semibold opacity-60">
                  W{String(week.week).padStart(2, '0')}
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WeekListFallback({ weeks }) {
  const shown = weeks.slice(0, PREVIEW_ROWS)
  const remaining = weeks.length - shown.length

  return (
    <div className="rounded-lg border border-edge">
      <ul className="max-h-72 divide-y divide-edge overflow-y-auto text-sm">
        {shown.map((week) => {
          const range = shortRange(week.start, week.end)
          return (
            <li key={week.week} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="text-ink">
                Week {String(week.week).padStart(2, '0')}
                {range ? <span className="text-ink-muted"> · {range}</span> : null}
              </span>
              {week.no_school ? (
                <span className="shrink-0 rounded-full bg-mark-tint px-2 py-0.5 text-2xs font-medium text-mark">No school</span>
              ) : week.closures ? (
                <span className="shrink-0 rounded-full bg-flag-tint px-2 py-0.5 text-2xs font-medium text-flag">
                  {week.notes || 'Partial closure'}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {remaining > 0 ? (
        <p className="border-t border-edge px-3 py-1.5 text-2xs text-ink-muted">
          +{remaining} more week{remaining === 1 ? '' : 's'}
        </p>
      ) : null}
    </div>
  )
}

export function CalendarPreview({ weeks }) {
  const [monthIndex, setMonthIndex] = useState(0)
  const validWeeks = (weeks || [])
    .map((week) => ({ ...week, parsedStart: parseDate(week.start), parsedEnd: parseDate(week.end) || parseDate(week.start) }))
    .filter((week) => week.parsedStart && week.parsedEnd)

  const months = useMemo(() => {
    if (!validWeeks.length) return []
    const first = startOfMonth(validWeeks[0].parsedStart)
    const last = startOfMonth(validWeeks.reduce((latest, week) => week.parsedEnd > latest ? week.parsedEnd : latest, validWeeks[0].parsedEnd))
    const result = []
    for (let cursor = first; sameOrBefore(cursor, last); cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
      result.push(cursor)
    }
    return result
  }, [validWeeks])

  const today = new Date()
  const todayMonthIndex = months.findIndex((month) => (
    month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth()
  ))
  useEffect(() => {
    if (todayMonthIndex >= 0) setMonthIndex(todayMonthIndex)
  }, [todayMonthIndex])

  if (!weeks?.length) return <p className="text-sm text-ink-muted">No weeks to show.</p>
  if (!months.length) return <WeekListFallback weeks={weeks} />

  const activeMonthIndex = Math.min(monthIndex, months.length - 1)
  const activeMonth = months[activeMonthIndex]
  const monthLabel = activeMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const firstMonthLabel = months[0].toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  const lastMonthLabel = months[months.length - 1].toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  const rangeLabel = months.length > 1 ? `${firstMonthLabel} – ${lastMonthLabel}` : monthLabel

  return (
    <div className="rounded-xl border border-edge bg-paper/40 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">{monthLabel}</p>
            <p className="mt-0.5 text-2xs text-ink-muted">{rangeLabel} · Month {activeMonthIndex + 1} of {months.length}</p>
        </div>
        {months.length > 1 ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMonthIndex((current) => Math.max(0, current - 1))}
              disabled={activeMonthIndex === 0}
              aria-label="Previous month"
              className="grid h-7 w-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setMonthIndex((current) => Math.min(months.length - 1, current + 1))}
              disabled={activeMonthIndex === months.length - 1}
              aria-label="Next month"
              className="grid h-7 w-7 place-items-center rounded-md text-ink-muted transition-colors hover:bg-paper-sunken hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
      <MonthGrid month={activeMonth} weeks={validWeeks} />
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-muted">
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Today</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-ok/50" /> Teaching week</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-flag/50" /> Closure</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-mark/50" /> No school</span>
      </div>
    </div>
  )
}
