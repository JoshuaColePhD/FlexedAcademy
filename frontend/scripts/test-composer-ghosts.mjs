import assert from 'node:assert/strict'
import { suggestionCompletion } from '../src/lib/contextualSuggestions.js'
import {
  composerGhostCandidates,
  pickComposerGhost,
} from '../src/lib/composerGhosts.js'

const ids = (candidates) => candidates.map((item) => item.id)
const prompts = (candidates) => candidates.map((item) => item.prompt)

const week = { week: 6 }
const pacing = [{ kind: 'pacing_guide' }]
const syllabus = [{ kind: 'syllabus' }]
const materials = [
  { kind: 'pacing_guide' },
  { kind: 'syllabus' },
  { kind: 'curriculum_map' },
]
const attachment = [{ filename: 'ethos-workshop.pdf' }]

// Bare composer: ChatPage still calls pickComposerGhost with an empty
// ghostContext while week/documents are loading. Missing week numbers
// fall back to "this week"; the write-week prompt stays last.
const bare = composerGhostCandidates()
assert.deepEqual(ids(bare), ['plan:this week', 'write-week'])
assert.deepEqual(prompts(bare), ['Plan this week.', 'Write a lesson for this week.'])
assert.equal(pickComposerGhost('').prompt, 'Plan this week.')
assert.equal(pickComposerGhost('   ').prompt, 'Plan this week.')
assert.equal(pickComposerGhost('Write a').prompt, 'Write a lesson for this week.')
assert.equal(pickComposerGhost('unrelated'), null)
assert.equal(pickComposerGhost('Help me plan tomorrow'), null)
assert.equal(pickComposerGhost('I want to revise'), null)

// Week label uses the same padded "Week 06" form ChatPage's header uses, and
// accepts the calendar aliases displayWeek might carry.
assert.equal(
  composerGhostCandidates({ week }).find((item) => item.id.startsWith('plan:')).prompt,
  'Plan Week 06.'
)
assert.equal(
  composerGhostCandidates({ week: { week_number: 3 } }).find((item) => item.id.startsWith('plan:')).prompt,
  'Plan Week 03.'
)
assert.equal(
  composerGhostCandidates({ week: { number: 12 } }).find((item) => item.id.startsWith('plan:')).prompt,
  'Plan Week 12.'
)
assert.equal(
  composerGhostCandidates({ week: {} }).find((item) => item.id.startsWith('plan:')).prompt,
  'Plan this week.'
)

// hasPlan is ChatPage's Boolean(artifact?.planId): revise vs plan, same week.
assert.equal(
  composerGhostCandidates({ week, hasPlan: true }).find((item) => item.id.startsWith('revise:')).prompt,
  'Revise the lesson plan for Week 06.'
)
assert.ok(!composerGhostCandidates({ week, hasPlan: true }).some((item) => item.id.startsWith('plan:')))
assert.ok(!composerGhostCandidates({ week, hasPlan: false }).some((item) => item.id.startsWith('revise:')))

// Document kinds become the labels a teacher already sees in settings.
assert.equal(
  composerGhostCandidates({ week, documents: pacing }).find((item) => item.id.startsWith('materials:')).prompt,
  'Plan Week 06 using the pacing guide.'
)
assert.equal(
  composerGhostCandidates({ week, documents: syllabus, hasPlan: true }).find((item) => item.id.startsWith('materials:')).prompt,
  'Revise Week 06 using the syllabus.'
)
assert.equal(
  composerGhostCandidates({
    week,
    documents: [{ kind: 'pacing_guide' }, { kind: 'syllabus' }],
  }).find((item) => item.id.startsWith('materials:')).prompt,
  'Plan Week 06 using the pacing guide and syllabus.'
)
assert.equal(
  composerGhostCandidates({ week, documents: materials }).find((item) => item.id.startsWith('materials:')).prompt,
  'Plan Week 06 using the pacing guide, syllabus, and curriculum map.'
)
assert.ok(!composerGhostCandidates({ week, documents: [{ kind: 'handout' }] }).some((item) => item.id.startsWith('materials:')))
assert.equal(
  composerGhostCandidates({
    week,
    documents: [{ kind: 'syllabus' }, { kind: 'syllabus' }, { kind: 'unknown' }],
  }).find((item) => item.id.startsWith('materials:')).prompt,
  'Plan Week 06 using the syllabus.'
)

// Ranking matches Composer.jsx: pickComposerGhost returns candidates[0] when
// the field is empty, then the first prefix match while typing. A freshly
// attached file outranks materials and the week fallback; the async model
// suggestion is priority 0 so it is first once ChatPage has it.
const ranked = composerGhostCandidates({
  week,
  documents: pacing,
  attachments: attachment,
  hasPlan: true,
  modelSuggestion: 'Plan Week 06 around ethos and audience.',
})
assert.deepEqual(ids(ranked), [
  'grounded-context',
  'attachment:ethos-workshop.pdf',
  'materials:pacing guide',
  'revise:Week 06',
  'write-week',
])
assert.deepEqual(ranked.map((item) => item.priority), [0, 1, 2, 3, 4])
assert.equal(pickComposerGhost('', { week, documents: pacing, attachments: attachment, hasPlan: true, modelSuggestion: ranked[0].prompt }).id, 'grounded-context')
assert.equal(
  pickComposerGhost('', { week, documents: pacing, attachments: attachment, hasPlan: true }).id,
  'attachment:ethos-workshop.pdf'
)
assert.equal(pickComposerGhost('', { week, documents: pacing }).id, 'materials:pacing guide')
assert.equal(pickComposerGhost('', { week, hasPlan: true }).id, 'revise:Week 06')
assert.equal(
  pickComposerGhost('', { week, attachments: [{}, { filename: 'unit-2.txt' }] }).prompt,
  'Use unit-2.txt to plan Week 06.'
)

const context = { week, documents: pacing, attachments: attachment, hasPlan: true, modelSuggestion: ranked[0].prompt }
assert.equal(pickComposerGhost('Use ethos', context).prompt, 'Use ethos-workshop.pdf to plan Week 06.')
assert.equal(pickComposerGhost('revise week 06 using', context).prompt, 'Revise Week 06 using the pacing guide.')
assert.equal(pickComposerGhost('revise the lesson', context).prompt, 'Revise the lesson plan for Week 06.')
assert.equal(pickComposerGhost('write a', context).prompt, 'Write a lesson for this week.')
assert.equal(pickComposerGhost('Help me plan tomorrow', context), null)

const write = ranked.find((item) => item.id === 'write-week')
const revise = ranked.find((item) => item.id.startsWith('revise:'))
assert.equal(suggestionCompletion('', write), write.prompt)
assert.equal(suggestionCompletion('Write a', write), write.prompt.slice('Write a'.length))
assert.equal(suggestionCompletion('Revise', write), '')
assert.equal(suggestionCompletion('Revise', revise), revise.prompt.slice('Revise'.length))

// Retired canned wording must not come back through the grounded API.
assert.ok(!prompts(ranked).includes("Revise this week's plan"))
assert.ok(!prompts(ranked).includes('Write a lesson for this week'))
assert.ok(!prompts(composerGhostCandidates()).includes('Write a lesson for this week'))
assert.ok(!prompts(ranked).some((prompt) => /quiz/i.test(prompt)))
assert.ok(!prompts(ranked).includes("I want to revise this week's plan."))
assert.ok(!prompts(ranked).includes("Help me plan tomorrow's lesson."))



{

const context = { week: { week: 4 }, documents: [{ kind: 'pacing_guide' }], hasPlan: false }
assert.equal(pickComposerGhost('', context).prompt, 'Plan Week 04 using the pacing guide.')
assert.equal(pickComposerGhost('plan week', context).prompt, 'Plan Week 04 using the pacing guide.')
assert.equal(pickComposerGhost('unrelated', context), null)
assert.equal(pickComposerGhost('', { week: { week: 4 }, hasPlan: true }).prompt, 'Revise the lesson plan for Week 04.')
assert.equal(pickComposerGhost('', { ...context, attachments: [{ filename: 'Speeches.pdf' }] }).prompt, 'Use Speeches.pdf to plan Week 04.')
assert.equal(pickComposerGhost('', { ...context, modelSuggestion: 'Plan the argument unit.' }).prompt, 'Plan the argument unit.')
assert.equal(pickComposerGhost('').prompt, 'Plan this week.')
assert.ok(!composerGhostCandidates().some((item) => /quiz|week 04|speeches/i.test(item.prompt)), 'unrelated context must not appear in a fresh composer')
const suggestion = pickComposerGhost('', context)
assert.equal(suggestionCompletion('Plan Week', suggestion), suggestion.prompt.slice('Plan Week'.length))
assert.equal(suggestionCompletion('Revise', suggestion), '')

const editing = {
  ...context,
  hasPlan: true,
  planOpen: true,
  days: [{ name: 'Monday' }, { name: 'Wednesday' }, { name: 'Friday', no_school: true }],
  modelSuggestion: 'Plan the argument unit.',
}
assert.equal(pickComposerGhost('', editing).prompt, "Add support for Wednesday's lesson.", 'an open lesson overrides a stale planning suggestion')
assert.equal(pickComposerGhost('add a quick', editing).prompt, 'Add a quick check for understanding.')
assert.equal(pickComposerGhost('', { ...editing, attachments: [{ filename: 'Speeches.pdf' }] }).prompt, 'Use Speeches.pdf to revise Week 04.')
assert.equal(pickComposerGhost('', { ...editing, days: [{ name: 'Monday' }, { name: 'Wednesday', no_school: true }] }).prompt, "Add support for Monday's lesson.", 'suggest only a known teaching day')
assert.equal(pickComposerGhost('', { ...editing, days: [{ name: 'Wednesday', pending: true }] }).prompt, 'Add support to this lesson.', 'do not invent a day while the plan is incomplete')
assert.ok(composerGhostCandidates(editing).every(({ prompt }) => !/^(plan|write a lesson)/i.test(prompt)), 'editing suggestions must not propose another plan')
assert.equal(pickComposerGhost('', { week: { week: 4 }, hasArtifact: true }).prompt, 'Revise the lesson plan for Week 04.')
console.log('contextual composer ghost tests passed')
}
