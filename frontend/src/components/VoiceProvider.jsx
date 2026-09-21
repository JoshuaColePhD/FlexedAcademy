import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { VoiceContext, VoiceTransportContext } from '../lib/voiceContext'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { createSpeechQueue } from '../lib/voiceSpeechQueue'
import { openWebRTCTransport } from '../lib/voiceWebRTCTransport'
import { createVoiceAudioMeter } from '../lib/voiceAudioMeter'
import * as metrics from '../lib/voiceMetrics'

const CONNECT_TIMEOUT_MS = 12000
const MAX_SESSION_MS = 20 * 60 * 1000
const VOICE_DEVICE_STORAGE_KEY = 'flexedacademy.voice.inputDevice'
const AUTO_TURN_DETECTION = { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 800, create_response: false, interrupt_response: false }

/* Realtime owns audio/transcription. ChatPage owns grounded reasoning and
 * persistence. The optional transport is injected only by the local preview. */
export function VoiceProvider({ children, transportFactory: suppliedFactory }) {
  const injectedFactory = useContext(VoiceTransportContext)
  const transportFactory = suppliedFactory || injectedFactory
  const preview = Boolean(transportFactory?.preview)
  const toast = useToast()
  const [status, setStatus] = useState('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [caption, setCaption] = useState('')
  const [heard, setHeard] = useState('')
  const [muted, setMutedState] = useState(false)
  const [backgroundMuted, setBackgroundMuted] = useState(false)
  const [interrupted, setInterrupted] = useState(false)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [inputMode, setInputModeState] = useState('auto')
  const transportRef = useRef(null)
  const audioElRef = useRef(null)
  const audioMeterRef = useRef(null)
  const activeRef = useRef(false)
  const readyRef = useRef(false)
  const generationRef = useRef(0)
  const handlersRef = useRef(new Set())
  const speechStartHandlersRef = useRef(new Set())
  const inputSettledHandlersRef = useRef(new Set())
  const captionTimerRef = useRef(null)
  const interruptTimerRef = useRef(null)
  const connectTimerRef = useRef(null)
  const sessionTimerRef = useRef(null)
  const connectAbortRef = useRef(null)
  const mutedRef = useRef(false)
  const inputModeRef = useRef('auto')
  const pttStartedRef = useRef(null)
  const autoMutedRef = useRef(false)
  const usageRef = useRef({ input: 0, output: 0 })
  const completedResponsesRef = useRef(new Set())
  const deliveredTranscriptsRef = useRef(new Set())
  const speechQueueRef = useRef(null)
  const handleEventRef = useRef(null)

  useEffect(() => {
    const audio = document.createElement('audio')
    audio.autoplay = true
    audioElRef.current = audio
    return () => { audio.pause(); audio.srcObject = null; audioElRef.current = null }
  }, [])

  const clearTimer = (ref) => { if (ref.current) clearTimeout(ref.current); ref.current = null }
  const resumeAudio = useCallback(() => {
    audioMeterRef.current?.resume()
    const el = audioElRef.current
    if (!el?.srcObject) return
    const generation = generationRef.current
    el.play().then(() => {
      if (generation === generationRef.current) setAudioBlocked(false)
    }).catch(() => {
      if (generation === generationRef.current) setAudioBlocked(true)
    })
  }, [])
  const sendEvent = useCallback((event) => transportRef.current?.send(event) || false, [])
  if (!speechQueueRef.current) {
    speechQueueRef.current = createSpeechQueue({
      send: sendEvent,
      isOpen: () => activeRef.current && Boolean(transportRef.current?.isOpen()),
      waitForPlayback: true,
    })
  }
  const effectiveMute = useCallback(() => mutedRef.current || autoMutedRef.current || document.hidden, [])
  const applyMute = useCallback(() => transportRef.current?.setMuted?.(effectiveMute()), [effectiveMute])

  const stopSession = useCallback(() => {
    generationRef.current += 1
    activeRef.current = false
    readyRef.current = false
    connectAbortRef.current?.abort()
    connectAbortRef.current = null
    clearTimer(connectTimerRef)
    clearTimer(interruptTimerRef)
    clearTimer(sessionTimerRef)
    clearTimer(captionTimerRef)
    transportRef.current?.close()
    transportRef.current = null
    audioMeterRef.current?.close()
    audioMeterRef.current = null
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current.srcObject = null }
    const usage = usageRef.current
    usageRef.current = { input: 0, output: 0 }
    if (!preview && (usage.input || usage.output)) {
      api.reportVoiceUsage({ input_tokens: usage.input, output_tokens: usage.output }).catch(() => {})
    }
    completedResponsesRef.current.clear()
    deliveredTranscriptsRef.current.clear()
    speechQueueRef.current.clear()
    metrics.turnAbandoned()
    setSpeaking(false)
    setCaption('')
    setHeard('')
    mutedRef.current = inputModeRef.current === 'ptt'
    setMutedState(mutedRef.current)
    autoMutedRef.current = false
    setBackgroundMuted(false)
    pttStartedRef.current = null
    setInterrupted(false)
    setAudioBlocked(false)
    setStatus('idle')
    setErrorMessage('')
  }, [preview])

  const failSession = useCallback((message) => {
    stopSession()
    setErrorMessage(message)
    setStatus('error')
  }, [stopSession])
  const cancelSpeech = useCallback(() => {
    speechQueueRef.current.cancel()
    clearTimer(captionTimerRef)
    setSpeaking(false)
    setCaption('')
  }, [])
  const speak = useCallback((text, options = {}) => {
    const line = typeof text === 'string' ? text.trim() : ''
    if (!line || !activeRef.current) return
    metrics.sentenceQueued()
    speechQueueRef.current.enqueue(line, options)
  }, [])
  const setMuted = useCallback((value) => {
    if (!value) audioMeterRef.current?.resume()
    mutedRef.current = Boolean(value)
    setMutedState(mutedRef.current)
    applyMute()
  }, [applyMute])
  const sendInputMode = useCallback(() => sendEvent({
    type: 'session.update',
    session: { type: 'realtime', audio: { input: { turn_detection: inputModeRef.current === 'ptt' ? null : AUTO_TURN_DETECTION } } },
  }), [sendEvent])
  const setInputMode = useCallback((mode) => {
    if (!['auto', 'ptt'].includes(mode)) return
    inputModeRef.current = mode
    setInputModeState(mode)
    pttStartedRef.current = null
    sendInputMode()
    setMuted(mode === 'ptt')
  }, [sendInputMode, setMuted])
  const settleInput = useCallback((text = '', failed = false) => {
    for (const handler of inputSettledHandlersRef.current) {
      try { handler({ text, failed }) } catch (error) { console.error('voice input-settled handler failed', error) }
    }
  }, [])
  const beginTurn = useCallback(() => {
    if (!readyRef.current || inputModeRef.current !== 'ptt' || document.hidden) return false
    // Manual mode has no VAD speech_started event; pressing PTT is the same
    // interruption signal to the grounded conversation owner.
    for (const handler of speechStartHandlersRef.current) {
      try { handler() } catch (error) { console.error('voice speech-start handler failed', error) }
    }
    cancelSpeech()
    sendEvent({ type: 'input_audio_buffer.clear' })
    pttStartedRef.current = performance.now()
    setHeard('')
    return true
  }, [cancelSpeech, sendEvent])
  const commitTurn = useCallback(() => {
    if (!readyRef.current || inputModeRef.current !== 'ptt' || pttStartedRef.current == null) return false
    const duration = performance.now() - pttStartedRef.current
    pttStartedRef.current = null
    if (duration < 120) { sendEvent({ type: 'input_audio_buffer.clear' }); settleInput(); return false }
    metrics.turnStarted()
    return sendEvent({ type: 'input_audio_buffer.commit' })
  }, [sendEvent, settleInput])
  const onUtterance = useCallback((handler) => {
    if (typeof handler !== 'function') return () => {}
    handlersRef.current.add(handler)
    return () => handlersRef.current.delete(handler)
  }, [])
  const onSpeechStart = useCallback((handler) => {
    if (typeof handler !== 'function') return () => {}
    speechStartHandlersRef.current.add(handler)
    return () => speechStartHandlersRef.current.delete(handler)
  }, [])
  const onInputSettled = useCallback((handler) => {
    if (typeof handler !== 'function') return () => {}
    inputSettledHandlersRef.current.add(handler)
    return () => inputSettledHandlersRef.current.delete(handler)
  }, [])

  const handleEvent = useCallback((event) => {
    const queue = speechQueueRef.current
    switch (event.type) {
      case 'response.created':
        if (!queue.responseCreated(event.response?.id, event.response?.metadata?.speech_id)) break
        clearTimer(captionTimerRef)
        setCaption('')
        break
      case 'output_audio_buffer.started':
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        if (queue.accepts(event.response_id)) {
          setSpeaking(true)
          if (!preview) metrics.firstAudio()
        }
        break
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        if (!queue.accepts(event.response_id)) break
        clearTimer(captionTimerRef)
        setCaption((previous) => previous + (event.delta || ''))
        break
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (queue.accepts(event.response_id) && event.transcript) setCaption(event.transcript)
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (!queue.accepts(event.response_id)) { queue.playbackDone(event.response_id); break }
        setSpeaking(false)
        clearTimer(captionTimerRef)
        captionTimerRef.current = setTimeout(() => setCaption(''), 1800)
        queue.playbackDone(event.response_id)
        break
      case 'response.done': {
        const id = event.response?.id || event.response_id
        if (id && completedResponsesRef.current.has(id)) break
        if (id) completedResponsesRef.current.add(id)
        const usage = event.response?.usage
        if (usage) {
          usageRef.current.input += Number(usage.input_tokens) || 0
          usageRef.current.output += Number(usage.output_tokens) || 0
        }
        const response = event.response || {}
        const hasAudio = !Array.isArray(response.output) || response.output.some((item) => item.content?.some((part) => ['audio', 'output_audio'].includes(part.type)))
        queue.responseDone(id, { status: response.status, hasAudio })
        if (response.status === 'failed') {
          failSession('The spoken reply could not finish. Your lesson remains available in the chat.')
        } else if (!queue.current()) setSpeaking(false)
        break
      }
      case 'conversation.item.input_audio_transcription.delta':
        setHeard((previous) => previous + (event.delta || ''))
        break
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (event.transcript || '').trim()
        if (event.item_id && deliveredTranscriptsRef.current.has(event.item_id)) break
        if (event.item_id) deliveredTranscriptsRef.current.add(event.item_id)
        setHeard(text)
        settleInput(text)
        if (!text) break
        metrics.transcriptReady()
        for (const handler of handlersRef.current) {
          try { handler(text) } catch (error) { console.error('voice utterance handler failed', error) }
        }
        break
      }
      case 'input_audio_buffer.speech_stopped': metrics.turnStarted(); break
      case 'input_audio_buffer.speech_started':
        setHeard('')
        for (const handler of speechStartHandlersRef.current) {
          try { handler() } catch (error) { console.error('voice speech-start handler failed', error) }
        }
        if (queue.current() || queue.pending()) {
          metrics.turnAbandoned()
          cancelSpeech()
          clearTimer(interruptTimerRef)
          setInterrupted(true)
          interruptTimerRef.current = setTimeout(() => setInterrupted(false), 1400)
        }
        break
      case 'conversation.item.input_audio_transcription.failed':
        settleInput('', true)
        failSession('The last sentence could not be transcribed. Your work is saved; reconnect or type it instead.')
        break
      case 'error':
        // A very short PTT tap or an already-finished cancellation is benign.
        if (event.error?.code === 'input_audio_buffer_commit_empty') { settleInput(); break }
        if (event.error?.code === 'response_cancel_not_active') break
        failSession(event.error?.message || 'The voice session reported an error.')
        break
      default: break
    }
  }, [cancelSpeech, failSession, preview, settleInput])
  useEffect(() => { handleEventRef.current = handleEvent }, [handleEvent])

  const startSession = useCallback(async (context = {}) => {
    if (activeRef.current) return
    const generation = ++generationRef.current
    const cancelled = () => generationRef.current !== generation
    const abort = new AbortController()
    let timedOut = false
    connectAbortRef.current = abort
    activeRef.current = true
    readyRef.current = false
    autoMutedRef.current = document.hidden
    setBackgroundMuted(document.hidden)
    setStatus('connecting')
    setErrorMessage('')
    // Start the context within the Voice button's user gesture. Preview has
    // its own explicitly simulated levels and never opens an audio context.
    if (!transportFactory) audioMeterRef.current = createVoiceAudioMeter()
    connectTimerRef.current = setTimeout(() => { timedOut = true; abort.abort() }, CONNECT_TIMEOUT_MS)
    const eventHandler = (event) => { if (!cancelled()) handleEventRef.current?.(event) }
    try {
      let transport
      if (transportFactory) {
        transport = await transportFactory({ onEvent: eventHandler, signal: abort.signal })
      } else {
        let preferredDeviceId = ''
        try { preferredDeviceId = window.localStorage.getItem(VOICE_DEVICE_STORAGE_KEY) || '' } catch { /* optional */ }
        transport = await openWebRTCTransport({
          signal: abort.signal,
          provision: (signal) => api.createVoiceSession({
            chat_id: context.chatId ?? context.chat_id ?? null,
            class_id: context.classId ?? context.class_id ?? null,
            week_number: context.weekNumber ?? context.week_number ?? null,
            mode: context.mode || 'brainstorm',
          }, { signal }),
          onEvent: eventHandler,
          onLost: (message) => { if (!cancelled()) failSession(message) },
          onInputStream: (stream) => { if (!cancelled()) audioMeterRef.current?.attach('input', stream) },
          onTrack: (stream) => {
            if (cancelled() || !audioElRef.current) return
            audioMeterRef.current?.attach('output', stream)
            audioElRef.current.srcObject = stream
            resumeAudio()
          },
          isMuted: effectiveMute,
          preferredDeviceId,
          onDevice: (id) => { try { window.localStorage.setItem(VOICE_DEVICE_STORAGE_KEY, id) } catch { /* optional */ } },
        })
      }
      if (cancelled() || abort.signal.aborted) { transport.close(); return }
      transportRef.current = transport
      clearTimer(connectTimerRef)
      connectAbortRef.current = null
      readyRef.current = true
      applyMute()
      sendInputMode()
      setStatus('live')
      speechQueueRef.current.pump()
      sessionTimerRef.current = setTimeout(() => {
        if (cancelled()) return
        toast.info('Voice Mode timed out', 'Ended after 20 minutes — start it again to keep going.')
        stopSession()
      }, MAX_SESSION_MS)
    } catch (error) {
      if (cancelled()) return
      const message = timedOut
        ? 'Voice took too long to connect. Check microphone permissions and try again.'
        : error?.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it for this site, then try again.'
          : error?.message || 'Voice could not connect. Try again.'
      failSession(message)
      toast.error('Couldn’t start Voice Mode', message)
    }
  }, [applyMute, effectiveMute, failSession, resumeAudio, sendInputMode, stopSession, toast, transportFactory])
  const simulateUtterance = useCallback((text) => {
    if (!preview || !readyRef.current || effectiveMute()) return false
    return transportRef.current?.simulateUtterance?.(text) || false
  }, [effectiveMute, preview])
  const getAudioLevel = useCallback((channel) => {
    if (!readyRef.current || document.hidden || (channel === 'input' && effectiveMute())) return 0
    return preview ? transportRef.current?.sampleLevel?.(channel) || 0 : audioMeterRef.current?.sample(channel) || 0
  }, [effectiveMute, preview])

  useEffect(() => () => stopSession(), [stopSession])
  useEffect(() => {
    const onVisibility = () => {
      if (!activeRef.current) return
      autoMutedRef.current = document.hidden
      setBackgroundMuted(document.hidden)
      applyMute()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [applyMute])

  const value = useMemo(() => ({
    enabled: status === 'connecting' || status === 'live', status, errorMessage,
    speaking, caption, heard, muted: muted || backgroundMuted, backgroundMuted,
    interrupted, audioBlocked, inputMode, preview, isPreview: preview,
    startSession, stopSession, speak, cancelSpeech, onUtterance, onSpeechStart, onInputSettled, setMuted,
    setInputMode, beginTurn, commitTurn, resumeAudio, simulateUtterance, getAudioLevel,
  }), [status, errorMessage, speaking, caption, heard, muted, backgroundMuted,
    interrupted, audioBlocked, inputMode, preview, startSession, stopSession,
    speak, cancelSpeech, onUtterance, onSpeechStart, onInputSettled, setMuted, setInputMode, beginTurn,
    commitTurn, resumeAudio, simulateUtterance, getAudioLevel])
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}
