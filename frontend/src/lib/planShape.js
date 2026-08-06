/* The shared vocabulary of a lesson plan.
 *
 * Extracted so the desktop table and the phone day-cards cannot fork on what a
 * missing Thursday means. That reasoning is subtle and was written once, well,
 * inside LessonPlanTable — duplicating it into a second view is exactly how the
 * two would drift.
 */

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

export const SHORT_DAY = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
}

export const LESSON_PARTS = [
  ['Do Now', 'do_now'],
  ['During', 'during'],
  ['Assessment', 'assessment'],
]

/* Row order for the DOCUMENT, which mirrors florence-docx-v2 and must not
   change — the screen and the .docx agreeing is the product's promise. */
export const ROWS = [
  { label: 'Learning Targets', key: 'learning_targets' },
  { label: 'Standards', key: 'standards', cited: true },
  { label: 'ACT Alignment', key: 'act_alignment', cited: true },
  { label: 'Engagement Strategy', key: 'engagement_strategy', tags: true },
  { label: 'Lesson', key: null },
]

/* Field order for a PHONE, which is a different question.
 *
 * The six rows are not equal in phone value. The Lesson block is what a teacher
 * reads at 7:50am and the table renders it fifth — that ordering is an artefact
 * of the document's shape, not of anyone's need. Learning target frames the day
 * in one line; standards are explicitly a thing to check on a phone; ACT
 * alignment and engagement strategy are compliance fields checked once when the
 * plan is built.
 *
 * Deliberate. Do not "fix" this back to ROWS order. */
export const CARD_SECONDARY = [
  { label: 'ACT Alignment', key: 'act_alignment', cited: true },
  { label: 'Engagement Strategy', key: 'engagement_strategy', tags: true },
]

/** What to render for a weekday the plan has no entry for. Three states, not
 *  two, and the distinction matters more than it looks:
 *
 *    'no_school'  — a real, correct, final answer. There is no class that day.
 *    'pending'    — the model hasn't written it yet. Provisional; about to change.
 *    'incomplete' — generation stopped before it arrived. A gap to act on.
 *
 *  A boolean `streaming` flag is NOT sufficient: isStreaming flips false in
 *  useLessonStream's `finally` the instant Stop is pressed, while plan.days is
 *  still partial — so a boolean would flip un-arrived days straight to
 *  "No School" a second later, which is the same misreport with better timing. */
export function orderedDays(plan, missingDays = 'no_school') {
  const byName = new Map((plan?.days || []).map((d) => [d.name, d]))
  const fallback =
    missingDays === 'pending'
      ? { pending: true }
      : missingDays === 'incomplete'
        ? { incomplete: true }
        : { no_school: true }
  return DAYS.map((name) => byName.get(name) || { name, ...fallback })
}

export const dayState = (d) =>
  d?.no_school ? 'no_school' : d?.pending ? 'pending' : d?.incomplete ? 'incomplete' : 'ok'

/** Index of the day to open first: today if the week is running, else the first
 *  day school is actually in session. */
export function initialDayIndex(days, todayName) {
  const today = days.findIndex((d) => d.name === todayName && dayState(d) === 'ok')
  if (today >= 0) return today
  const firstTeaching = days.findIndex((d) => dayState(d) === 'ok')
  return firstTeaching >= 0 ? firstTeaching : 0
}
