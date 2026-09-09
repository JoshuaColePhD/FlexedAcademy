import assert from 'node:assert/strict'
import { chatThinkingLabel, isCasualTurn } from '../src/lib/chatThinking.js'

assert.equal(isCasualTurn('Hello'), true)
assert.equal(isCasualTurn('hello!'), true)
assert.equal(isCasualTurn('Help me plan quadratics'), false)

const hello = chatThinkingLabel('brainstorm', { prompt: 'Hello' })
assert.ok(['Hey — one sec', 'Right with you', 'Give me a beat'].includes(hello))
assert.equal(chatThinkingLabel('brainstorm', { prompt: 'Hello' }), hello)
assert.notEqual(hello, 'Thinking')
assert.notEqual(hello, 'Crafting your lesson')

const plan = chatThinkingLabel('brainstorm', { planning: true, prompt: 'Build the week' })
assert.match(plan, /week|days/)

const research = chatThinkingLabel('research', { prompt: 'Find articles' })
assert.match(research, /source|have/)

const ordinary = chatThinkingLabel('brainstorm', { prompt: 'Can Thursday be lighter?' })
assert.ok(['Let me sit with that', 'Hmm, okay', 'One sec', 'Thinking it through'].includes(ordinary))

console.log('chat thinking tests passed')
