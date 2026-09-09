/* Date formatting only. Nothing here computes WHICH dates a week contains —
 * that comes from the teacher's own school's calendar file, under
 * backend/context/calendars/, via /api/weeks — and the browser deriving it
 * is the bug that put a lesson plan inside Fall Break. */

const MONTH_DAY = { month: 'short', day: 'numeric' }

const parse = (iso) => new Date(`${iso}T00:00:00`)

/** Local midnight, not UTC — a plain `new Date(iso)` on a date-only string
 * parses as UTC and can land on the wrong calendar day in any timezone west
 * of it. Exported for building an actual month grid (see ArtifactDetailPanel's
 * CalendarBody), where every cell needs a real Date to walk day-by-day. */
export const parseISO = parse

/** "Oct 19–23", or "Aug 31–Sep 4" when the week straddles a month. */
export function shortRange(startISO, endISO) {
  if (!startISO || !endISO) return ''
  const s = parse(startISO)
  const e = parse(endISO)
  const left = s.toLocaleDateString('en-US', MONTH_DAY)
  const right =
    s.getMonth() === e.getMonth() ? e.getDate() : e.toLocaleDateString('en-US', MONTH_DAY)
  return `${left}–${right}`
}

/** "Monday, October 19" — for a day heading, where the weekday is the point. */
export function longDay(iso) {
  if (!iso) return ''
  return parse(iso).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

/** "Oct 19" — for a card header, beside a weekday that is already shown. */
export function shortDay(iso) {
  if (!iso) return ''
  return parse(iso).toLocaleDateString('en-US', MONTH_DAY)
}

/** Just the numeral, for a calendar cell. */
export const dayNum = (iso) => (iso ? parse(iso).getDate() : '')

/** "August 2026" — the sticky section header on the year grid. */
export function monthLabel(iso) {
  if (!iso) return ''
  return parse(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

/** Month+year key, so consecutive weeks group under one heading. */
export const monthKey = (iso) => (iso ? iso.slice(0, 7) : '')

export const todayISO = () => {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

const MONTH_INDEX = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

const WEEK_RANGE = /(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:\s*[–—-]\s*(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+)?(\d{1,2}))?,?\s+(\d{4})/i

function toIso(year, monthIndex, day) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Map Mon–Fri to ISO dates from a label like "Week 18 — Nov 30–Dec 4, 2026".
 *  Returns null when the label has no real calendar range (e.g. "Week 11"). */
export function weekdayIsosFromWeekLabel(weekOf) {
  const match = String(weekOf || '').match(WEEK_RANGE)
  if (!match) return null
  const startMonth = MONTH_INDEX[match[1].toLowerCase()]
  const startDay = Number(match[2])
  const endMonth = match[3] ? MONTH_INDEX[match[3].toLowerCase()] : startMonth
  const year = Number(match[5])
  if (startMonth == null || endMonth == null || !startDay || !year) return null
  const monday = new Date(year, startMonth, startDay)
  const friday = new Date(year, endMonth, Number(match[4] || match[2]))
  if (Number.isNaN(monday.getTime()) || Number.isNaN(friday.getTime())) return null
  const out = {}
  for (let i = 0; i < WEEKDAY_NAMES.length; i += 1) {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)
    if (date > friday) break
    out[WEEKDAY_NAMES[i]] = toIso(date.getFullYear(), date.getMonth(), date.getDate())
  }
  return out
}

/** Same calendar day, local time, for two real datetimes (created_at
 *  values) — not the date-only strings the rest of this file parses. Used to
 *  decide whether the transcript needs a day separator between two adjacent
 *  messages (see ChatPage.jsx's DaySeparator). */
export function isSameDay(isoA, isoB) {
  if (!isoA || !isoB) return false
  const a = new Date(isoA)
  const b = new Date(isoB)
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

/** "Today" / "Yesterday" / "Tuesday, August 25" (the year only when it isn't
 *  this one) — the label on a transcript's day separator. `iso` is a real
 *  datetime, same as isSameDay above. */
export function dayLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  const opts = { weekday: 'long', month: 'long', day: 'numeric' }
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric'
  return d.toLocaleDateString('en-US', opts)
}

/** "Aug 22, 9:48 AM" — a full created/built timestamp, not a plain calendar
 *  date: for telling apart two records that otherwise share a title (e.g.
 *  two quizzes built for the same week, minutes apart). `iso` here is a
 *  real datetime (a DB created_at), not the date-only strings the rest of
 *  this file parses, so it goes straight to `Date`, no `parse()`. */
export function shortDateTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
