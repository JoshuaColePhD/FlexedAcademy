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
 * screen, just one fewer question. These assertions are the tripwire: they pin
 * the predicate the gate depends on, and the plan derivation itself.
 *
 * ── why this file changed ────────────────────────────────────────────────────
 * It used to re-implement the derivation in a local planFor(), with a comment
 * claiming the copy was "kept in step with it by these tests failing if either
 * the predicate or this shape drifts." That was not true, and could not be:
 * nothing imported the real derivation, so this file validated its own copy
 * against itself. The copy had drifted — no `variant` branch, no
 * schoolTemplateSelectionStep term, and it pushed 'school' where the wizard
 * pushed 'template' — and CI (.github/workflows/quality.yml runs
 * `npm run test:all`) stayed green through all of it.
 *
 * It now imports derivePlan from lib/onboardingPlan.js. That is the entire
 * point of the file: assertions about the real function, not about a replica.
 * Keep it dependency-free — this runs under plain Node, so lib/onboardingPlan.js
 * must never import React, api.js, or queryKeys.
 */
import assert from 'node:assert/strict'
import { GENERIC_SCHOOL, hasChosenSchool, hasUsableSchoolTemplate } from '../src/lib/schools.js'
import {
  ONBOARDING_EVENTS,
  ONBOARDING_STEPS,
  STEP_ORDER,
  derivePlan,
  isSkippable,
  nextStep,
  planRail,
  prevStep,
  resumeStep,
} from '../src/lib/onboardingPlan.js'

// ── the predicate ─────────────────────────────────────────────────────────
assert.equal(hasChosenSchool(GENERIC_SCHOOL), false, "'generic' is a placeholder, not a choice")
assert.equal(hasChosenSchool(undefined), false, 'no school at all is not a choice')
assert.equal(hasChosenSchool(null), false, 'null is not a choice')
assert.equal(hasChosenSchool(''), false, 'empty string is not a choice')
assert.equal(hasChosenSchool('florence-high-school'), true, 'a real school id is a choice')
assert.equal(hasChosenSchool('weeden-elementary-school'), true, 'any real school id is a choice')

const SCHOOLS = [
  { id: 'florence-high-school', template_status: 'active', builder_readiness: 'ready' },
  { id: 'weeden-elementary-school', template_status: 'active', builder_readiness: 'ready' },
  { id: 'another-ingested-school', template_status: 'pending', builder_readiness: 'ready_unverified' },
  { id: 'unconfigured-school', template_status: 'pending', builder_readiness: 'pending' },
]

assert.equal(hasUsableSchoolTemplate(SCHOOLS[0]), true, 'an active template is usable')
assert.equal(hasUsableSchoolTemplate(SCHOOLS[2]), true, 'a verified builder is usable while review lags')
assert.equal(hasUsableSchoolTemplate(SCHOOLS[3]), false, 'nothing usable means nothing usable')
assert.equal(hasUsableSchoolTemplate(undefined), false, 'a school that is not in the table has no template')

// A fully set-up account, used as the base every fixture varies from.
const SETTLED = {
  firstRun: false,
  subject: 'ap-lang',
  grade: '11',
  state: 'AL',
  school: 'florence-high-school',
  schools: SCHOOLS,
  schoolTemplates: [{ id: 't1' }],
  schoolTemplatesLoading: false,
  calendarStatus: 'confirmed',
  hasMaterials: true,
}

// ── the 'generic' regression, now against the REAL function ───────────────
// A brand-new account, holding the default 'generic', MUST still be asked.
// This is what silently stopped happening.
assert.ok(
  derivePlan({ ...SETTLED, school: GENERIC_SCHOOL }).includes('school'),
  'a new account on the default school must still be asked where it teaches'
)
assert.ok(
  derivePlan({ ...SETTLED, school: undefined }).includes('school'),
  'an account with no school must be asked'
)
assert.ok(
  !derivePlan(SETTLED).includes('school'),
  'an account with a real school is not asked again'
)

// ── the format step ───────────────────────────────────────────────────────
assert.ok(
  !derivePlan(SETTLED).includes('format'),
  'a school with an active template and one file on record does not re-ask'
)
assert.ok(
  derivePlan({ ...SETTLED, school: 'unconfigured-school' }).includes('format'),
  'a school with no usable template is asked for one'
)
assert.ok(
  !derivePlan({ ...SETTLED, school: 'another-ingested-school' }).includes('format'),
  'any school with a usable builder is not asked for a duplicate template'
)
assert.ok(
  derivePlan({ ...SETTLED, schoolTemplates: [{ id: 't1' }, { id: 't2' }] }).includes('format'),
  'more than one template on file is a choice for the teacher, so the step stays'
)
assert.ok(
  derivePlan({ ...SETTLED, schoolTemplatesLoading: true }).includes('format'),
  'while templates are still loading we do not yet know, so keep the step'
)

// ── course is present exactly when course or grade is missing ─────────────
// The double-ask bug: /welcome collected both, then the wizard asked again,
// because the derivation branched on `variant === 'page'` instead of on the
// data. There is one flow and one condition now.
for (const [subject, grade, expected] of [
  ['ap-lang', '11', false],
  [null, '11', true],
  ['ap-lang', null, true],
  [null, null, true],
]) {
  assert.equal(
    derivePlan({ ...SETTLED, subject, grade }).includes('course'),
    expected,
    `course step for subject=${subject} grade=${grade}`
  )
}

// ── the closing screen always renders, and is always LAST ────────────────
/* `preview` is the finish: its button records completion. It sat mid-order
   once, which made every step after it unreachable while the rail still
   advertised them -- so this pins the invariant rather than the intent. */
/* Every fixture here must include a step that COULD be sequenced after the
   closing screen, or the assertion is vacuous. An earlier version used only
   fixtures with hasMaterials: true -- so `materials` was never in the plan,
   `preview` was trivially last, and moving it back to the middle did not fail
   the suite. Checked by mutation, which is the only way to notice. */
for (const fixture of [
  { ...SETTLED, hasMaterials: false },
  { ...SETTLED, hasMaterials: false, firstRun: true },
  { ...SETTLED, hasMaterials: false, school: null },
  SETTLED,
]) {
  const plan = derivePlan(fixture)
  assert.ok(plan.includes('preview'), 'the closing screen always shows')
  assert.equal(plan[plan.length - 1], 'preview', 'and nothing is sequenced after it')
  assert.equal(nextStep(plan, plan[plan.length - 2]), 'preview', 'the step before it leads to it')
}

// ── every fixture, checked for the structural properties ──────────────────
// A combinatorial sweep rather than a handful of cases, because the bugs this
// file exists to catch were all shape bugs, not value bugs.
const FIXTURES = []
for (const firstRun of [true, false]) {
  for (const subject of ['ap-lang', null]) {
    for (const state of ['AL', null]) {
      for (const school of [null, GENERIC_SCHOOL, 'florence-high-school', 'unconfigured-school']) {
        for (const calendarStatus of ['confirmed', 'pending', 'none']) {
          for (const hasMaterials of [true, false]) {
            FIXTURES.push({
              ...SETTLED,
              firstRun,
              subject,
              grade: subject ? '11' : null,
              state,
              school,
              calendarStatus,
              hasMaterials,
            })
          }
        }
      }
    }
  }
}

for (const fixture of FIXTURES) {
  const plan = derivePlan(fixture)
  const where = JSON.stringify({
    school: fixture.school,
    subject: fixture.subject,
    calendarStatus: fixture.calendarStatus,
  })

  /* The assertion that would have caught the double course ask the day it
     landed. A push-based derivation can emit the same key twice; derivePlan
     filters STEP_ORDER precisely so it cannot. */
  assert.equal(new Set(plan).size, plan.length, `no plan contains a step twice — ${where}`)

  /* Catches a typo'd key, which the old re-implemented planFor() structurally
     could not: it asserted against its own literals. */
  assert.ok(
    plan.every((key) => key in ONBOARDING_STEPS),
    `every plan key has metadata — ${where}`
  )

  // Order is STEP_ORDER's order, always. No branch may reorder two steps.
  const canonical = STEP_ORDER.filter((key) => plan.includes(key))
  assert.deepEqual(plan, canonical, `plan follows STEP_ORDER — ${where}`)

  // The step rail's contract: a step with no label is an unlabelled dot.
  assert.ok(
    planRail(plan).every((s) => s.label && s.title),
    `every step has a rail label and a question — ${where}`
  )

  /* Required steps are never skippable, and any step that DOES offer a skip
     states what the skip costs.
    
     An earlier version asserted that every optional step must have a
     skipLabel, which conflated two different things and broke the moment the
     profile step stopped offering a skip — correctly, since its name is
     pre-filled and its icon defaults to initials, so Continue already IS the
     "leave it alone" path and a Skip button next to a filled field only
     raises the question of what it would do. Not every optional step has
     something to skip PAST. What matters is that the ones presenting a skip
     say what it costs, rather than a bare "Skip for now" that makes the
     consequence the teacher's problem to guess. */
  for (const key of plan) {
    const meta = ONBOARDING_STEPS[key]
    if (meta.required) {
      assert.equal(isSkippable(key), false, `${key} is required — ${where}`)
      assert.ok(!meta.skipLabel, `required step ${key} offers no skip — ${where}`)
    } else if (meta.skipLabel) {
      assert.match(
        meta.skipLabel,
        /—/,
        `${key}'s skip states its cost after an em dash, not a bare "Skip" — ${where}`
      )
    }
  }

  // Stepping stays inside the plan and is reversible.
  assert.equal(prevStep(plan, plan[0]), plan[0], `back from the first step stays put — ${where}`)
  assert.equal(
    nextStep(plan, plan[plan.length - 1]),
    plan[plan.length - 1],
    `forward from the last step stays put — ${where}`
  )
  for (let i = 0; i < plan.length - 1; i += 1) {
    assert.equal(nextStep(plan, plan[i]), plan[i + 1], `next walks forward — ${where}`)
    assert.equal(prevStep(plan, plan[i + 1]), plan[i], `prev walks back — ${where}`)
  }

  // Resume never lands on an answered question, and never off the plan.
  assert.ok(plan.includes(resumeStep(plan, 'format')), `resume stays inside the plan — ${where}`)
  assert.equal(resumeStep(plan, 'a-step-that-no-longer-exists'), plan[0], `a stale step falls back — ${where}`)
}

// ── monotonicity: a step may drop out, but must never APPEAR ──────────────
/* This is the property frozenPlan was defending, and the reason it is worth a
 * test rather than a state variable: a plan that can GROW moves the rail under
 * the teacher and renumbers everything they have already done. Shrinking is
 * allowed and expected — answering a question removes it — and frozenPlan in
 * the component is what hides that shrink mid-flow.
 *
 * The sweep walks each fixture through its own plan, applying the answer each
 * step writes, and asserts the freshly derived plan never contains a key the
 * original did not. The `!chosenSchool` terms on `format` and `calendar` are
 * what make this hold: both are properties of a school and unknowable before
 * one is picked, so both are assumed necessary until proven otherwise.
 */
const ANSWERS = {
  /* Answering the avatar step is what takes the account out of first-run for
     the purposes of this sweep -- see the note on `avatar` in derivePlan for
     why this is not read back off users.avatar. */
  avatar: () => ({ firstRun: false }),
  course: () => ({ subject: 'ap-lang', grade: '11' }),
  state: () => ({ state: 'AL' }),
  /* Picking a school REVEALS two things that were unknowable before it: whether
     that school has a usable format, and what state its calendar is in. Model
     the worst case for both — a school with no template and a calendar still
     awaiting review — because that is the combination that would make a step
     appear if either guard were dropped. An earlier version of this answer left
     calendarStatus untouched, and the monotonicity sweep passed even with the
     `!chosenSchool` guard removed from `calendar`; it was asserting over a case
     it never actually reached. */
  school: () => ({ school: 'unconfigured-school', calendarStatus: 'pending' }),
  calendar: () => ({ calendarStatus: 'confirmed' }),
  format: () => ({ schoolTemplates: [{ id: 't1' }], schoolTemplatesLoading: false }),
  preview: () => ({}),
  materials: () => ({ hasMaterials: true }),
}

for (const fixture of FIXTURES) {
  const original = derivePlan(fixture)
  const originalKeys = new Set(original)
  let answers = { ...fixture }

  for (const key of original) {
    answers = { ...answers, ...ANSWERS[key]() }
    const now = derivePlan(answers)
    const appeared = now.filter((k) => !originalKeys.has(k))
    assert.deepEqual(
      appeared,
      [],
      `answering '${key}' must not make a new step appear (got ${appeared.join(', ')}) — ` +
        `from ${JSON.stringify({ school: fixture.school, calendarStatus: fixture.calendarStatus })}`
    )
  }
}

// ── the skippability policy, pinned ───────────────────────────────────────
/* Deliberately a deep-equal on the whole set rather than a spot check, so
 * loosening it (or tightening it) is a deliberate, reviewed edit and not a
 * one-word change nobody notices. retrieval filters on course AND grade, and
 * service._resolve_subject_grade's silent fallback to grade 11 is the
 * documented catastrophic failure (db.py migration 38). */
assert.deepEqual(
  Object.keys(ONBOARDING_STEPS).filter((key) => ONBOARDING_STEPS[key].required),
  ['course', 'state'],
  'only course and state are required; everything else states its cost and can be skipped'
)

// Metadata and order can never disagree about which steps exist.
assert.deepEqual(
  [...STEP_ORDER].sort(),
  Object.keys(ONBOARDING_STEPS).sort(),
  'STEP_ORDER and ONBOARDING_STEPS describe the same set of steps'
)

// ── the avatar step is asked on first run only ────────────────────────────
assert.ok(derivePlan({ ...SETTLED, firstRun: true }).includes('avatar'), 'first run asks for a profile icon')
assert.ok(!derivePlan({ ...SETTLED, firstRun: false }).includes('avatar'), 're-running setup does not ask again')
assert.equal(
  derivePlan({ ...SETTLED, firstRun: true })[0],
  'avatar',
  'and it is the FIRST thing asked — the one question with no wrong answer'
)

// ── the JS vocabulary and the Python allowlist must agree ─────────────────
/* routes/onboarding.py re-declares the step keys and event names as frozensets,
 * because the alternative is trusting the client to name its own steps and
 * those values land in a column the admin funnel groups by. That is a
 * duplication across a language boundary, which is precisely the shape of the
 * problem this whole file was rewritten to fix — a second copy of a list, with
 * a comment asserting it stays in step and nothing checking.
 *
 * So check it. Parsing Python from a Node test is admittedly crude, but the
 * failure it prevents is real and silent: a step renamed on one side only means
 * every event for it is dropped server-side (routes/onboarding.py drops
 * unknown names rather than erroring, deliberately, so a beacon on pagehide
 * can't 400), and the funnel quietly loses a column with nothing on fire.
 */
import { readFileSync } from 'node:fs'

const pySource = readFileSync(new URL('../../backend/routes/onboarding.py', import.meta.url), 'utf8')

function pyFrozenset(name) {
  const match = pySource.match(new RegExp(`${name} = frozenset\\(\\{([^}]*)\\}`))
  assert.ok(match, `${name} not found in backend/routes/onboarding.py`)
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
}

assert.deepEqual(
  pyFrozenset('STEPS'),
  [...STEP_ORDER].sort(),
  'backend STEPS and frontend STEP_ORDER must describe the same steps'
)
assert.deepEqual(
  pyFrozenset('EVENT_NAMES'),
  Object.values(ONBOARDING_EVENTS).sort(),
  'backend EVENT_NAMES and frontend ONBOARDING_EVENTS must describe the same events'
)

console.log(`onboarding step tests passed (${FIXTURES.length} fixtures, vocabulary in sync with backend)`)
