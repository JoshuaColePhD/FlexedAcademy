import assert from 'node:assert/strict'
import test from 'node:test'
import { openWebRTCTransport } from '../src/lib/voiceWebRTCTransport.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const tick = () => new Promise((resolve) => setImmediate(resolve))
function setup(overrides = {}) {
  const abort = new AbortController()
  const track = { enabled: true, stopped: false, stop() { this.stopped = true }, getSettings: () => ({ deviceId: 'default' }) }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  const channel = { readyState: 'connecting', sent: [], send(value) { this.sent.push(JSON.parse(value)) }, close() { this.readyState = 'closed' } }
  const pc = { closed: false, addTrack() {}, createDataChannel: () => channel, createOffer: async () => ({ sdp: 'local' }), setLocalDescription: async () => {}, setRemoteDescription: async () => { channel.readyState = 'open'; channel.onopen?.() }, close() { this.closed = true } }
  const options = { signal: abort.signal, provision: async () => ({ token: 'test-ephemeral' }), onEvent() {}, onTrack() {}, onLost() {}, mediaDevices: { getUserMedia: async () => stream }, createPeer: () => pc, request: async () => ({ ok: true, text: async () => 'remote' }), ...overrides }
  return { abort, track, stream, channel, pc, options }
}
test('late microphone grant after provisioning failure is stopped', async () => {
  const pending = deferred()
  const t = setup({ provision: async () => { throw new Error('No entitlement') }, mediaDevices: { getUserMedia: () => pending.promise } })
  await assert.rejects(openWebRTCTransport(t.options), /No entitlement/)
  pending.resolve(t.stream)
  await tick()
  assert.equal(t.track.stopped, true)
})
test('an early microphone stream is released when provisioning later fails', async () => {
  const token = deferred()
  const t = setup({ provision: () => token.promise })
  const opening = openWebRTCTransport(t.options)
  await tick()
  token.reject(new Error('Provision failed'))
  await assert.rejects(opening, /Provision failed/)
  assert.equal(t.track.stopped, true)
})
test('abort releases microphone and peer while SDP request is stalled', async () => {
  const request = deferred()
  let signal
  const t = setup({ request: (_url, init) => { signal = init.signal; return request.promise } })
  const opening = openWebRTCTransport(t.options)
  await tick()
  t.abort.abort()
  await assert.rejects(opening, { name: 'AbortError' })
  assert.equal(signal.aborted, true)
  assert.equal(t.track.stopped, true)
  assert.equal(t.pc.closed, true)
  request.resolve({ ok: true, text: async () => 'too late' })
  await tick()
  assert.equal(t.channel.readyState, 'closed')
})
test('connection is not ready until the data channel opens; mute and close own the track', async () => {
  const t = setup({ isMuted: () => true })
  let ready = false
  t.pc.setRemoteDescription = async () => {}
  const opening = openWebRTCTransport(t.options).then((transport) => { ready = true; return transport })
  await tick()
  assert.equal(ready, false)
  assert.equal(t.track.enabled, false)
  t.channel.readyState = 'open'
  t.channel.onopen()
  const transport = await opening
  transport.setMuted(false)
  assert.equal(t.track.enabled, true)
  assert.equal(transport.send({ type: 'test' }), true)
  transport.close()
  assert.equal(t.track.stopped, true)
  assert.equal(transport.send({ type: 'late' }), false)
})
test('remembered missing microphone falls back to the default once', async () => {
  const t = setup({ preferredDeviceId: 'removed-device' })
  const calls = []
  t.options.mediaDevices.getUserMedia = async (constraints) => {
    calls.push(constraints)
    if (calls.length === 1) throw Object.assign(new Error('Missing'), { name: 'OverconstrainedError' })
    return t.stream
  }
  const transport = await openWebRTCTransport(t.options)
  assert.equal(calls[0].audio.deviceId.exact, 'removed-device')
  assert.equal(calls[1].audio.deviceId, undefined)
  transport.close()
})
