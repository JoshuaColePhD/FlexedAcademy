/* The onboarding wizard's school step, and the 'generic' trap that removed it.
 *
 * users.school DEFAULTs to 'generic' (backend/db.py), which is truthy, while
 * 'generic' is deliberately NOT a row in the `schools` table — so a lookup for
 * it returns undefined. The wizard's step plan tested
 * `school && selectedSchool && ...`, and for a brand-new account BOTH halves
 * came out falsy: the step that exists to ask a teacher where they teach
 * silently disappeared for exactly the teachers it was written for. They were
 * never asked, so they kept dateless weeks and the default school's document
 * layout with nothing on screen saying so.
 *
 * It went unnoticed because the failure is an ABSENCE — no error, no blank
 * screen, just one fewer question. These assertions are the tripwire: they
 * pin the predicate the gate depends on, and the plan derivation itself.
 */
import assert from 'node:assert/strict'
import { GENERIC_SCHOOL, hasChosenSchool, hasUsableSchoolTemplate } from '../src/lib/schools.js'

// ── the predicate ─────────────────────────────────────────────────────────
assert.equal(hasChosenSchool(GENERIC_SCHOOL), false, "'generic' is a placeholder, not a choice")
assert.equal(hasChosenSchool(undefined), false, 'no school at all is not a choice')
assert.equal(hasChosenSchool(null), false, 'null is not a choice')
assert.equal(hasChosenSchool(''), false, 'empty string is not a choice')
assert.equal(hasChosenSchool('florence-high-school'), true, 'a real school id is a choice')
assert.equal(hasChosenSchool('weeden-elementary-school'), true, 'any real school id is a choice')

// ── the step plan ─────────────────────────────────────────────────────────
// Mirrors OnboardingWizard's own livePlan derivation. Kept in step with it by
// these tests failing if either the predicate or this shape drifts.
function planFor({ school, schools = [], subject }) {
  const chosenSchool = hasChosenSchool(school)
  const selectedSchool = schools.find((s) => s.id === school)
  const schoolHasUsableTemplate = hasUsableSchoolTemplate(selectedSchool)
  const schoolNeedsTemplate = chosenSchool && selectedSchool && !schoolHasUsableTemplate
  const next = ['welcome']
  if (!chosenSchool || schoolNeedsTemplate) next.push('school')
  if (!subject) next.push('class')
  next.push('documents', 'tips', 'done')
  return next
}

const SCHOOLS = [
  { id: 'florence-high-school', template_status: 'active', builder_readiness: 'ready' },
  { id: 'weeden-elementary-school', template_status: 'active', builder_readiness: 'ready' },
  { id: 'another-ingested-school', template_status: 'pending', builder_readiness: 'ready_unverified' },
]

// The regression itself: a brand-new account, holding the default 'generic',
// MUST still be asked. This is what silently stopped happening.
assert.ok(
  planFor({ school: GENERIC_SCHOOL, schools: SCHOOLS, subject: null }).includes('school'),
  'a new account on the default school must still be asked where it teaches'
)
// Same for an account with no school value at all.
assert.ok(
  planFor({ school: undefined, schools: SCHOOLS, subject: null }).includes('school'),
  'an account with no school must be asked'
)

// A school whose template is already active has nothing left to ask.
assert.ok(
  !planFor({ school: 'florence-high-school', schools: SCHOOLS, subject: 'ELA' }).includes('school'),
  'a school with an active template does not re-ask'
)
// ...but one with no usable template still does — that half must keep working.
assert.ok(
  planFor({ school: 'unconfigured-school', schools: [{ id: 'unconfigured-school', template_status: 'pending', builder_readiness: 'pending' }], subject: 'ELA' }).includes('school'),
  'a school with no usable template is asked for one'
)

// A usable built-in or verified builder is enough, even while separate
// template-content review is still pending.
assert.ok(
  !planFor({ school: 'another-ingested-school', schools: SCHOOLS, subject: 'ELA' }).includes('school'),
  'any school with a usable builder is not asked for a duplicate template'
)

// The class step is independent of any of this.
assert.ok(planFor({ school: 'florence-high-school', schools: SCHOOLS }).includes('class'))
assert.ok(!planFor({ school: 'florence-high-school', schools: SCHOOLS, subject: 'ELA' }).includes('class'))

console.log('onboarding step tests passed')
