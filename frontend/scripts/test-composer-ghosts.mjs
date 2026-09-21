import assert from 'node:assert/strict'
import { suggestionCompletion } from '../src/lib/contextualSuggestions.js'
import { composerGhostCandidates, pickComposerGhost } from '../src/lib/composerGhosts.js'

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
