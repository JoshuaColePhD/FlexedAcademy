import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { api } from '../lib/api'

/* Live voice mode — the thing the "Chat" control opens now, instead of
 * quietly toggling whether replies get read aloud.
 *
 * Always-on, not push-to-talk: this panel listens continuously and decides
 * for itself when a sentence is finished, the same shape as ChatGPT's own
 * voice mode. The mechanism is an energy-based VAD (voice activity
 * detector) driving a plain MediaRecorder — not the browser's
 * SpeechRecognition API, which is Chrome/Google-cloud-only in practice and
 * unreliable on iOS Safari, exactly the platform this app's screenshots
 * keep coming from. Whisper (already wired for the dictate button, see
 * Composer.jsx) transcribes each finished utterance instead.
 *
 * The loop, per utterance:
 *   silence → (volume crosses threshold) → recording → (silence again for
 *   SILENCE_MS) → stop → transcribe → onUtterance(text) → back to silence,
 *   UNLESS the assistant is now busy or speaking, in which case listening
 *   pauses entirely until both clear — otherwise the mic would pick up the
 *   assistant's own TTS output through the speaker and the panel would
 *   talk to itself.
 */

const SPEECH_THRESHOLD = 0.06 // fraction of full scale; tune against real use
const SILENCE_MS = 900
const MIN_UTTERANCE_MS = 300
const MAX_UTTERANCE_MS = 30_000
const BAR_COUNT = 28

export function VoiceModePanel({ onClose, onUtterance, busy, isSpeaking }) {
  const [status, setStatus] = useState('requesting-mic') // requesting-mic | listening | transcribing | error
  const [errorMessage, setErrorMessage] = useState(null)
  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const canvasRef = useRef(null)

  const streamRef = useRef(null)
  const audioCtxRef = useRef(null)
  const analyserRef = useRef(null)
  const rafRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const vadStateRef = useRef('idle') // idle | recording
  const silenceStartRef = useRef(null)
  const speechStartRef = useRef(null)
  // Mirrors the busy/isSpeaking props into the animation loop without
  // re-subscribing the loop itself to React's render cycle — read every
  // frame, written only when the props actually change.
  const pausedRef = useRef(false)
  const processingRef = useRef(false)

  useFocusTrap(panelRef, { active: true, trap: true, initialFocus: closeRef, onEscape: onClose })

  useEffect(() => {
    pausedRef.current = Boolean(busy || isSpeaking)
  }, [busy, isSpeaking])

  const stopRecorder = () => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    recorderRef.current = null
    vadStateRef.current = 'idle'
    silenceStartRef.current = null
    speechStartRef.current = null
  }

  const abortUtterance = () => {
    // The assistant started talking (or generating) while we were mid-
    // recording — discard rather than transcribe, since it's likely a
    // fragment cut off by the pause rather than a finished sentence.
    chunksRef.current = []
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') {
      // No onstop handling wanted for an aborted clip.
      rec.ondataavailable = null
      rec.onstop = null
      rec.stop()
    }
    recorderRef.current = null
    vadStateRef.current = 'idle'
    silenceStartRef.current = null
    speechStartRef.current = null
  }

  const beginUtterance = () => {
    const stream = streamRef.current
    if (!stream) return
    chunksRef.current = []
    const rec = new MediaRecorder(stream)
    rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data)
    rec.onstop = handleUtteranceReady
    recorderRef.current = rec
    rec.start()
    vadStateRef.current = 'recording'
    speechStartRef.current = performance.now()
    silenceStartRef.current = null
  }

  const handleUtteranceReady = async () => {
    const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
    chunksRef.current = []
    const started = speechStartRef.current
    vadStateRef.current = 'idle'
    speechStartRef.current = null
    silenceStartRef.current = null
    // Too short to be real speech — a cough, a tap, a bump of the table.
    if (!started || performance.now() - started < MIN_UTTERANCE_MS || blob.size === 0) return
    processingRef.current = true
    setStatus('transcribing')
    try {
      const { text } = await api.transcribe(blob)
      if (text && text.trim()) onUtterance(text.trim())
    } catch {
      // A missed utterance just means "say it again" — the mic is still
      // live and the panel is still open, so there's nothing to recover.
    } finally {
      processingRef.current = false
      setStatus('listening')
    }
  }

  useEffect(() => {
    let cancelled = false

    // Canvas's fillStyle parser doesn't resolve CSS var() — it isn't part of
    // the cascade — so the actual accent color has to be read out as a
    // concrete value once, not passed through as a custom property.
    const accentRgb =
      getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() ||
      '47 95 191'

    const draw = (level) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      const { width, height } = canvas
      ctx.clearRect(0, 0, width, height)
      const barWidth = width / BAR_COUNT
      const mid = height / 2
      // Bars further from center read as quieter than the center ones for
      // the same input level — a still-recognizable "waveform" silhouette
      // instead of a flat row of identical bars, without analysing
      // per-frequency-bin data (which reacts more to pitch than to
      // "are you talking," the thing this actually needs to show).
      for (let i = 0; i < BAR_COUNT; i++) {
        const distance = Math.abs(i - (BAR_COUNT - 1) / 2) / (BAR_COUNT / 2)
        const falloff = 1 - distance * 0.6
        const barLevel = pausedRef.current ? 0.04 : Math.max(0.04, level * falloff)
        const barHeight = Math.max(2, barLevel * height)
        const x = i * barWidth + barWidth * 0.2
        const w = barWidth * 0.6
        ctx.fillStyle = pausedRef.current ? 'rgba(150,150,150,0.35)' : `rgb(${accentRgb})`
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(x, mid - barHeight / 2, w, barHeight, w / 2)
        else ctx.rect(x, mid - barHeight / 2, w, barHeight)
        ctx.fill()
      }
    }

    const tick = () => {
      const analyser = analyserRef.current
      if (!analyser) return
      const data = new Uint8Array(analyser.fftSize)
      analyser.getByteTimeDomainData(data)
      // RMS of the signed waveform (each byte is 0-255, 128 = silence).
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128
        sumSquares += v * v
      }
      const level = Math.sqrt(sumSquares / data.length)

      draw(level)

      if (pausedRef.current) {
        // The assistant is generating or speaking — don't record it.
        if (vadStateRef.current === 'recording') abortUtterance()
      } else if (!processingRef.current) {
        const now = performance.now()
        if (level > SPEECH_THRESHOLD) {
          silenceStartRef.current = null
          if (vadStateRef.current === 'idle') beginUtterance()
          else if (now - speechStartRef.current > MAX_UTTERANCE_MS) stopRecorder()
        } else if (vadStateRef.current === 'recording') {
          if (silenceStartRef.current == null) silenceStartRef.current = now
          else if (now - silenceStartRef.current > SILENCE_MS) stopRecorder()
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const AudioCtx = window.AudioContext || window.webkitAudioContext
        const ctx = new AudioCtx()
        audioCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        analyserRef.current = analyser
        setStatus('listening')
        rafRef.current = requestAnimationFrame(tick)
      } catch (err) {
        if (!cancelled) {
          setStatus('error')
          setErrorMessage(
            err?.name === 'NotAllowedError'
              ? 'Microphone access was blocked. Allow it in your browser settings and try again.'
              : err?.message || 'Could not start the microphone.'
          )
        }
      }
    })()

    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      stopRecorder()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      audioCtxRef.current?.close().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const label =
    status === 'requesting-mic'
      ? 'Asking for microphone access…'
      : status === 'error'
        ? errorMessage
        : busy
          ? 'Thinking…'
          : isSpeaking
            ? 'Speaking…'
            : status === 'transcribing'
              ? 'Got it — one sec…'
              : 'Listening…'

  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Voice conversation"
        className="dialog flex w-full max-w-sm flex-col items-center gap-6 !p-8 text-center"
      >
        <canvas ref={canvasRef} width={320} height={96} className="h-24 w-full" />
        <p aria-live="polite" className="min-h-[1.5em] text-sm text-ink-soft">
          {label}
        </p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="End voice conversation"
          className="tap-target flex h-11 w-11 items-center justify-center rounded-full bg-paper-sunken text-ink-soft transition-colors hover:bg-paper-inset hover:text-ink"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
