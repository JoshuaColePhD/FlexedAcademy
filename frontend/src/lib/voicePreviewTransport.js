/* Deterministic localhost transport: no microphone, speech synthesis, fetch,
 * or provider. Transcripts still enter the ordinary grounded-chat handler. */
export function createPreviewVoiceTransport({ onEvent, schedule = setTimeout, unschedule = clearTimeout, now = () => performance.now() }) {
  let open = true
  let sequence = 0
  let response = null
  let inputUntil = 0
  const timers = new Set()
  const later = (callback, delay = 0) => {
    const timer = schedule(() => { timers.delete(timer); if (open) callback() }, delay)
    timers.add(timer)
  }
  const emit = (event) => { if (open) onEvent(event) }
  return {
    isOpen: () => open,
    send(event) {
      if (!open) return false
      if (event.type === 'response.create') {
        const active = { id: `preview-response-${++sequence}`, metadata: event.response.metadata, startedAt: null }
        response = active
        const transcript = event.response.instructions.split('\n\n').slice(1).join('\n\n')
        later(() => {
          emit({ type: 'response.created', response: active })
          if (active.cancelled) return
          active.startedAt = now()
          emit({ type: 'output_audio_buffer.started', response_id: active.id })
          emit({ type: 'response.output_audio_transcript.delta', response_id: active.id, delta: transcript })
          emit({ type: 'response.output_audio_transcript.done', response_id: active.id, transcript })
          emit({ type: 'response.done', response: { ...active, status: 'completed' } })
          later(() => {
            if (!active.cancelled) emit({ type: 'output_audio_buffer.stopped', response_id: active.id })
            if (response === active) response = null
          }, Math.min(4500, Math.max(1200, transcript.length * 22)))
        })
      } else if (event.type === 'response.cancel' && response) {
        const active = response
        active.cancelled = true
        later(() => emit({ type: 'response.done', response: { ...active, status: 'cancelled' } }))
      } else if (event.type === 'output_audio_buffer.clear' && response) {
        emit({ type: 'output_audio_buffer.cleared', response_id: response.id })
      }
      return true
    },
    simulateUtterance(text) {
      const transcript = typeof text === 'string' ? text.trim() : ''
      if (!open || !transcript) return false
      inputUntil = now() + 650
      emit({ type: 'input_audio_buffer.speech_started' })
      emit({ type: 'input_audio_buffer.speech_stopped' })
      emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: `preview-input-${++sequence}`, transcript })
      return true
    },
    sampleLevel(channel) {
      // Only this injected mock simulates audio; production uses an analyser.
      const time = now()
      const active = channel === 'input' ? time < inputUntil : response?.startedAt != null && !response.cancelled
      return open && active ? .15 + .6 * Math.abs(Math.sin(time / 95) * Math.cos(time / 170)) : 0
    },
    close() {
      open = false
      for (const timer of timers) unschedule(timer)
      timers.clear()
      response = null
    },
  }
}
createPreviewVoiceTransport.preview = true
