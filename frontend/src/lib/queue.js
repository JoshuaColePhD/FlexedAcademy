/* "What needs planning next", derived in exactly one place.
 *
 * This expression lived inline in WeekBoard. It is now read by the rail card,
 * the calendar header, the phone bar and the /week/next redirect — and all four
 * read it from the SAME cached week board (queryKeys.calendar), so the queue is
 * structurally incapable of disagreeing with the grid behind it.
 *
 * That is the real fix for the sidebar's "Recent" list, which was a second index
 * of the same weeks under a different name and could drift from the board.
 */

/** The next week that actually needs a plan: not already planned, not a week the
 *  school is shut, not in the past. */
export function firstUnplanned(weeks) {
  return (weeks || []).find((w) => !w.has_plan && !w.no_school && !w.is_past) || null
}

/** Weeks that have gone by unplanned. Distinct from "unplanned" — a teacher can
 *  do nothing about last week, so it belongs in a count, not in a call to
 *  action. */
export function weeksBehind(weeks) {
  return (weeks || []).filter((w) => !w.has_plan && !w.no_school && w.is_past).length
}

/** How much of the year is done, counting only weeks school is actually open. */
export function plannedCount(weeks) {
  const teachable = (weeks || []).filter((w) => !w.no_school)
  return { planned: teachable.filter((w) => w.has_plan).length, teachable: teachable.length }
}

/** The week to show when nobody named one: the current week if the year is
 *  running, else the next one that needs planning, else the first. */
export function defaultWeek(weeks) {
  return (
    (weeks || []).find((w) => w.is_current) || firstUnplanned(weeks) || (weeks || [])[0] || null
  )
}
