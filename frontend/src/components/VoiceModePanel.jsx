import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Play, Sparkles, User, X } from 'lucide-react'
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
 *
 * Layout is a phone-first full-screen takeover (a reference the user
 * supplied — a music player's big circular art + a docked mini-bar below —
 * mapped onto this: the "art" is a pulsing orb standing in for album
 * artwork, the mini-bar is the status/close row). Rendered flat in the
 * app's own accent color rather than literally neomorphic — soft-shadow UI
 * is low-contrast by construction, which fights the accessible, high-
 * contrast look the rest of this app was built with. Desktop keeps the
 * smaller centered-dialog treatment; the full takeover is what "might work
 * best on mobile" actually meant it for.
 */

const SPEECH_THRESHOLD = 0.06 // fraction of full scale; tune against real use
const SILENCE_MS = 900
const MIN_UTTERANCE_MS = 300
const MAX_UTTERANCE_MS = 30_000

/* The transcript, styled after a music-app library list (another reference
 * the user supplied): a small round avatar, a title/subtitle pair, and one
 * round action per row. There's no per-row play/pause state — this is
 * "replay," not a transport control, so every assistant row always shows
 * Play; clicking it just calls voice.speak() again on that message's own
 * text. Desktop only, in the left column — on a phone the transcript is
 * still one swipe away underneath this panel, and there's no room for a
 * second column at that width anyway. */
function Transcript({ messages, onReplay }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-edge bg-paper-raised">
      <div className="shrink-0 border-b border-edge px-4 py-3">
        <p className="text-sm font-semibold text-ink">This conversation</p>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {messages.length ? (
          messages.map((m) => {
            const isUser = m.role === 'user'
            return (
              <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                <span
                  aria-hidden="true"
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                    isUser ? 'bg-paper-sunken text-ink-soft' : 'bg-accent-tint text-accent-text'
                  }`}
                >
                  {isUser ? <User size={15} /> : <Sparkles size={15} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {isUser ? 'You' : 'Assistant'}
                  </span>
                  <span className="block truncate text-xs text-ink-muted">{m.content}</span>
                </span>
                {isUser ? null : (
                  <button
                    type="button"
                    onClick={() => onReplay(m.content)}
                    aria-label="Replay this reply"
                    className="tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper-sunken text-ink-soft transition-colors hover:bg-paper-inset hover:text-ink"
                  >
                    <Play size={14} aria-hidden="true" fill="currentColor" />
                  </button>
                )}
              </li>
            )
          })
        ) : (
          <li className="px-4 py-3 text-sm text-ink-muted">Say something to get started.</li>
        )}
      </ul>
    </div>
  )
}

export function VoiceModePanel({
  onClose,
  onUtterance,
  busy,
  isSpeaking,
  isPhone,
  messages = [],
  onReplay,
}) {
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
    // concrete value once, not passed through as a custom property. Same
    // primitive the CSS .voice-glow behind this canvas reads, so a future
    // retint can't make the two silently disagree.
    const accentRgb =
      getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() ||
      '47 95 191'

    // A pulsing orb, not a bar chart — the reference layout's "album art" is
    // a single focal circle, and a lone breathing shape reads as "alive"
    // more than a row of bars does at a glance across a full-screen mobile
    // takeover. Three concentric layers (outermost = faintest) is the
    // cheapest way to fake depth without an actual soft-shadow/neomorphic
    // treatment, which is low-contrast by construction — see the file
    // header on why that look isn't used here.
    const draw = (level) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      const { width, height } = canvas
      ctx.clearRect(0, 0, width, height)
      const cx = width / 2
      const cy = height / 2
      const base = Math.min(width, height) * 0.16
      const extra = Math.min(width, height) * 0.22
      const effectiveLevel = pausedRef.current ? 0.05 : Math.max(0.05, level)
      const rgb = pausedRef.current ? '150 150 150' : accentRgb
      const layers = [
        { mult: 1, alpha: 0.16 },
        { mult: 0.7, alpha: 0.28 },
        { mult: 0.42, alpha: 0.9 },
      ]
      for (const { mult, alpha } of layers) {
        const r = base * mult + extra * mult * effectiveLevel
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = `rgb(${rgb} / ${alpha})`
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

  const orb = (
    <div className="relative flex aspect-square w-full max-w-[280px] items-center justify-center">
      <div className="voice-glow" aria-hidden="true" />
      <canvas ref={canvasRef} width={280} height={280} className="h-full w-full" />
    </div>
  )

  if (isPhone) {
    return (
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Voice conversation"
        className="fixed inset-0 z-50 flex flex-col bg-paper"
      >
        <div className="flex h-14 shrink-0 items-center px-2">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="End voice conversation"
            className="tap-target flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-paper-sunken hover:text-ink"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-1 items-center justify-center px-gutter">{orb}</div>

        {/* The reference's docked mini-player bar — here it carries the
            live status instead of a track name, since that's the one thing
            actually changing turn to turn. */}
        <div className="shrink-0 px-gutter pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="flex min-h-touch items-center justify-between gap-3 rounded-full border border-edge bg-paper-raised px-5 py-3 shadow-lg">
            <p aria-live="polite" className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
              {label}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="End voice conversation"
              className="tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper-sunken text-ink-soft transition-colors hover:bg-paper-inset hover:text-ink"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      {/* items-stretch, not the scrim's own align-items:center — the
          transcript column matches the card's height instead of centering
          independently at whatever height its own content happens to want. */}
      <div className="flex max-h-[560px] w-full max-w-3xl items-stretch gap-4">
        {messages.length ? (
          <div className="hidden w-72 shrink-0 md:block">
            <Transcript messages={messages} onReplay={onReplay} />
          </div>
        ) : null}
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Voice conversation"
          className="dialog flex min-w-0 flex-1 flex-col items-center justify-center gap-6 !p-8 text-center"
        >
          {orb}
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
    </div>
  )
}
