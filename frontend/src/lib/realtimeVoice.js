import { useCallback, useRef, useState } from 'react'
import { api } from './api'

/* The client side of the live speech-to-speech voice session — see
 * backend/routes/realtime.py for the other half (minting the ephemeral
 * credential this connects with) and its module docstring for why this
 * exists alongside, not instead of, the record-clip -> Whisper ->
 * chat-completion -> tts-1 pipeline VoiceModePanel/VoiceProvider still use.
 *
 * The browser talks to OpenAI DIRECTLY over WebRTC once it has the
 * ephemeral credential — our backend is never in the audio path at all,
 * which is what removes the three-round-trip-per-turn latency the older
 * pipeline has. The flow, once per session:
 *
 *   1. POST /api/realtime/session (our backend) -> ephemeral client_secret,
 *      pre-configured with this conversation's system prompt + tools.
 *   2. getUserMedia for the mic, create an RTCPeerConnection, add the mic
 *      track, create a data channel named "oai-events" (OpenAI's fixed
 *      name for the JSON event channel).
 *   3. createOffer/setLocalDescription, POST the raw SDP offer to
 *      https://api.openai.com/v1/realtime/calls?model=... with the
 *      ephemeral token as the bearer credential — NOT our backend, this
 *      request goes straight to OpenAI. The response body is the SDP
 *      answer; setRemoteDescription with it completes the handshake.
 *   4. The remote audio track (pc.ontrack) is the assistant's live voice —
 *      attach it to an <audio> element and it just plays, no per-sentence
 *      fetch-then-decode round trip.
 *   5. JSON events flow over the data channel in both directions. Server
 *      VAD (configured server-side, see realtime.py) detects speech
 *      start/end and barge-in on its own — there is no client-side
 *      MediaRecorder or energy threshold here at all.
 *
 * This is genuinely new wire-protocol code that has not been exercised
 * against a live OpenAI connection in a real browser as part of building
 * it — the sandboxed environment this was written in has neither. Treat
 * the exact event names/shapes below as "written from OpenAI's current
 * documentation, needs a live smoke test" rather than "verified."
 */

// The three moves the conversation can make, same tool set as chat_stream
// (see llm.py's CHAT_TOOLS / realtime_tool_defs) — surfaced to the caller
// via onToolCall so ChatPage can drive the exact same downstream UI
// (plan generation, quiz creation, QuestionCards) a typed/legacy-voice turn
// already does.
const HANDLED_TOOLS = new Set(['generate_lesson_plan', 'generate_quiz', 'ask_clarifying_questions'])

function parseToolArgs(raw) {
  try {
    return JSON.parse(raw || '{}')
  } catch {
    return {}
  }
}

/**
 * @param {object} handlers
 * @param {(text: string) => void} handlers.onCaption - assistant's spoken
 *   reply, as it transcribes (append-only within one turn, like
 *   useChatStream's sentence stream).
 * @param {() => void} handlers.onCaptionDone - the assistant's turn (audio +
 *   transcript) finished.
 * @param {(text: string) => void} handlers.onHeard - the teacher's own
 *   utterance, once the server finishes transcribing it (VoiceModePanel's
 *   heardText echo).
 * @param {() => void} handlers.onSpeechStarted - server VAD detected the
 *   teacher starting to talk (drives VoiceModePanel's "hearing" state and
 *   is also the barge-in signal — the server itself already cancels/
 *   truncates whatever was playing, this is just the UI's cue to match).
 * @param {(call: {name: string, args: object}) => void} handlers.onToolCall -
 *   one of HANDLED_TOOLS completed with its full arguments.
 * @param {(err: Error) => void} handlers.onError
 */
export function useRealtimeVoice({ onCaption, onCaptionDone, onHeard, onSpeechStarted, onToolCall, onError } = {}) {
  const [connected, setConnected] = useState(false)
  const [muted, setMuted] = useState(false)
  const pcRef = useRef(null)
  const dcRef = useRef(null)
  const micStreamRef = useRef(null)
  const audioElRef = useRef(null)
  // Accumulates a function call's streamed argument fragments, keyed by
  // OpenAI's own call_id — a session can have more than one call in flight
  // (unlikely for these three tools, but the event stream doesn't promise
  // otherwise) so a single shared buffer would interleave two calls' JSON.
  const pendingCallsRef = useRef(new Map())
  const usageInputRef = useRef(0)
  const usageOutputRef = useRef(0)

  const sessionIdRef = useRef(null)

  const flushUsage = useCallback(() => {
    const input = usageInputRef.current
    const output = usageOutputRef.current
    if (!input && !output) return
    usageInputRef.current = 0
    usageOutputRef.current = 0
    // Fire-and-forget — a dropped usage report undercounts spend, which is
    // the same direction of error a flaky network already introduces
    // everywhere else db.record_usage is called; it is never worth
    // blocking or retrying over, and never worth surfacing to the teacher.
    api.reportRealtimeUsage({ input_tokens: input, output_tokens: output }).catch(() => {})
  }, [])

  const handleEvent = useCallback(
    (event) => {
      switch (event.type) {
        case 'response.output_audio_transcript.delta':
          onCaption?.(event.delta || '')
          break
        case 'response.done': {
          const usage = event.response?.usage
          if (usage) {
            usageInputRef.current += usage.input_tokens || 0
            usageOutputRef.current += usage.output_tokens || 0
            flushUsage()
          }
          // response.done's own output array is the robust place to read a
          // completed function call from (full arguments, no accumulation
          // needed) — see this module's own comment on why deltas alone
          // aren't relied on for tool calls.
          for (const item of event.response?.output || []) {
            if (item.type === 'function_call' && HANDLED_TOOLS.has(item.name)) {
              onToolCall?.({ name: item.name, args: parseToolArgs(item.arguments) })
            }
          }
          onCaptionDone?.()
          break
        }
        case 'conversation.item.input_audio_transcription.completed':
          onHeard?.(event.transcript || '')
          break
        case 'input_audio_buffer.speech_started':
          onSpeechStarted?.()
          break
        case 'error':
          onError?.(new Error(event.error?.message || 'Realtime session error'))
          break
        default:
          // Deliberately silent on everything else (session.created,
          // response.created, conversation.item.created, ...) — this is a
          // deep event stream and only the handful above drive any UI here.
          break
      }
    },
    [onCaption, onCaptionDone, onHeard, onSpeechStarted, onToolCall, onError, flushUsage]
  )

  /** Opens the session. `payload` is RealtimeSessionRequest's shape —
   * {mode, chat_id, week_number} — forwarded to POST /api/realtime/session. */
  const connect = useCallback(
    async (payload) => {
      const { client_secret: clientSecret, model } = await api.createRealtimeSession(payload)
      if (!clientSecret) throw new Error('No realtime credential returned.')

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      micStreamRef.current = micStream

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      micStream.getAudioTracks().forEach((track) => pc.addTrack(track, micStream))

      const audioEl = new Audio()
      audioEl.autoplay = true
      audioElRef.current = audioEl
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0]
      }

      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.onmessage = (e) => {
        try {
          handleEvent(JSON.parse(e.data))
        } catch (err) {
          onError?.(err)
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const resp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      })
      if (!resp.ok) {
        throw new Error(`Realtime handshake failed (${resp.status}).`)
      }
      const answerSdp = await resp.text()
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

      setConnected(true)
    },
    [handleEvent, onError]
  )

  const disconnect = useCallback(() => {
    flushUsage()
    dcRef.current?.close()
    dcRef.current = null
    pcRef.current?.close()
    pcRef.current = null
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
    if (audioElRef.current) {
      audioElRef.current.pause()
      audioElRef.current.srcObject = null
      audioElRef.current = null
    }
    pendingCallsRef.current.clear()
    sessionIdRef.current = null
    setConnected(false)
    setMuted(false)
  }, [flushUsage])

  /* Mutes the OUTGOING mic track only — same "real off at the source"
     approach as VoiceModePanel's toggleMute, so the session's own VAD
     never even sees the audio while muted rather than us trying to
     suppress it after the fact. */
  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev
      micStreamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next
      })
      return next
    })
  }, [])

  /* Cancels whatever the assistant is currently saying — the model-driven
     equivalent of VoiceProvider's stop(). Server VAD already does this
     automatically when it detects the teacher talking (interrupt_response
     in realtime.py's turn_detection config); this is for a UI-driven stop
     (closing the panel, tapping mute) where there's no speech to detect. */
  const cancelResponse = useCallback(() => {
    const dc = dcRef.current
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'response.cancel' }))
    }
  }, [])

  return { connected, muted, connect, disconnect, toggleMute, cancelResponse }
}
