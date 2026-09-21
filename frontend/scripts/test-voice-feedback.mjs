import assert from 'node:assert/strict'
import test from 'node:test'
import { createVoiceAudioMeter } from '../src/lib/voiceAudioMeter.js'
import { describePlanChanges, samePlan, undoVersion } from '../src/lib/voicePlanChanges.js'

function harness() {
  const sources = [], analysers = []
  const context = { state: 'running', closed: 0, resume: async () => {}, close: async () => { context.closed++ },
    createMediaStreamSource() { const node = { connected: null, disconnected: false, connect(target) { this.connected = target }, disconnect() { this.disconnected = true } }; sources.push(node); return node },
    createAnalyser() { const node = { fftSize: 0, amplitude: 0, disconnected: false, disconnect() { this.disconnected = true }, getFloatTimeDomainData(buffer) { buffer.fill(this.amplitude) } }; analysers.push(node); return node },
  }
  return { context, sources, analysers, meter: createVoiceAudioMeter({ createContext: () => context }) }
}
test('meter separates microphone and playback, ignores noise and clamps loud sound', () => {
  const h = harness()
  h.meter.attach('input', {}); h.meter.attach('output', {})
  h.analysers[0].amplitude = .003; h.analysers[1].amplitude = .06
  assert.equal(h.meter.sample('input'), 0)
  assert.ok(h.meter.sample('output') > .4)
  h.analysers[0].amplitude = 1
  assert.equal(h.meter.sample('input'), 1)
  // Only analyser connections: the microphone must never echo to playback.
  assert.equal(h.sources[0].connected, h.analysers[0])
  assert.equal(h.sources[1].connected, h.analysers[1])
  h.meter.close()
})
test('replacement and close release nodes; late streams cannot reopen analysis', () => {
  const h = harness()
  h.meter.attach('input', {}); h.meter.attach('input', {})
  assert.equal(h.sources[0].disconnected, true)
  h.meter.close(); h.meter.close(); h.meter.attach('input', {})
  assert.equal(h.sources.length, 2)
  assert.ok(h.sources.every(source => source.disconnected))
  assert.ok(h.analysers.every(analyser => analyser.disconnected))
  assert.equal(h.context.closed, 1)
  assert.equal(h.meter.sample('input'), 0)
})
test('unsupported or suspended analysis stays silent without breaking voice', () => {
  const meter = createVoiceAudioMeter({ createContext() { throw new Error('Unavailable') } })
  meter.attach('input', {}); meter.resume(); assert.equal(meter.sample('input'), 0); meter.close()
  const h = harness(); h.meter.attach('output', {}); h.analysers[0].amplitude = .5; h.context.state = 'suspended'
  assert.equal(h.meter.sample('output'), 0); h.meter.close()
})
test('an analysis failure releases partial nodes without breaking media cleanup', () => {
  const h = harness()
  h.context.createAnalyser = () => { throw new Error('Analysis unavailable') }
  h.meter.attach('input', {})
  assert.equal(h.sources[0].disconnected, true)
  h.sources[0].disconnect = () => { throw new Error('Already detached') }
  assert.doesNotThrow(() => h.meter.close())
  assert.equal(h.context.closed, 1)
})
const before = { course: 'AP Lang', days: [{ name: 'Monday', during: 'Read.' }, { name: 'Wednesday', during: 'Jigsaw.', assessment: 'Exit ticket.' }] }
const after = { ...before, days: [before.days[0], { ...before.days[1], during: 'Model first, then jigsaw.' }] }
test('feedback highlights only the changed field and identifies the day', () => {
  assert.deepEqual(describePlanChanges(before, after), { keys: ['1:during'], label: 'Wednesday updated' })
})
test('undo tolerates database key ordering but rejects newer edits and missing history', () => {
  const reordered = { days: after.days, course: 'AP Lang' }
  assert.equal(samePlan(after, reordered), true)
  const versions = [{ revision: 2, plan_json: reordered }, { revision: 1, plan_json: before }]
  assert.deepEqual(undoVersion(versions, before, after), { revision: 1, expectedRevision: 2 })
  const newer = { ...after, course: 'Another course' }
  assert.throws(() => undoVersion([{ revision: 3, plan_json: newer }, ...versions], before, after), /changed again/)
  assert.throws(() => undoVersion([versions[0]], before, after), /changed again/)
})
