/* The ONE onboarding derivation, and the metadata every consumer reads.
 *
 * Dependency-free on purpose: scripts/test-onboarding-steps.mjs imports this
 * directly under plain Node (npm run test:onboarding, run in CI by
 * .github/workflows/quality.yml). No React, no api.js, no queryKeys — only
 * lib/schools.js and lib/states.js, which are themselves plain data. That
 * constraint is invisible and easy to break with one convenient import, so if
 * you reach for a hook or a fetch here, put it in the caller instead.
 *
 * This module exists because the derivation used to live in two places. The
 * wizard had the real one and this test re-implemented it, with a comment
 * claiming the copy was "kept in step with it by these tests failing if either
 * the predicate or this shape drifts." It wasn't: the copy lacked the
 * `variant` branch and the schoolTemplateSelectionStep term, and CI stayed
 * green the whole time because it was validating the copy against itself.
 * There is one derivation now, and the test imports it.
 */
import { GENERIC_SCHOOL, hasChosenSchool, hasUsableSchoolTemplate } from './schools.js'

/* Canonical order, and the reason plan shape can't drift.
 *
 * derivePlan() FILTERS this array rather than pushing onto an empty one. That
 * is a deliberate structural choice: a push-based derivation can emit the same
 * key twice (which is exactly how course+grade came to be asked on /welcome
 * and again in the wizard) and can emit two keys in an order that contradicts
 * another branch. Filtering a single ordered list makes both impossible to
 * express, so the no-duplicates and stable-order tests can never fail for a
 * reason a reviewer has to reason about.
 */
export const STEP_ORDER = [
  'avatar',
  'course',
  'state',
  'school',
  'calendar',
  'format',
  'preview',
  'materials',
]

/* Per-step metadata. `label` is what the step rail renders — a short noun, not
 * a sentence, because it sits beside a question that already asks the sentence
 * and the rail column is 11rem. `title` is that question. `skipLabel` states
 * the step's own cost in place of a generic "Skip", because the cost is the
 * only thing that makes a skip an informed choice: a teacher who skips
 * `school` gets dateless plans, and nothing in the product said so before.
 *
 * `required: true` is reserved for the two answers a wrong-or-missing value
 * makes actively harmful. retrieval filters on course AND grade, and
 * service._resolve_subject_grade's silent fallback to grade 11 is the
 * documented catastrophic failure (db.py migration 38: "a wrong-grade answer
 * looks right and is wrong, which is the one thing this product exists to
 * prevent"). Everything else is genuinely optional and says what it costs.
 */
export const ONBOARDING_STEPS = {
  avatar: {
    label: 'Profile',
    title: 'First — pick a face for your profile.',
    required: false,
    skipLabel: "Skip — just use my initials",
  },
  course: {
    label: 'Course',
    title: 'Which course are you teaching?',
    required: true,
  },
  state: {
    label: 'Standards',
    title: "Which state's standards should ground your plans?",
    required: true,
  },
  school: {
    label: 'School',
    title: 'Which school do you teach at?',
    required: false,
    skipLabel: "Skip — I'll plan by week number for now",
  },
  calendar: {
    label: 'Calendar',
    title: 'Is this your school year?',
    required: false,
    skipLabel: 'Skip — the dates look right',
  },
  format: {
    label: 'Format',
    title: 'How should your plans be formatted?',
    required: false,
    skipLabel: 'Skip — use a neutral layout for now',
  },
  preview: {
    label: 'Preview',
    title: 'Does this look right?',
    required: false,
    reward: true,
  },
  materials: {
    label: 'Materials',
    title: 'Do you want to add your teaching materials?',
    required: false,
    skipLabel: "Skip — I'll add these later",
  },
}

/* The closed event vocabulary. Frozen and kept here, beside the steps, so a
 * renamed or removed step can't leave an orphaned event name behind — and so
 * the server-side allowlist has exactly one source to mirror.
 *
 * Deliberately carries no free text, no filenames (template.filename is a
 * district document name; section_count carries the same signal) and no school
 * id (already on users.school and joinable server-side). This is a K-12
 * product; setup telemetry must not be ABLE to contain a student name, a
 * lesson, or a district filename.
 */
export const ONBOARDING_EVENTS = Object.freeze({
  FLOW_STARTED: 'flow_started',
  STEP_VIEWED: 'step_viewed',
  STEP_COMPLETED: 'step_completed',
  STEP_SKIPPED: 'step_skipped',
  STEP_BACK: 'step_back',
  STEP_ERROR: 'step_error',
  TEMPLATE_ANALYZED: 'template_analyzed',
  PREVIEW_SHOWN: 'preview_shown',
  PREVIEW_FAILED: 'preview_failed',
  FLOW_SKIPPED: 'flow_skipped',
  FLOW_COMPLETED: 'flow_completed',
  STATE_UNSUPPORTED_INTEREST: 'state_unsupported_interest',
})

/** Which steps this account still has to answer.
 *
 *  Pure: plain data in, string[] out, no hooks and no I/O — that's what lets
 *  the test import it. Call it through useMemo, NOT through an effect: `schools`
 *  is an async query, so schoolNeedsTemplate can flip from false to true
 *  partway through a render. A version of this that stored the plan in state
 *  and recomputed it from a useEffect lagged one render behind that flip
 *  (effects commit after the render that triggered them), which was how the
 *  welcome screen's old step-count copy briefly showed a stale number before
 *  correcting itself.
 *
 *  Note `hasChosenSchool`, not a bare truthiness check on `school`. users.school
 *  DEFAULTs to 'generic', so a brand-new account that has never been asked
 *  anything already holds a truthy value, while schools.find() for that same
 *  value returns undefined because 'generic' is deliberately not a row in the
 *  table. The old test read `school && selectedSchool && ...`, so BOTH halves
 *  evaluated falsy for exactly the accounts the step exists for: every new
 *  teacher silently skipped it, was never asked where they teach, and got
 *  dateless weeks plus the default school's layout on every download with
 *  nothing saying so. See lib/schools.js.
 */
export function derivePlan({
  firstRun = false,
  subject = null,
  grade = null,
  state = null,
  school = null,
  schools = [],
  schoolTemplates = [],
  schoolTemplatesLoading = false,
  calendarStatus = 'none',
  hasMaterials = false,
} = {}) {
  const chosenSchool = hasChosenSchool(school)
  const selectedSchool = schools.find((s) => s.id === school)

  /* A school can have a usable hand-written or verified generated builder
   * while its separate template-content review is still pending. Onboarding
   * should ask for a file only when downloads genuinely have no usable school
   * format, not when the review status happens to lag behind the builder. */
  const schoolNeedsTemplate = chosenSchool && Boolean(selectedSchool) && !hasUsableSchoolTemplate(selectedSchool)
  /* More than one template on file (or still loading, so we don't yet know) is
   * a choice for the teacher to make rather than an upload to request. */
  const schoolTemplateSelectionStep = chosenSchool && (schoolTemplatesLoading || schoolTemplates.length > 1)

  const needed = {
    /* Asked on first run and never again -- NOT derived from users.avatar,
       and that distinction is the whole reason `firstRun` exists as a
       parameter. "Initials" is a legitimate, deliberate choice, and it stores
       avatar: null, which is byte-for-byte the same as "never been asked". A
       data-driven rule would therefore re-ask the one teacher who had already
       answered most clearly.
    
       This is not the `variant` parameter coming back. That one described
       PRESENTATION (page vs. modal) and was being used to force a duplicate
       course step; this describes whether the account is being set up for the
       first time, which genuinely changes what is worth asking. Re-running
       setup from Settings skips it, because by then the teacher has an avatar
       they chose and a menu to change it in. */
    avatar: firstRun,
    course: !subject || !grade,
    state: !state,
    school: !chosenSchool,
    /* Only when there is something to review or disclose. A confirmed,
     * uncorrected calendar is a rubber stamp, so it folds into the preview
     * step's receipt instead of spending a screen. `generic` earns the screen
     * for the opposite reason: it is the one case where the teacher has to be
     * TOLD something (backend/schoolcal.py's NO_CALENDAR_SCHOOL_ID returns
     * week numbers with no dates attached to any of them), and before this
     * that fact lived only in a code comment.
     *
     * The leading `!chosenSchool` is what keeps this MONOTONIC, and it is the
     * same trick `format` below uses for the same reason. Calendar status is a
     * property of a school, so it is unknowable until one is picked — without
     * this term, a teacher who had not yet chosen would get no calendar step,
     * then pick a school with a pending calendar and watch a NEW step appear
     * in the rail beside them. Steps may drop out of the plan as answers land
     * (that shrink is what frozenPlan hides mid-flow); a step must never
     * appear. See the monotonicity assertion in
     * scripts/test-onboarding-steps.mjs. */
    calendar: !chosenSchool || calendarStatus === 'pending' || school === GENERIC_SCHOOL,
    format: !chosenSchool || schoolNeedsTemplate || schoolTemplateSelectionStep,
    /* The payoff always renders. It is the only screen that gives something
     * back rather than asking for something, which is the whole reason it sits
     * before `materials` instead of after: asking for a teacher's biggest
     * upload lands very differently once the product has proved itself. */
    preview: true,
    materials: !hasMaterials,
  }

  return STEP_ORDER.filter((key) => needed[key])
}

/** What the step rail renders: the plan's metadata, in order, with position. */
export function planRail(plan) {
  return plan.map((key, index) => ({
    ...ONBOARDING_STEPS[key],
    key,
    index,
    of: plan.length,
  }))
}

export function isSkippable(key) {
  return !ONBOARDING_STEPS[key]?.required
}

/* Stepping is by KEY, not by index. The step list is built from what this
 * account still has to answer, so it isn't a fixed length — and an index into
 * a list that can grow or shrink underneath you is how a wizard lands someone
 * on the wrong screen. A key stays put. */
function step(plan, key, offset) {
  const i = plan.indexOf(key)
  if (i < 0) return plan[0]
  return plan[Math.min(Math.max(i + offset, 0), plan.length - 1)]
}

export function nextStep(plan, key) {
  return step(plan, key, 1)
}

export function prevStep(plan, key) {
  return step(plan, key, -1)
}

/** Where a returning teacher should land.
 *
 *  Guarded BOTH ways on purpose. A recorded step must still be in the freshly
 *  computed plan — an answer supplied somewhere else (Settings, My Class) may
 *  have removed that step since — and a plan that no longer contains it falls
 *  back to the first unanswered question rather than to the beginning. Never
 *  resume onto a question the teacher has already answered; that is the failure
 *  that makes people abandon a second time.
 */
export function resumeStep(plan, recordedStep) {
  if (recordedStep && plan.includes(recordedStep)) return recordedStep
  return plan[0]
}
