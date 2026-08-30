/* The shared vocabulary of a lesson plan.
 *
 * Extracted so the desktop table and the phone day-cards cannot fork on what a
 * missing Thursday means. That reasoning is subtle and was written once, well,
 * inside LessonPlanTable — duplicating it into a second view is exactly how the
 * two would drift.
 */

// A unit name that's just the week number restated ("Week 12") adds nothing
// next to a week_label that already says "Week 12 — Oct 19-23, 2026" — see
// backend/units.py's unit_for_week(), which returns exactly this string
// whenever a course has no real UNIT_MAP entry for that week. Every place
// that appends `unit` after a week reference needs this same check, or the
// week number shows up twice.
const GENERIC_WEEK_UNIT = /^week\s*0*\d+$/i

export function unitSuffix(unit, sep = ' — ') {
  return unit && !GENERIC_WEEK_UNIT.test(unit.trim()) ? `${sep}${unit}` : ''
}

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

/* The human name for each plan-shape key. The keys are what the API takes and
   what backend/schema.py validates against; these are what a teacher reads in
   the transcript ("Updated Wednesday's Do Now"). Mirrors prompts.FIELD_LABELS —
   one list of revisable fields, named the same way on both sides. */
export const FIELD_LABELS = {
  learning_targets: 'Learning Targets',
  standards: 'Standards',
  act_alignment: 'ACT Alignment',
  engagement_strategy: 'Engagement Strategy',
  do_now: 'Do Now',
  during: 'During',
  assessment: 'Assessment',
}

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

/** What the week strip puts under the day letters.
 *
 *  `title` is the two-to-four-word label the model now writes ("Ethos &
 *  audience"). Plans built before that field existed have none, so this falls
 *  back to the learning target with its mandatory "I can " lopped off — which
 *  is still long, but it is the difference between a readable cell and four
 *  clipped words of boilerplate repeated five times. */
export function dayTitle(day) {
  const title = String(day?.title || '').trim()
  if (title) return title
  if (day?.no_school) return 'No school'
  const lt = String(day?.learning_targets || '').trim()
  if (!lt) return ''
  const stripped = lt.replace(/^I can\s+/i, '')
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
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
