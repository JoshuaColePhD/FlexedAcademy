import assert from 'node:assert/strict'
import { suggestionCompletion } from '../src/lib/contextualSuggestions.js'
import {
  COMPOSER_GHOST_PROMPTS,
  COMPOSER_GHOST_SUGGESTIONS,
  pickComposerGhost,
} from '../src/lib/composerGhosts.js'

assert.deepEqual(COMPOSER_GHOST_PROMPTS, [
  'Write a lesson for this week',
  "Revise this week's plan",
])
assert.equal(COMPOSER_GHOST_SUGGESTIONS.length, 2)
assert.equal(COMPOSER_GHOST_SUGGESTIONS[0].prompt, 'Write a lesson for this week')
assert.equal(COMPOSER_GHOST_SUGGESTIONS[1].prompt, "Revise this week's plan")
assert.ok(COMPOSER_GHOST_PROMPTS.every((prompt) => !prompt.endsWith('.')))
assert.ok(!COMPOSER_GHOST_PROMPTS.some((prompt) => /week\s+\d+/i.test(prompt)))
assert.ok(!COMPOSER_GHOST_PROMPTS.includes("I want to revise this week's plan."))
assert.ok(!COMPOSER_GHOST_PROMPTS.includes("Help me plan tomorrow's lesson."))

assert.ok(!COMPOSER_GHOST_PROMPTS.some((prompt) => /quiz/i.test(prompt)))
assert.equal(pickComposerGhost('').prompt, 'Write a lesson for this week')
assert.equal(pickComposerGhost('   ').prompt, 'Write a lesson for this week')
assert.equal(pickComposerGhost('Write a').prompt, 'Write a lesson for this week')
assert.equal(pickComposerGhost('revise this').prompt, "Revise this week's plan")
assert.equal(pickComposerGhost('Help me plan tomorrow'), null)
assert.equal(pickComposerGhost('I want to revise'), null)
assert.equal(pickComposerGhost('unrelated'), null)

const write = COMPOSER_GHOST_SUGGESTIONS[0]
const revise = COMPOSER_GHOST_SUGGESTIONS[1]
assert.equal(suggestionCompletion('', write), write.prompt)
assert.equal(suggestionCompletion('Write a', write), write.prompt.slice('Write a'.length))
assert.equal(suggestionCompletion('Revise', write), '')
assert.equal(suggestionCompletion('Revise', revise), revise.prompt.slice('Revise'.length))

console.log('composer ghost tests passed')
