import assert from 'node:assert/strict'
import { getContextualSuggestions, MAX_SUGGESTIONS, suggestionCompletion } from '../src/lib/contextualSuggestions.js'

const base = {
  activeClass: { id: 'eng', name: 'AP Language' },
  calendar: {
    has_calendar: true,
    weeks: [
      { week: 6, is_current: true, is_past: false, has_plan: false },
      { week: 7, is_current: false, is_past: false, has_plan: false },
    ],
  },
}

// The tray shows exactly one suggestion — top priority wins, full stop.
assert.equal(MAX_SUGGESTIONS, 1)

const currentWeek = getContextualSuggestions(base)
assert.equal(currentWeek.length, 1)
assert.equal(currentWeek[0].id, 'plan-current-week')
assert.equal(currentWeek[0].label, 'Plan Week 6')
assert.ok(currentWeek[0].reason.includes('unplanned'))

// continue-draft only wins when no target week outranks it — an unplanned
// current week (like `base`'s) would otherwise beat it every time.
const unfinished = getContextualSuggestions({
  activeClass: base.activeClass,
  calendar: { has_calendar: true, weeks: [] },
  surface: 'library',
  activeChat: { id: 'chat-1', updated_at: new Date().toISOString() },
})
assert.equal(unfinished.length, 1)
assert.equal(unfinished[0].id, 'continue-draft')

const missingSetup = getContextualSuggestions({
  activeClass: base.activeClass,
  calendar: { has_calendar: false, weeks: [] },
})
assert.equal(missingSetup.length, 1)
assert.equal(missingSetup[0].id, 'add-school-calendar')

// A built plan always outranks create-quiz's identical `artifact` trigger —
// review-current-plan is the one and only suggestion here.
const builtPlan = getContextualSuggestions({
  ...base,
  calendar: {
    ...base.calendar,
    weeks: base.calendar.weeks.map((week, index) => (index === 0 ? { ...week, has_plan: true, status: 'built' } : week)),
  },
  artifact: { planId: 'plan-1' },
})
assert.equal(builtPlan.length, 1)
assert.equal(builtPlan[0].id, 'review-current-plan')

assert.deepEqual(getContextualSuggestions({ ...base, busy: true }), [])
assert.deepEqual(getContextualSuggestions({ ...base, voiceOpen: true }), [])
assert.deepEqual(getContextualSuggestions({ ...base, pendingQuestions: { questions: [] } }), [])

// No pacing guide: add-pacing-guide always wins over plan-current-week's
// identical-priority-adjacent trigger, so the composer never gets a chance
// to promise a pacing guide it doesn't have.
const noGuide = getContextualSuggestions({ ...base, hasPacingGuide: false })
assert.equal(noGuide.length, 1)
assert.equal(noGuide[0].id, 'add-pacing-guide')

// Once a conversation has messages, add-pacing-guide has no home (the
// composer filters out every 'open-settings' suggestion; only the Greeting's
// empty-state hint can show one, and Greeting doesn't render once there are
// messages). MAX_SUGGESTIONS=1 used to mean this suggestion still won the
// slot and got silently dropped by the composer, leaving no suggestion at
// all even with a freshly built plan sitting right there.
const noGuideWithMessages = getContextualSuggestions({
  ...base,
  calendar: {
    ...base.calendar,
    weeks: base.calendar.weeks.map((week, index) => (index === 0 ? { ...week, has_plan: true, status: 'built' } : week)),
  },
  hasPacingGuide: false,
  messages: [{ role: 'user', content: 'build it' }],
  artifact: { planId: 'plan-1' },
})
assert.equal(noGuideWithMessages.length, 1)
assert.equal(noGuideWithMessages[0].id, 'review-current-plan')

// An explicitly picked week that already has a plan gets its own suggestion
// instead of silently being answered with an unrelated future week. Needs a
// pacing guide in this fixture so add-pacing-guide doesn't shadow it.
const plannedTarget = getContextualSuggestions({
  ...base,
  calendar: {
    ...base.calendar,
    weeks: [
      { week: 6, is_current: true, is_past: false, has_plan: true },
      { week: 7, is_current: false, is_past: false, has_plan: false },
    ],
  },
})
assert.equal(plannedTarget.length, 1)
assert.equal(plannedTarget[0].id, 'revise-planned-week')
assert.equal(plannedTarget[0].label, 'Revise Week 6')

// prepare-next-week is the true last resort: only wins when no target week,
// recent chat, decision, or artifact outranks it.
const noTargetAtAll = getContextualSuggestions({
  activeClass: base.activeClass,
  calendar: { has_calendar: true, weeks: [{ week: 9, is_current: false, is_past: false, has_plan: false }] },
})
assert.equal(noTargetAtAll.length, 1)
assert.equal(noTargetAtAll[0].id, 'prepare-next-week')

const primary = currentWeek[0]
assert.equal(suggestionCompletion('Help me', primary), primary.prompt.slice('Help me'.length))
assert.equal(suggestionCompletion('unrelated', primary), '')
assert.equal(suggestionCompletion('', primary), primary.prompt)

const contextual = getContextualSuggestions({
  ...base,
  messages: [{ id: 'turn-1', role: 'user', content: 'Make a lesson plan about rhetorical analysis of Gatsby.' }],
})
assert.equal(contextual.length, 1)
assert.equal(contextual[0].id, 'follow-up:turn-1')
assert.equal(contextual[0].prompt, "Let's keep building the rhetorical analysis of Gatsby.")

const nonPlanningFollowUp = getContextualSuggestions({
  ...base,
  messages: [{ id: 'turn-2', role: 'user', content: 'Count from 1 to 30.' }],
})
assert.equal(nonPlanningFollowUp[0].id, 'plan-current-week')

console.log('contextual suggestion tests passed')
