import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceContext } from '../lib/voiceContext'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { createSpeechQueue } from '../lib/voiceSpeechQueue'
import * as metrics from '../lib/voiceMetrics'

/* Realtime owns audio transport, turn detection, transcription, and playback.
 * ChatPage owns transcript -> grounded chat_stream -> persistence. */
export function VoiceProvider({ children }) {
  const CONNECT_TIMEOUT_MS = 12000
  const toast = useToast()
  const [status, setStatus] = useState('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [caption, setCaption] = useState('')
  const [heard, setHeard] = useState('')
  const [muted, setMutedState] = useState(false)
  const [interrupted, setInterrupted] = useState(false)

  const pcRef = useRef(null)
  const dcRef = useRef(null)
  const audioElRef = useRef(null)
  const streamRef = useRef(null)
  const activeRef = useRef(false)
  const generationRef = useRef(0)
  const handlersRef = useRef(new Set())
  const captionTimerRef = useRef(null)
  const interruptTimerRef = useRef(null)
  const connectTimerRef = useRef(null)
  const connectAbortRef = useRef(null)
  const connectTimedOutRef = useRef(false)
  const mutedRef = useRef(false)


  useEffect(() => {
    const audio = document.createElement('audio')
    audio.autoplay = true
    audioElRef.current = audio
    return () => {
      audio.pause()
      audio.srcObject = null
    }
  }, [])

  const clearCaptionTimer = useCallback(() => {
    if (captionTimerRef.current) {
      clearTimeout(captionTimerRef.current)
      captionTimerRef.current = null
    }
  }, [])

  const clearConnectTimer = useCallback(() => {
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current)
      connectTimerRef.current = null
    }
  }, [])

  const clearInterruptTimer = useCallback(() => {
    if (interruptTimerRef.current) {
      clearTimeout(interruptTimerRef.current)
      interruptTimerRef.current = null
    }
  }, [])

  const sendEvent = useCallback((event) => {
    const dc = dcRef.current
    if (!dc || dc.readyState !== 'open') return false
    dc.send(JSON.stringify(event))
    return true
  }, [])

  const speechQueueRef = useRef(null)
  if (!speechQueueRef.current) {
    speechQueueRef.current = createSpeechQueue({
      send: sendEvent,
      isOpen: () => activeRef.current && dcRef.current?.readyState === 'open',
    })
  }

  const closeTransport = useCallback(() => {
    try { dcRef.current?.close() } catch { /* already closed */ }
    try { pcRef.current?.close() } catch { /* already closed */ }
    dcRef.current = null
    pcRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (audioElRef.current) audioElRef.current.srcObject = null
  }, [])

  const stopSession = useCallback(() => {
    generationRef.current += 1
    activeRef.current = false
    connectAbortRef.current?.abort()
    connectAbortRef.current = null
    connectTimedOutRef.current = false
    clearConnectTimer()
    clearInterruptTimer()
    speechQueueRef.current.clear()
    clearCaptionTimer()
    // "A closed panel" — voiceMetrics' own third named abandonment case.
    // A no-op if no turn was open (the guard is inside turnAbandoned itself).
    metrics.turnAbandoned()
    setSpeaking(false)
    setCaption('')
    setHeard('')
    setMutedState(false)
    mutedRef.current = false
    setInterrupted(false)
    closeTransport()
    setStatus('idle')
    setErrorMessage('')
  }, [clearCaptionTimer, clearConnectTimer, clearInterruptTimer, closeTransport])

  const pumpSpeech = useCallback(() => speechQueueRef.current.pump(), [])

  const cancelSpeech = useCallback(() => {
    // Barge-in cancels audio only; the microphone and WebRTC session survive.
    speechQueueRef.current.cancel()
    clearCaptionTimer()
    setSpeaking(false)
    setCaption('')
    // response.cancel (above, inside speechQueueRef.cancel()) stops the
    // SERVER from generating more audio, but says nothing about audio
    // already in flight — the WebRTC jitter buffer and the <audio> element
    // itself can both be holding a second or more of already-decided sound,
    // which then keeps playing right through the "barge-in," undercutting
    // the whole point of interrupting. Detaching and immediately
    // reattaching the same live MediaStream forces the element to drop
    // whatever it had buffered and pick back up at the stream's current
    // (silent, post-cancel) position — there is no seekable file to rewind,
    // so this is the flush.
    const el = audioElRef.current
    const track = el?.srcObject
    if (el && track) {
      el.srcObject = null
      el.srcObject = track
    }
  }, [clearCaptionTimer])

  const speak = useCallback((text, options = {}) => {
    const line = typeof text === 'string' ? text.trim() : ''
    if (!line) return
    // Only the turn's first call actually records anything — see
    // sentenceQueued's own guard — so it's safe to call this on every
    // enqueue rather than threading "is this the first one" through here.
    metrics.sentenceQueued()
    speechQueueRef.current.enqueue(line, options)
  }, [])

  const setMuted = useCallback((value) => {
    const next = Boolean(value)
    mutedRef.current = next
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next })
    setMutedState(next)
  }, [])

  /* Push-to-talk's own "I'm done" signal. Releasing PTT already mutes the
     track (setMuted(true), called right after this by the caller) — but a
     muted track still sends silence, not nothing, so without this the
     server's VAD silence timer has to elapse on that silence before it
     decides the turn is over: a guaranteed extra ~350ms tacked onto every
     single push-to-talk turn, on top of whatever the teacher already waited
     holding the button. commit tells the Realtime session the turn is over
     RIGHT NOW, since a manual release is a stronger, more immediate signal
     than silence ever is. A no-op in auto mode, where server VAD alone
     decides turn boundaries and there is no release to hang this off of. */
  const commitTurn = useCallback(() => {
    sendEvent({ type: 'input_audio_buffer.commit' })
  }, [sendEvent])

  const onUtterance = useCallback((handler) => {
    if (typeof handler !== 'function') return () => {}
    handlersRef.current.add(handler)
    return () => handlersRef.current.delete(handler)
  }, [])

  const handleEvent = useCallback((event) => {
    switch (event.type) {
      case 'response.created':
        speechQueueRef.current.responseCreated(event.response?.id)
        clearCaptionTimer()
        setCaption('')
        break
      case 'response.audio.delta':
        if (speechQueueRef.current.current()) {
          setSpeaking(true)
          // Only the turn's first call records anything (firstAudio's own
          // guard) — this fires on every delta of every response, which is
          // exactly what makes it correct: the FIRST one to land after
          // turnStarted() is, by definition, the moment the teacher's wait
          // ends.
          metrics.firstAudio()
        }
        break
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (!speechQueueRef.current.current()) break
        clearCaptionTimer()
        setSpeaking(true)
        setCaption((previous) => previous + (event.delta || ''))
        break
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (!speechQueueRef.current.current()) break
        clearCaptionTimer()
        captionTimerRef.current = setTimeout(() => {
          captionTimerRef.current = null
          setCaption('')
        }, 1800)
        break
      case 'response.done': {
        const responseId = event.response?.id || event.response_id
        if (!speechQueueRef.current.responseDone(responseId)) break
        setSpeaking(false)
        pumpSpeech()
        break
      }
      case 'conversation.item.input_audio_transcription.delta':
        setHeard((previous) => previous + (event.delta || ''))
        break
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript || '').trim()
        setHeard(text)
        // Noise/empty completions never enter ChatPage's submit path.
        if (!text) break
        // "A transcript came back" — the STT leg of the latency budget ends
        // here, whether or not anything downstream ends up using it.
        metrics.transcriptReady()
        for (const handler of handlersRef.current) {
          try { handler(text) } catch (error) { console.error('voice utterance handler failed', error) }
        }
        break
      }
      // The teacher stopped talking — turnStarted()'s own docstring is
      // explicit that the clock has to start HERE, not when a transcript
      // comes back, because everything after this point is latency the
      // teacher actually sits through.
      case 'input_audio_buffer.speech_stopped':
        metrics.turnStarted()
        break
      case 'input_audio_buffer.speech_started':
        setHeard('')
        if (speechQueueRef.current.current() || speechQueueRef.current.pending()) {
          // Barge-in: the assistant was still talking when the teacher
          // started again. Whatever turn was in flight (already spoken, by
          // definition, or it wouldn't be in this branch) is done being
          // measured — recorded as abandoned rather than left to dangle.
          metrics.turnAbandoned()
          cancelSpeech()
          clearInterruptTimer()
          setInterrupted(true)
          interruptTimerRef.current = setTimeout(() => {
            interruptTimerRef.current = null
            setInterrupted(false)
          }, 1400)
        }
        break
      case 'error':
        console.error('realtime error event', event)
        setErrorMessage(event.error?.message || 'The voice session reported an error.')
        metrics.turnAbandoned()
        break
      default:
        break
    }
  }, [cancelSpeech, clearCaptionTimer, clearInterruptTimer, pumpSpeech])

  const handleEventRef = useRef(handleEvent)
  useEffect(() => { handleEventRef.current = handleEvent }, [handleEvent])

  const startSession = useCallback(async (context = {}) => {
    if (activeRef.current) return
    const generation = generationRef.current + 1
    generationRef.current = generation
    const cancelled = () => generationRef.current !== generation
    const connectAbort = new AbortController()
    connectAbortRef.current = connectAbort
    connectTimedOutRef.current = false
    activeRef.current = true
    setStatus('connecting')
    setErrorMessage('')
    clearConnectTimer()
    connectTimerRef.current = setTimeout(() => {
      connectTimedOutRef.current = true
      connectAbort.abort()
    }, CONNECT_TIMEOUT_MS)

    try {
      // Provisioning and microphone permission are independent. Starting them
      // together removes one full network/permission round trip from the
      // deliberate open action while preserving the no-mic-on-page-load rule.
      const sessionPromise = api.createVoiceSession({
        chat_id: context.chatId ?? context.chat_id ?? null,
        class_id: context.classId ?? context.class_id ?? null,
        week_number: context.weekNumber ?? context.week_number ?? null,
        mode: context.mode || 'brainstorm',
      }, { signal: connectAbort.signal })
      const mediaPromise = navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).then((stream) => {
        // getUserMedia cannot be aborted while Chrome's permission prompt is
        // open. If the teacher closes the panel or the handshake times out and
        // then grants permission later, release that late stream immediately.
        if (cancelled() || connectTimedOutRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          return null
        }
        return stream
      })
      const handshake = Promise.all([sessionPromise, mediaPromise])
      const deadline = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Voice connection timed out.')), CONNECT_TIMEOUT_MS)
      })
      const [{ token, model }, stream] = await Promise.race([handshake, deadline])
      if (cancelled()) return
      if (!stream) throw new Error('Microphone permission was not granted.')

      const pc = new RTCPeerConnection()
      pcRef.current = pc
      pc.ontrack = (event) => { if (audioElRef.current) audioElRef.current.srcObject = event.streams[0] }
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && !cancelled()) {
          closeTransport()
          activeRef.current = false
          setErrorMessage('The voice connection was lost. Try again.')
          setStatus('error')
        }
      }

      if (cancelled()) {
        stream.getTracks().forEach((track) => track.stop())
        pc.close()
        return
      }
      streamRef.current = stream
      stream.getAudioTracks().forEach((track) => { track.enabled = !mutedRef.current })
      stream.getTracks().forEach((track) => pc.addTrack(track, stream))
      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      dc.onmessage = (message) => {
        try { handleEventRef.current(JSON.parse(message.data)) } catch (error) { console.error('Failed to parse realtime event', error) }
      }
      dc.onopen = pumpSpeech

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      if (cancelled()) return
      const response = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sdp' },
      })
      if (cancelled()) return
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Realtime connection refused (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() })
      if (cancelled()) return
      clearConnectTimer()
      connectAbortRef.current = null
      setStatus('live')
      pumpSpeech()
    } catch (error) {
      if (cancelled()) return
      connectAbort.abort()
      clearConnectTimer()
      connectAbortRef.current = null
      const message = connectTimedOutRef.current
        ? 'Voice took too long to connect. Check Chrome microphone permissions and try again.'
        : error?.name === 'NotAllowedError'
          ? 'Chrome blocked microphone access. Allow the microphone for this site, then try again.'
          : error?.message || String(error)
      closeTransport()
      activeRef.current = false
      setStatus('error')
      setErrorMessage(message)
      toast.error('Couldn’t start Voice Mode', message)
    }
  }, [clearConnectTimer, closeTransport, pumpSpeech, toast])

  useEffect(() => () => stopSession(), [stopSession])

  const value = useMemo(() => ({
    enabled: status === 'connecting' || status === 'live',
    status,
    errorMessage,
    speaking,
    caption,
    heard,
    muted,
    interrupted,
    startSession,
    stopSession,
    speak,
    cancelSpeech,
    onUtterance,
    setMuted,
    commitTurn,
  }), [cancelSpeech, caption, commitTurn, errorMessage, heard, interrupted, muted, onUtterance, speak, startSession, status, stopSession, setMuted, speaking])

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
