import assert from 'node:assert/strict'
import { createSpeechQueue } from '../src/lib/voiceSpeechQueue.js'

const sent = []
const queue = createSpeechQueue({
  isOpen: () => true,
  send: (event) => {
    sent.push(event)
    return true
  },
})

queue.enqueue('First sentence.')
queue.enqueue('Second sentence.')
queue.enqueue('Third sentence.')
assert.equal(sent.length, 1)
assert.match(sent[0].response.instructions, /First sentence\.$/)

queue.responseCreated('r1')
assert.equal(queue.responseDone('wrong-id'), false)
assert.equal(sent.length, 1)
assert.equal(queue.responseDone('r1'), true)
assert.equal(sent.length, 2)
assert.match(sent[1].response.instructions, /Second sentence\.$/)

queue.responseCreated('r2')
queue.responseDone('r2')
assert.equal(sent.length, 3)
assert.match(sent[2].response.instructions, /Third sentence\.$/)

queue.responseCreated('r3')
queue.cancel()
assert.deepEqual(sent.at(-1), { type: 'response.cancel' })
assert.equal(queue.pending(), 0)
assert.equal(queue.current(), null)

console.log('PASSED — speech queue serializes sentences and cancels without replay.')
