import assert from 'node:assert/strict'
import test from 'node:test'
import { droppedConnectionCopy, isDroppedConnectionError } from '../src/lib/streamTransport.js'

test('Safari Load failed is a dropped connection', () => {
  assert.equal(isDroppedConnectionError(Object.assign(new Error('Load failed'), { name: 'TypeError' })), true)
  assert.equal(droppedConnectionCopy(true).message.includes('writing the days'), true)
})

test('AbortError is not treated as a dropped connection', () => {
  assert.equal(isDroppedConnectionError(Object.assign(new Error('aborted'), { name: 'AbortError' })), false)
  assert.equal(isDroppedConnectionError(new Error('Validation failed.')), false)
})
