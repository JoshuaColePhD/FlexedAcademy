/* Date formatting only. Nothing here computes WHICH dates a week contains —
 * that comes from the teacher's own school's calendar file, under
 * backend/context/calendars/, via /api/weeks — and the browser deriving it
 * is the bug that put a lesson plan inside Fall Break. */

const MONTH_DAY = { month: 'short', day: 'numeric' }

const parse = (iso) => new Date(`${iso}T00:00:00`)

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

export const todayISO = () => new Date().toISOString().slice(0, 10)
