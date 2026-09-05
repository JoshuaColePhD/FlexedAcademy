import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorkActivity, updateWorkActivity } from '../src/lib/workActivity.js'

test('action activity follows the ordered lifecycle and keeps day progress', () => {
  let activity = createWorkActivity({ requestId: 'request-1', anchorId: 'message-1', kind: 'plan' })
  assert.equal(activity.status, 'active')
  assert.equal(activity.steps[0].state, 'active')
  assert.equal(activity.steps[1].state, 'pending')

  activity = updateWorkActivity(activity, {
    requestId: 'request-1',
    code: 'retrieving',
    step: 'retrieval',
    step_state: 'active',
    label: 'Retrieving grounded standards',
    previewDays: [{ name: 'Monday' }, { name: 'Tuesday' }],
  })
  assert.equal(activity.steps[0].state, 'complete')
  assert.equal(activity.steps[1].state, 'active')
  assert.equal(activity.previewDays.length, 2)

  activity = updateWorkActivity(activity, { code: 'writing', step: 'building', label: 'Building lesson plan' })
  assert.equal(activity.activeStep, 'building')
  assert.equal(activity.steps[1].state, 'complete')
  assert.equal(activity.steps[3].state, 'active')

  activity = updateWorkActivity(activity, { status: 'complete', done: true, label: 'Plan saved' })
  assert.equal(activity.status, 'complete')
  assert.ok(activity.steps.every((step) => step.state === 'complete'))
})

test('failed and cancelled activities remain addressable', () => {
  const activity = createWorkActivity({ requestId: 'request-2', anchorId: 'message-2', kind: 'revision' })
  const failed = updateWorkActivity(activity, { status: 'error', error: 'Validation failed.' })
  assert.equal(failed.status, 'error')
  assert.equal(failed.error, 'Validation failed.')

  const cancelled = updateWorkActivity(activity, { status: 'cancelled', label: 'Stopped by teacher' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.requestId, 'request-2')
})
