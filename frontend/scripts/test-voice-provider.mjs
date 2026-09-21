import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { transform } from 'esbuild'
import { createSpeechQueue } from '../src/lib/voiceSpeechQueue.js'
import { createPreviewVoiceTransport } from '../src/lib/voicePreviewTransport.js'
import { createVoiceAudioMeter } from '../src/lib/voiceAudioMeter.js'

const source = await readFile(new URL('../src/components/VoiceProvider.jsx', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' })
function harness(factory = createPreviewVoiceTransport) {
  let cursor = 0
  const slots = [], effects = []
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]))
  const memo = (make, deps) => { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: make(), deps }; return slots[i].value }
  const react = {
    useContext: () => factory,
    useRef: (value) => { const i = cursor++; return slots[i] ||= { current: value } },
    useState: (initial) => { const i = cursor++; slots[i] ||= { value: initial }; return [slots[i].value, (value) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value }] },
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect: (effect, deps) => {
      const i = cursor++
      if (!slots[i] || changed(slots[i].deps, deps)) effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() } })
    },
  }
  const listeners = new Map()
  const document = { hidden: false, createElement: () => ({ pause() {}, play: async () => {}, srcObject: null }), addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type) }
  const calls = { provision: 0, rtc: 0, usage: 0 }
  const toast = { info() {}, error() {} }
  const modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    '../lib/voiceContext': { VoiceContext: { Provider: 'voice-provider' }, VoiceTransportContext: {} },
    '../lib/api': { api: { createVoiceSession: () => { calls.provision++; throw new Error('Preview must not provision') }, reportVoiceUsage: async () => { calls.usage++ } } },
    '../lib/toastContext': { useToast: () => toast },
    '../lib/voiceSpeechQueue': { createSpeechQueue },
    '../lib/voiceAudioMeter': { createVoiceAudioMeter },
    '../lib/voiceWebRTCTransport': { openWebRTCTransport: () => { calls.rtc++; throw new Error('Preview must not request WebRTC') } },
    '../lib/voiceMetrics': Object.fromEntries(['turnAbandoned', 'turnStarted', 'transcriptReady', 'firstAudio', 'sentenceQueued'].map((key) => [key, () => {}])),
  }
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require: (id) => modules[id], document, window: { localStorage: { getItem() {}, setItem() {} } }, AbortController, performance, console, setTimeout, clearTimeout })
  const render = () => { cursor = 0; const view = module.exports.VoiceProvider({}); while (effects.length) effects.shift()(); return view.props.value }
  let voice = render()
  return { document, calls, render, voice, hide(value) { document.hidden = value; listeners.get('visibilitychange')?.() }, cleanup() { voice.stopSession(); for (const slot of slots) slot?.cleanup?.() } }
}

test('provider preview requires explicit Start, uses no media/provider, and delivers once', async () => {
  const h = harness()
  try {
    assert.equal(h.voice.status, 'idle')
    assert.equal(h.voice.simulateUtterance('Before start'), false)
    const spoken = [], starts = []
    h.voice.onUtterance((text) => spoken.push(text))
    h.voice.onSpeechStart(() => starts.push(true))
    await h.voice.startSession({ classId: 'c1' })
    const voice = h.render()
    assert.equal(voice.status, 'live')
    assert.equal(voice.preview, true)
    assert.equal(voice.simulateUtterance('Change Wednesday.'), true)
    assert.deepEqual(spoken, ['Change Wednesday.'])
    assert.equal(starts.length, 1)
    voice.stopSession()
    assert.equal(h.render().simulateUtterance('After stop'), false)
    assert.deepEqual(h.calls, { provision: 0, rtc: 0, usage: 0 })
  } finally { h.cleanup() }
})
test('background auto-mute cannot be bypassed by explicit unmute and preserves manual mute', async () => {
  const h = harness()
  try {
    await h.voice.startSession()
    h.hide(true)
    h.voice.setMuted(false)
    assert.equal(h.render().muted, true)
    assert.equal(h.voice.simulateUtterance('Hidden'), false)
    h.voice.setMuted(true)
    h.hide(false)
    assert.equal(h.render().muted, true)
    h.voice.setMuted(false)
    assert.equal(h.voice.simulateUtterance('Visible'), true)
  } finally { h.cleanup() }
})
test('duplicate transcript events are ignored and stale session callbacks cannot submit', async () => {
  let events
  const factory = ({ onEvent }) => { events = onEvent; return { isOpen: () => true, send: () => true, close() {} } }
  factory.preview = true
  const h = harness(factory)
  try {
    const received = []
    h.voice.onUtterance((text) => received.push(text))
    await h.voice.startSession()
    const old = events
    const event = { type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'One request' }
    events(event); events(event)
    h.voice.stopSession()
    await h.voice.startSession()
    old({ ...event, item_id: 'late', transcript: 'Old session' })
    assert.deepEqual(received, ['One request'])
  } finally { h.cleanup() }
})
test('empty transcription and a short PTT tap settle the input without submitting text', async () => {
  let events
  const sent = []
  const factory = ({ onEvent }) => { events = onEvent; return { isOpen: () => true, send: (event) => { sent.push(event); return true }, close() {} } }
  factory.preview = true
  const h = harness(factory)
  try {
    const received = [], settled = [], started = []
    h.voice.onUtterance((text) => received.push(text))
    h.voice.onSpeechStart(() => started.push(true))
    h.voice.onInputSettled((event) => settled.push(event))
    await h.voice.startSession()
    events({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'noise', transcript: ' ' })
    assert.equal(settled[0].text, '')
    h.voice.setInputMode('ptt')
    assert.equal(sent.at(-1).session.audio.input.turn_detection, null)
    assert.equal(h.voice.beginTurn(), true)
    assert.equal(h.voice.commitTurn(), false)
    assert.equal(started.length, 1)
    assert.equal(settled.length, 2)
    assert.deepEqual(received, [])
    assert.equal(sent.some((event) => event.type === 'input_audio_buffer.commit'), false)
  } finally { h.cleanup() }
})
