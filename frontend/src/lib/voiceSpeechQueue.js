/* Keep one response in flight, including cancellation acknowledgement.
 * WebRTC playback drains after response.done; the provider waits for both
 * before advancing so captions and barge-in follow audible speech. */
export function createSpeechQueue({ send, isOpen, waitForPlayback = false }) {
  const items = []
  let current = null
  let sequence = 0

  const pump = () => {
    if (current || !isOpen()) return
    const item = items.shift()
    if (!item) return
    current = item
    if (!send({
      type: 'response.create',
      response: {
        conversation: 'none',
        input: [],
        metadata: { speech_id: item.speechId },
        output_modalities: ['audio'],
        instructions:
          'Read the following text aloud, verbatim, in a natural speaking voice. ' +
          'Do not summarise it, react to it, add to it, or omit any of it.\n\n' + item.text,
      },
    })) {
      current = null
      items.unshift(item)
    }
  }
  const matches = (id) => Boolean(current && (!id || (current.responseId && id === current.responseId)))
  const release = () => { current = null; pump() }

  return {
    enqueue(text, options = {}) {
      const line = typeof text === 'string' ? text.trim() : ''
      if (!line) return
      items.push({ ...options, text: line, speechId: `speech-${++sequence}` })
      pump()
    },
    responseCreated(id, speechId) {
      if (!current || (speechId && current.speechId !== speechId)) return false
      if (current.responseId && id !== current.responseId) return false
      if (id) current.responseId = id
      if (current.cancelled && id) {
        // Out-of-band responses require their ID to cancel. A teacher can
        // interrupt before response.created supplies that ID.
        send({ type: 'response.cancel', response_id: id })
        send({ type: 'output_audio_buffer.clear' })
      }
      return !current.cancelled
    },
    accepts(id) { return matches(id) && !current.cancelled },
    responseDone(id, { status = 'completed', hasAudio = true } = {}) {
      if (!matches(id)) return false
      current.generated = true
      if (current.cancelled || status !== 'completed' || !hasAudio || !waitForPlayback || current.playbackDone) release()
      return true
    },
    playbackDone(id) {
      if (!matches(id)) return false
      current.playbackDone = true
      if (current.generated) release()
      return true
    },
    cancel() {
      items.length = 0
      if (!current || current.cancelled) return
      const active = current
      active.cancelled = true
      if (!active.generated && active.responseId) {
        send({ type: 'response.cancel', response_id: active.responseId })
      }
      send({ type: 'output_audio_buffer.clear' })
      // Until response.done, a new create risks racing the old response.
      if (current === active && active.generated) release()
    },
    clear() { current = null; items.length = 0 },
    current() { return current?.cancelled ? null : current },
    pending() { return items.length },
    pump,
  }
}
