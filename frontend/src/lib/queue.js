/* What the school calendar knows, for the one place the interface still asks.
 *
 * There is no calendar screen. The year shapes every generation from the server
 * side — backend/schoolcal.py reads the same file the prompt quotes, so a plan
 * cannot land five days of lessons inside Fall Break — and the only thing the
 * frontend needs from it is the answer to "which week is next?" That answer
 * picks the week a new plan is built for (ChatPage's effectiveWeek) and is
 * named in the empty chat's greeting so the choice is visible before the
 * generation, not discovered in the finished document afterward. It was a
 * clickable starter suggestion once; that was removed, the naming was not.
 *
 * Kept as a module rather than inlined because it is a real definition with
 * real edge cases (a closed week is not unplanned; a past week is not
 * actionable), and it was wrong in three different places before it was one.
 */

/** The next week that actually needs a plan: not already planned, not a week the
 *  school is shut, not in the past. */
export function firstUnplanned(weeks) {
  return (weeks || []).find((w) => !w.has_plan && !w.no_school && !w.is_past) || null
}
