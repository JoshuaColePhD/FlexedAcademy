import assert from 'node:assert/strict'
import test from 'node:test'
import { createSpeechQueue } from '../src/lib/voiceSpeechQueue.js'
import { createPreviewVoiceTransport } from '../src/lib/voicePreviewTransport.js'
import './test-voice-transport.mjs'
import './test-voice-provider.mjs'
import './test-voice-consultation.mjs'

function setup(options = {}) {
  const sent = []
  const queue = createSpeechQueue({ isOpen: () => true, send: (event) => { sent.push(event); return true }, ...options })
  return { queue, sent }
}
test('speech is serialized and contains only the requested read-aloud text', () => {
  const { queue, sent } = setup()
  queue.enqueue('First sentence.')
  queue.enqueue('Second sentence.')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].response.conversation, 'none')
  assert.deepEqual(sent[0].response.input, [])
  assert.match(sent[0].response.instructions, /First sentence\.$/)
  queue.responseCreated('r1')
  assert.equal(queue.responseDone('wrong'), false)
  queue.responseDone('r1')
  assert.equal(sent.length, 2)
})
test('barge-in clears audio and waits for cancellation acknowledgement before new speech', () => {
  const { queue, sent } = setup()
  queue.enqueue('Old reply')
  queue.responseCreated('old')
  queue.cancel()
  assert.deepEqual(sent.slice(-2), [{ type: 'response.cancel', response_id: 'old' }, { type: 'output_audio_buffer.clear' }])
  assert.equal(queue.current(), null)
  queue.enqueue('New reply')
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 1)
  queue.responseDone('old', { status: 'cancelled' })
  assert.equal(sent.filter((e) => e.type === 'response.create').length, 2)
  assert.equal(queue.accepts('old'), false)
  assert.equal(queue.playbackDone('old'), false)
  queue.responseCreated('new')
  assert.equal(queue.responseDone('old'), false)
  assert.equal(queue.current().responseId, 'new')
})
test('WebRTC speech waits for audio buffer drain, not only response.done', () => {
  const { queue, sent } = setup({ waitForPlayback: true })
  queue.enqueue('Long reply')
  queue.enqueue('Next reply')
  queue.responseCreated('r1')
  queue.responseDone('r1')
  assert.equal(sent.length, 1)
  queue.playbackDone('r1')
  assert.equal(sent.length, 2)
})
test('failed responses and send races leave the queue recoverable', () => {
  let open = false
  const sent = []
  const queue = createSpeechQueue({ isOpen: () => true, send: (e) => { if (!open) return false; sent.push(e); return true }, waitForPlayback: true })
  queue.enqueue('Retry sending')
  assert.equal(queue.pending(), 1)
  open = true
  queue.pump()
  queue.responseCreated('r1')
  queue.responseDone('r1', { status: 'failed' })
  assert.equal(queue.current(), null)
  assert.equal(sent.length, 1)
})
test('preview uses ordinary transcript events and cancels scheduled playback on close', async () => {
  const events = []
  const transport = createPreviewVoiceTransport({ onEvent: (event) => events.push(event) })
  assert.equal(transport.simulateUtterance('  Make Tuesday practical.  '), true)
  assert.deepEqual(events.map((e) => e.type), ['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'conversation.item.input_audio_transcription.completed'])
  assert.equal(events.at(-1).transcript, 'Make Tuesday practical.')
  transport.send({ type: 'response.create', response: { instructions: 'Read.\n\nTuesday updated.', metadata: { speech_id: 'one' } } })
  transport.close()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(events.length, 3)
  assert.equal(transport.simulateUtterance('Another'), false)
})
test('barge-in before response.created waits for the out-of-band response ID to cancel', () => {
  const { queue, sent } = setup()
  queue.enqueue('Still connecting the spoken reply')
  queue.cancel()
  queue.enqueue('Replacement')
  assert.equal(sent.some((event) => event.type === 'response.cancel'), false)
  queue.responseCreated('late-created')
  assert.deepEqual(sent.slice(-2), [{ type: 'response.cancel', response_id: 'late-created' }, { type: 'output_audio_buffer.clear' }])
  assert.equal(queue.current(), null)
  queue.responseDone('late-created', { status: 'cancelled' })
  assert.equal(sent.filter((event) => event.type === 'response.create').length, 2)
})
