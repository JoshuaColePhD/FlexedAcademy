import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceContext } from '../lib/voiceContext'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'

const KEY = 'aplang.voice'

/* The realtime transport for voice mode: ears and mouth, not the brain.
 *
 * The division of labour matters and is easy to get wrong, so it is stated
 * here once. The realtime session hears the teacher (server-side VAD decides
 * where a turn ends, Whisper transcribes it) and speaks the reply out loud. It
 * does NOT compose the reply. The session is provisioned with
 * turn_detection.create_response = false (backend/routes/generate.py) precisely
 * so it won't: a realtime model answering from its own weights is fluent and
 * wrong about standard codes, and "every cited standard was quoted from a real
 * document" is the entire product. Answers come from /api/chat_stream, which
 * has retrieval. See `speak` below for the other half of that contract.
 *
 * What this replaced: VoiceModePanel used to own the whole audio pipeline —
 * getUserMedia, an AudioWorklet, a Silero VAD, a WAV encoder and a Whisper
 * round trip per utterance. Commit eb498c8 deleted those modules to move here
 * and left the panel's copy of the pipeline in place behind mocks, so both
 * halves ran, two microphones were opened, and neither worked.
 */
export function VoiceProvider({ children }) {
  const toast = useToast()
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })

  /* 'idle' | 'connecting' | 'live' | 'error' — the panel's status pill reads
     this instead of running its own microphone to find out. */
  const [status, setStatus] = useState('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [caption, setCaption] = useState('')
  // What the teacher was heard saying: partial while they talk, final on the
  // completed transcript. The panel's tap-to-correct affordance reads this.
  const [heard, setHeard] = useState('')
  const [muted, setMuted] = useState(false)

  const pcRef = useRef(null)
  const dcRef = useRef(null)
  const audioElRef = useRef(null)
  const localStreamRef = useRef(null)
  const activeSessionRef = useRef(false)
  // Bumped by stop(); unlock() compares against its own snapshot after every
  // await. Without this, closing voice mode mid-negotiation let the rest of
  // unlock() install a brand-new live microphone that stop() had already run
  // past — a hot mic and a live session with nothing left holding a reference
  // to either, unreachable until a page reload.
  const generationRef = useRef(0)
  const captionTimerRef = useRef(null)
  // Subscribers for a completed teacher utterance. A ref, not state: ChatPage
  // registers once and the handler identity changes on most renders.
  const utteranceHandlersRef = useRef(new Set())
  // Text queued because the data channel wasn't open yet. openVoice() sends
  // the greeting on the line after unlock() starts, which is several awaits
  // before a channel exists — that greeting used to be dropped in silence,
  // every time, so voice mode always opened saying nothing.
  const pendingSpeechRef = useRef([])

  useEffect(() => {
    const el = document.createElement('audio')
    el.autoplay = true
    audioElRef.current = el
    return () => {
      el.pause()
      el.srcObject = null
    }
  }, [])

  const clearCaptionTimer = useCallback(() => {
    if (captionTimerRef.current) {
      clearTimeout(captionTimerRef.current)
      captionTimerRef.current = null
    }
  }, [])

  const stop = useCallback(() => {
    generationRef.current += 1
    activeSessionRef.current = false
    setSpeaking(false)
    setStatus('idle')
    // Cleared here, which is what ChatPage's closeVoice() already assumed in a
    // comment ("voice.stop() clears the caption itself now") while nothing
    // actually did it. A caption left non-empty is not just stale text: the
    // panel derives "should I offer the tap-to-correct echo" from the caption
    // being empty, so one stop mid-utterance disabled that affordance for the
    // rest of the conversation.
    clearCaptionTimer()
    setCaption('')
    setHeard('')
    setMuted(false)
    pendingSpeechRef.current = []

    if (dcRef.current) {
      try {
        dcRef.current.close()
      } catch {
        /* already closing */
      }
      dcRef.current = null
    }
    if (pcRef.current) {
      try {
        pcRef.current.close()
      } catch {
        /* already closing */
      }
      pcRef.current = null
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop())
      localStreamRef.current = null
    }
    if (audioElRef.current) {
      audioElRef.current.srcObject = null
    }
  }, [clearCaptionTimer])

  const send = useCallback((event) => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return false
    dc.send(JSON.stringify(event))
    return true
  }, [])

  /* Read this text out loud, verbatim.
   *
   * The old implementation of this (named sendContextEvent) sent the text as a
   * `system` message and then an open-ended response.create — which asks the
   * realtime model to GENERATE a fresh spoken reply *about* the text rather
   * than to read it. Since ChatPage calls this once per streamed sentence, one
   * reply produced a stack of overlapping responses in which the assistant
   * talked about its own answer. `response.instructions` is the documented way
   * to direct a single response, and audio-only output because the words are
   * already on screen in the transcript.
   *
   * Queued rather than dropped when the channel isn't open yet — see
   * pendingSpeechRef. */
  const speak = useCallback(
    (text) => {
      const line = typeof text === 'string' ? text.trim() : ''
      if (!line) return
      const event = {
        type: 'response.create',
        response: {
          output_modalities: ['audio'],
          instructions:
            'Read the following text aloud, verbatim, in a natural speaking voice. ' +
            'Do not summarise it, react to it, add to it, or omit any of it.\n\n' +
            line,
        },
      }
      if (!send(event)) pendingSpeechRef.current.push(event)
    },
    [send]
  )

  /* Barge-in: silence the current reply WITHOUT tearing down the session.
   *
   * ChatPage called voice.stop() for this, which closes the data channel, the
   * peer connection and the microphone. So the first time a teacher talked
   * over the assistant, voice mode went permanently mute while the panel still
   * said "Listening" — nothing re-establishes the transport for a spoken turn,
   * and every later speak() silently no-opped on the closed channel. */
  const cancelResponse = useCallback(() => {
    send({ type: 'response.cancel' })
    pendingSpeechRef.current = []
    setSpeaking(false)
    clearCaptionTimer()
    setCaption('')
  }, [send, clearCaptionTimer])

  const setMicMuted = useCallback((next) => {
    const stream = localStreamRef.current
    if (stream) stream.getAudioTracks().forEach((t) => (t.enabled = !next))
    setMuted(next)
  }, [])

  const onUtterance = useCallback((handler) => {
    utteranceHandlersRef.current.add(handler)
    return () => utteranceHandlersRef.current.delete(handler)
  }, [])

  const handleEvent = useCallback(
    (event) => {
      switch (event.type) {
        /* The assistant's own speech, as text, for the caption line. GA renamed
           these from response.audio_transcript.* to
           response.output_audio_transcript.*; both are accepted here rather
           than betting the caption on which name a given model version emits. */
        case 'response.audio_transcript.delta':
        case 'response.output_audio_transcript.delta':
          clearCaptionTimer()
          setSpeaking(true)
          setCaption((prev) => prev + (event.delta || ''))
          break
        case 'response.audio_transcript.done':
        case 'response.output_audio_transcript.done':
          setSpeaking(false)
          // Handle-tracked and cleared on the next delta, so a fast follow-up
          // can't have its live caption blanked by the previous reply's timer,
          // and the timer can't fire into an unmounted provider.
          clearCaptionTimer()
          captionTimerRef.current = setTimeout(() => {
            captionTimerRef.current = null
            setCaption('')
          }, 2000)
          break

        /* The teacher's own words. This is the event the migration forgot to
           turn on; without it nothing downstream ever learned what was said. */
        case 'conversation.item.input_audio_transcription.delta':
          setHeard((prev) => prev + (event.delta || ''))
          break
        case 'conversation.item.input_audio_transcription.completed': {
          const said = (event.transcript || '').trim()
          setHeard(said)
          if (said) {
            for (const h of utteranceHandlersRef.current) {
              try {
                h(said)
              } catch (err) {
                console.error('voice utterance handler failed', err)
              }
            }
          }
          break
        }

        /* Server VAD heard the teacher start talking. If the assistant is
           mid-sentence that is a barge-in, and cancelling is what makes
           talking over it feel like talking over a person. */
        case 'input_audio_buffer.speech_started':
          setHeard('')
          if (speaking) cancelResponse()
          break

        /* Correct event name: response.function_call_arguments.done. The old
           code tested 'response.function_call.arguments.done' — a dot where
           the API has an underscore — so the branch was never entered and the
           whole tool-driven plan-editing feature was dead on arrival. */
        case 'response.function_call_arguments.done':
        case 'response.done': {
          if (event.type === 'response.function_call_arguments.done') {
            let args = {}
            try {
              args = JSON.parse(event.arguments || '{}')
            } catch {
              args = {}
            }
            window.dispatchEvent(
              new CustomEvent('voice:tool_call', {
                detail: { name: event.name, call_id: event.call_id, args },
              })
            )
          }
          break
        }

        case 'error':
          // Surfaced rather than swallowed: a session that has started
          // rejecting events otherwise looks exactly like one that is simply
          // quiet.
          console.error('realtime error event', event)
          break

        default:
          break
      }
    },
    [clearCaptionTimer, speaking, cancelResponse]
  )
  // Read by the data-channel handler, which is installed once per session and
  // must not close over a stale copy of the switch above.
  const handleEventRef = useRef(handleEvent)
  useEffect(() => {
    handleEventRef.current = handleEvent
  }, [handleEvent])

  const unlock = useCallback(
    async (chatId = null, weekNumber = null, mode = 'brainstorm') => {
      if (activeSessionRef.current) return
      const generation = generationRef.current + 1
      generationRef.current = generation
      const cancelled = () => generationRef.current !== generation

      activeSessionRef.current = true
      setStatus('connecting')
      setErrorMessage('')

      try {
        const { token, model } = await api.createVoiceSession({
          chat_id: chatId,
          week_number: weekNumber,
          mode,
        })
        if (cancelled()) return

        const pc = new RTCPeerConnection()
        pcRef.current = pc
        pc.ontrack = (e) => {
          if (audioElRef.current) audioElRef.current.srcObject = e.streams[0]
        }

        const ms = await navigator.mediaDevices.getUserMedia({
          // Matching what the deleted local pipeline asked for: a classroom is
          // a reverberant room and a laptop mic sits under the teacher's hands.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        // Checked immediately, before the stream is stored: this is the await
        // that used to leak a live microphone when voice mode was closed
        // mid-negotiation.
        if (cancelled()) {
          ms.getTracks().forEach((t) => t.stop())
          return
        }
        localStreamRef.current = ms
        ms.getTracks().forEach((track) => pc.addTrack(track, ms))

        const dc = pc.createDataChannel('oai-events')
        dcRef.current = dc
        dc.onmessage = (e) => {
          try {
            handleEventRef.current(JSON.parse(e.data))
          } catch (err) {
            console.error('Failed to parse data channel message', err)
          }
        }
        dc.onopen = () => {
          // Anything said before the channel existed goes now, in order.
          const queued = pendingSpeechRef.current
          pendingSpeechRef.current = []
          for (const ev of queued) send(ev)
        }

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        if (cancelled()) return

        /* POST /v1/realtime/calls. The pre-GA path this replaced —
           POST /v1/realtime?model=… — does not connect at all. */
        const sdpResponse = await fetch(
          `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`,
          {
            method: 'POST',
            body: offer.sdp,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sdp' },
          }
        )
        if (cancelled()) return

        if (!sdpResponse.ok) {
          // The status and OpenAI's own message. "Failed to connect to OpenAI
          // Realtime" was what a teacher saw for a wrong URL, an expired key
          // and a rejected SDP alike.
          const detail = await sdpResponse.text().catch(() => '')
          throw new Error(
            `Realtime connection refused (${sdpResponse.status})${
              detail ? `: ${detail.slice(0, 200)}` : ''
            }`
          )
        }

        const sdp = await sdpResponse.text()
        if (cancelled()) return
        await pc.setRemoteDescription({ type: 'answer', sdp })
        if (cancelled()) return
        setStatus('live')
      } catch (err) {
        console.error(err)
        if (cancelled()) return
        const message = err?.message || String(err)
        setErrorMessage(message)
        stop()
        setStatus('error')
        toast.error('Couldn’t start Voice Mode', message)
      }
    },
    [toast, stop, send]
  )

  /* Side effects out of the setState updater.
   *
   * toggle() used to call localStorage.setItem, unlock() and stop() inside
   * setEnabled's updater, which React may invoke more than once for a single
   * dispatch (and does, under StrictMode) — two negotiations and two
   * getUserMedia calls for one click. The updater is pure now and the
   * transport follows `enabled` from an effect. */
  /* The transport follows the BUTTON PRESS, not the `enabled` state.
   *
   * Two bugs meet at this function, and only one shape avoids both.
   *
   * The original put localStorage.setItem, unlock() and stop() inside
   * setEnabled's updater. React requires updaters to be pure and may run them
   * more than once per dispatch — under StrictMode it always does — so one
   * click negotiated two sessions and opened getUserMedia twice.
   *
   * Moving those effects into a useEffect keyed on `enabled` fixes that and
   * introduces a worse one: `enabled` is seeded from localStorage, so the
   * effect fires on MOUNT for anyone who had ever switched voice mode on —
   * a microphone prompt and a billed realtime session on a page they came to
   * type on. Guarding with a "skip the first run" ref does not help either,
   * because StrictMode's mount/unmount/mount cycle re-runs the effect while
   * the ref persists, so the second mount sails straight past the guard.
   * (Measured: one POST /api/voice/session per page load, with the flag set.)
   *
   * So the side effects live here, in the event handler — the one place that
   * runs exactly once per actual user gesture, never on mount, and never
   * twice for one press. setEnabled takes a value rather than an updater
   * because the next state is already known from the ref. */
  const enabledRef = useRef(enabled)
  const toggle = useCallback(
    (chatId = null, weekNumber = null, mode = 'brainstorm') => {
      const next = !enabledRef.current
      enabledRef.current = next
      setEnabled(next)
      try {
        // Remembers that the button should look on. It does NOT reconnect a
        // session by itself — see above.
        localStorage.setItem(KEY, next ? '1' : '0')
      } catch {
        /* not persisted */
      }
      if (next) unlock(chatId, weekNumber, mode)
      else stop()
    },
    [unlock, stop]
  )

  /* The session and the microphone are released when this provider goes away.
   *
   * There was no unmount cleanup at all: the only effect here created the
   * <audio> element and its teardown paused that element. Leaving voice mode
   * open and navigating to History or Settings left the red recording
   * indicator lit and the room streaming to OpenAI from a page with no voice
   * UI on it. */
  useEffect(() => () => stop(), [stop])

  const value = useMemo(
    () => ({
      enabled,
      toggle,
      status,
      errorMessage,
      speaking,
      caption,
      heard,
      muted,
      setMuted: setMicMuted,
      stop,
      unlock,
      speak,
      cancelResponse,
      onUtterance,
      /* Kept as an alias so existing call sites keep working while they are
         migrated. The name was always wrong for what callers wanted — every
         one of them means "say this out loud", which is what speak() does. */
      sendContextEvent: speak,
    }),
    [
      enabled,
      toggle,
      status,
      errorMessage,
      speaking,
      caption,
      heard,
      muted,
      setMicMuted,
      stop,
      unlock,
      speak,
      cancelResponse,
      onUtterance,
    ]
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
