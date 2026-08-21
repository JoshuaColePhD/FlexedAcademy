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

const currentWeek = getContextualSuggestions(base)
assert.equal(currentWeek[0].id, 'plan-current-week')
assert.equal(currentWeek[0].label, 'Plan Week 6')
assert.ok(currentWeek[0].reason.includes('unplanned'))

const unfinished = getContextualSuggestions({
  ...base,
  surface: 'library',
  activeChat: { id: 'chat-1', updated_at: new Date().toISOString() },
})
assert.equal(unfinished.some((suggestion) => suggestion.id === 'continue-draft'), true)

const missingSetup = getContextualSuggestions({
  activeClass: base.activeClass,
  calendar: { has_calendar: false, weeks: [] },
})
assert.equal(missingSetup[0].id, 'add-school-calendar')

const builtPlan = getContextualSuggestions({
  ...base,
  calendar: {
    ...base.calendar,
    weeks: base.calendar.weeks.map((week, index) => (index === 0 ? { ...week, has_plan: true, status: 'built' } : week)),
  },
  artifact: { planId: 'plan-1' },
})
assert.equal(builtPlan[0].id, 'review-current-plan')
assert.equal(builtPlan.some((suggestion) => suggestion.id === 'create-quiz'), true)
assert.ok(builtPlan.length <= MAX_SUGGESTIONS)

assert.deepEqual(getContextualSuggestions({ ...base, busy: true }), [])
assert.deepEqual(getContextualSuggestions({ ...base, voiceOpen: true }), [])
assert.deepEqual(getContextualSuggestions({ ...base, pendingQuestions: { questions: [] } }), [])

// No pacing guide: the composer must not promise one it doesn't have, in
// either the unplanned-week or next-unplanned-week prompt.
const noGuide = getContextualSuggestions({ ...base, hasPacingGuide: false })
assert.equal(noGuide[0].id, 'add-pacing-guide')
const noGuidePlan = noGuide.find((suggestion) => suggestion.id === 'plan-current-week')
assert.ok(!noGuidePlan.prompt.includes('pacing guide'))

// An explicitly picked week that already has a plan gets its own suggestion
// instead of silently being answered with an unrelated future week.
const plannedTarget = getContextualSuggestions({
  ...base,
  calendar: {
    ...base.calendar,
    weeks: [
      { week: 6, is_current: true, is_past: false, has_plan: true },
      { week: 7, is_current: false, is_past: false, has_plan: false },
    ],
  },
  hasPacingGuide: false,
})
const revise = plannedTarget.find((suggestion) => suggestion.id === 'revise-planned-week')
assert.equal(revise.label, 'Revise Week 6')
const plannedNext = plannedTarget.find((suggestion) => suggestion.id === 'prepare-next-week')
assert.ok(!plannedNext.prompt.includes('pacing guide'))

const primary = currentWeek[0]
assert.equal(suggestionCompletion('Help me', primary), primary.prompt.slice('Help me'.length))
assert.equal(suggestionCompletion('unrelated', primary), '')
assert.equal(suggestionCompletion('', primary), primary.prompt)

console.log('contextual suggestion tests passed')
