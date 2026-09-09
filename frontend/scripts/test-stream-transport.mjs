import assert from 'node:assert/strict'
import test from 'node:test'
import { chatFailureCopy, droppedConnectionCopy, isDroppedConnectionError } from '../src/lib/streamTransport.js'

test('Safari Load failed is a dropped connection', () => {
  assert.equal(isDroppedConnectionError(Object.assign(new Error('Load failed'), { name: 'TypeError' })), true)
  assert.equal(droppedConnectionCopy(true).message.includes('writing the days'), true)
})

test('AbortError is not treated as a dropped connection', () => {
  assert.equal(isDroppedConnectionError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false)
  assert.equal(isDroppedConnectionError(new Error('Validation failed.')), false)
})

test('chat failures keep a usable next step instead of a blank reply', () => {
  assert.equal(chatFailureCopy({ code: 'empty_reply' }).hint.includes('Send it again'), true)
  assert.equal(chatFailureCopy({ code: 'invalid_quiz_target', message: 'Open the intended quiz and try again.' }).message.includes('quiz'), true)
  assert.equal(chatFailureCopy({ message: 'Could not build the quiz' }).message, 'Could not build the quiz')
})
