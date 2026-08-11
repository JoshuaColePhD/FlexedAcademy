import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Play, Sparkles, User, X } from 'lucide-react'
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
 * artwork, the mini-bar is the status/close row). Desktop keeps the smaller
 * centered-dialog treatment; the full takeover is what "might work best on
 * mobile" actually meant it for.
 *
 * Rendered in the .neo-world world (base.css) — soft embossed "neomorphic"
 * surfaces on request, matching the reference images directly rather than
 * translating them into this app's normal flat, high-contrast look. That
 * tradeoff (faint edges, low contrast) is real and is scoped to this one
 * opt-in screen on purpose — see .neo-world's own comment for why it's fine
 * here and would not be fine as a default anywhere else in the app.
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
    <div className="neo-panel flex h-full flex-col overflow-hidden rounded-[28px] bg-paper-raised">
      <div className="shrink-0 px-5 py-4">
        <p className="text-sm font-semibold text-ink">This conversation</p>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {messages.length ? (
          messages.map((m) => {
            const isUser = m.role === 'user'
            return (
              <li key={m.id} className="flex items-center gap-3 px-2 py-2">
                {/* Inset, not raised — a display element, not something to
                    tap, and neomorphism's usual way of telling the two
                    apart at a glance. */}
                <span
                  aria-hidden="true"
                  className={`neo-inset grid h-10 w-10 shrink-0 place-items-center rounded-full ${
                    isUser ? 'text-ink-soft' : 'text-accent-text'
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
                    className="neo-raised tap-target flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-accent-text"
                  >
                    <Play size={14} aria-hidden="true" fill="currentColor" />
                  </button>
                )}
              </li>
            )
          })
        ) : (
          <li className="px-3 py-3 text-sm text-ink-muted">Say something to get started.</li>
        )}
      </ul>
    </div>
  )
}

// Only the most recent ones stay visible — the point is "what's true right
// now," not a full history (that's what the transcript is for), and an
// unbounded stack would eventually spill out of a container sized to look
// like a small deck of cards, not a scrolling list.
const MAX_VISIBLE_DECISIONS = 6

/* What's been settled in the conversation so far (llm.extract_decisions),
 * as a small deck of index cards rather than a checklist — each one drops
 * in with its own slight tilt and stays there, so the stack visibly grows
 * turn by turn instead of a list quietly re-rendering. Newest on top: it's
 * both the most recent decision AND the thing most likely still relevant to
 * what's being discussed right now.
 */
function DecisionStack({ decisions }) {
  if (!decisions.length) return null
  const visible = decisions.slice(-MAX_VISIBLE_DECISIONS)
  return (
    <div className="neo-panel relative flex aspect-square w-full max-w-[220px] shrink-0 flex-col overflow-hidden rounded-[28px] bg-paper-raised p-4">
      <p className="eyebrow shrink-0">Decided so far</p>
      <div className="relative min-h-0 flex-1">
        {visible.map((d, i) => {
          // A small alternating fan, not a random scatter — random tilts on
          // a REORDERING list (new cards insert at the end, old ones never
          // move) would still read as jittery each time one lands next to
          // an unrelated angle. Alternating by position is stable and still
          // reads as "a loose stack of cards," not a grid.
          const rot = ((i % 4) - 1.5) * 3
          return (
            <div
              key={`${d.label}:${i}`}
              className="fa-card-drop neo-raised absolute inset-x-1 flex items-start gap-2 rounded-xl bg-paper-raised px-3 py-2 text-left"
              style={{ '--card-rot': `${rot}deg`, top: `${i * 8}px`, zIndex: i }}
            >
              <Check size={13} className="mt-0.5 shrink-0 text-accent-text" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                  {d.label}
                </span>
                <span className="block truncate text-xs text-ink">{d.value}</span>
              </span>
            </div>
          )
        })}
      </div>
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
  // The text currently being (or about to be) spoken — the opening greeting,
  // then every later reply. Typed out below in rough sync with the TTS
  // audio, rather than dumped on screen all at once, so the panel reads as
  // "talking," matching what's actually coming out of the speaker turn by
  // turn instead of a caption that's already finished before the voice has.
  caption = '',
  // What's been settled in the conversation so far — see DecisionStack.
  decisions = [],
}) {
  const [status, setStatus] = useState('requesting-mic') // requesting-mic | listening | transcribing | error
  const [errorMessage, setErrorMessage] = useState(null)
  const [typedCaption, setTypedCaption] = useState('')
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
  // MediaRecorder's default mimeType varies by browser (webm/opus on
  // Chrome/Firefox, mp4/aac on Safari/iOS — the exact platform this app's
  // own screenshots keep coming from). handleUtteranceReady used to hardcode
  // 'audio/webm' on the reconstructed Blob no matter what was actually
  // recorded, which defeats api.transcribe()'s own blob.type-based extension
  // detection — every Safari utterance was uploaded mislabeled as .webm,
  // Whisper's decoder disagreed with the real container, and transcription
  // failed silently (handleUtteranceReady's catch swallows it on purpose —
  // see its own comment). Captured here, at start time, because by the time
  // the recorder's `stop` event fires and hands off to handleUtteranceReady,
  // recorderRef.current has already been nulled — there is no other way to
  // read back what the recorder actually used.
  const mimeTypeRef = useRef('audio/webm')
  // Mirrors the busy/isSpeaking props into the animation loop without
  // re-subscribing the loop itself to React's render cycle — read every
  // frame, written only when the props actually change.
  const pausedRef = useRef(false)
  const processingRef = useRef(false)
  // The mic/VAD pipeline below is set up in a mount-once effect (deps: []) —
  // deliberately, since tearing down and re-requesting getUserMedia every
  // render would be its own bug. But handleUtteranceReady, which that effect
  // wires up exactly once via `rec.onstop`, used to call the `onUtterance`
  // PROP directly. That prop is ChatPage's `submit`, whose identity changes
  // every turn (its own deps include `messages`, `chatId`, `artifact`...) —
  // so every utterance after the first was calling the STALE submit()
  // captured when the panel first opened, with no messages, no chat id, and
  // no artifact yet. The conversation would submit turn 2 as if turn 1 had
  // never happened. A ref sidesteps that the same way pausedRef already does
  // for busy/isSpeaking: read fresh every call, written on every render.
  const onUtteranceRef = useRef(onUtterance)
  onUtteranceRef.current = onUtterance

  useFocusTrap(panelRef, { active: true, trap: true, initialFocus: closeRef, onEscape: onClose })

  useEffect(() => {
    pausedRef.current = Boolean(busy || isSpeaking)
  }, [busy, isSpeaking])

  // Reveals `caption` a character at a time rather than all at once — an
  // approximation of speech pace (no real word-level timing exists without
  // aligning against the TTS audio itself, which this app's turn-based
  // record→transcribe→speak pipeline has no hook for). ~22 chars/sec is a
  // touch brisker than average spoken English, on purpose: a caption that
  // finishes slightly AHEAD of the audio reads as natural anticipation, one
  // that lags behind it reads as broken.
  useEffect(() => {
    setTypedCaption('')
    if (!caption) return undefined
    const CHAR_MS = 45
    let i = 0
    const id = setInterval(() => {
      i += 1
      setTypedCaption(caption.slice(0, i))
      if (i >= caption.length) clearInterval(id)
    }, CHAR_MS)
    return () => clearInterval(id)
  }, [caption])

  // Two cleanup jobs once the audio itself stops: finish the type-out
  // instantly rather than leaving it to visibly limp to the end of a
  // sentence nobody can still hear, then clear it a few seconds later so
  // the panel settles back to its normal "Listening…" status instead of
  // showing what was said forever.
  useEffect(() => {
    if (isSpeaking || !caption) return undefined
    setTypedCaption(caption)
    const t = setTimeout(() => setTypedCaption(''), 4000)
    return () => clearTimeout(t)
  }, [isSpeaking, caption])

  // rec.stop() is ASYNCHRONOUS — the 'stop' event (and so handleUtteranceReady,
  // wired up as rec.onstop) doesn't fire until the recorder finishes
  // flushing. This used to null out speechStartRef/vadStateRef/
  // silenceStartRef right here, synchronously, immediately after calling
  // stop() — so by the time handleUtteranceReady actually ran and read
  // speechStartRef.current to validate the utterance, it was ALWAYS already
  // null. `if (!started ...) return` fired every time, and the utterance was
  // discarded before transcription — confirmed live: dataavailable fired
  // with real recorded audio, the native 'stop' event fired, and
  // handleUtteranceReady still never called api.transcribe. Every utterance
  // through the normal silence-triggered path was silently dropped.
  //
  // It also raced vadStateRef back to 'idle' before the old recorder had
  // actually finished stopping, so the VAD loop's very next tick could see
  // 'idle' and call beginUtterance() again — a second, bogus recording
  // starting while the first was still flushing.
  //
  // handleUtteranceReady already does this same cleanup correctly (reads
  // `started` BEFORE nulling it) once the recorder actually finishes — so
  // stopRecorder's only job is to ask it to stop.
  const stopRecorder = () => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    recorderRef.current = null
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
    mimeTypeRef.current = rec.mimeType || 'audio/webm'
    rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data)
    rec.onstop = handleUtteranceReady
    recorderRef.current = rec
    rec.start()
    vadStateRef.current = 'recording'
    speechStartRef.current = performance.now()
    silenceStartRef.current = null
  }

  const handleUtteranceReady = async () => {
    const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current })
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
      if (text && text.trim()) onUtteranceRef.current(text.trim())
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
    //
    // Read from the CANVAS element, not document.documentElement: this
    // panel lives inside .neo-world, which redeclares --accent-rgb to its
    // own rose rather than the app's blue, and that override only takes
    // effect for elements actually inside the scope. Reading from the root
    // would silently get the wrong color the moment .neo-world disagrees
    // with :root, which is the entire point of it existing. Read once, here
    // — the canvas is already mounted by the time an effect body runs — not
    // per frame, which would force a style recalculation at 60fps.
    const accentRgb = canvasRef.current
      ? getComputedStyle(canvasRef.current).getPropertyValue('--accent-rgb').trim()
      : ''
    const resolvedAccentRgb = accentRgb || '47 95 191'

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
      const rgb = pausedRef.current ? '150 150 150' : resolvedAccentRgb
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
        // Explicit constraints, not a bare `audio: true` — on a phone the
        // mic sits inches from the speaker this same panel is playing TTS
        // out of, and without the browser's own echo cancellation actually
        // requested, the mic picks up the assistant's own voice bleeding
        // back in (worst right as isSpeaking flips off and the room's still
        // resonating) and transcribes THAT — which reads as "can barely hear
        // what I'm saying" and nonsensical replies, because it isn't
        // transcribing what was said, it's transcribing an echo of itself.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
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

  // The typed-out caption takes over the status line while there's one to
  // show — status === 'error' still wins over it regardless, a real problem
  // (mic blocked, etc.) shouldn't be buried under leftover caption text.
  const displayText = status === 'error' ? label : typedCaption || label

  // The "album art" disc itself: a big raised, ringed circle standing in
  // for the reference's cover art, with the pulsing accent circles (drawn
  // in the effect above) glowing inside it.
  const orb = (
    <div className="neo-raised neo-ring relative flex aspect-square w-full max-w-[280px] items-center justify-center rounded-full">
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
        className="neo-world fixed inset-0 z-50 flex flex-col bg-paper"
      >
        <div className="flex h-14 shrink-0 items-center px-4">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="End voice conversation"
            className="neo-raised tap-target flex h-10 w-10 items-center justify-center rounded-full text-ink-soft"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-gutter py-4">
          {/* Shares the vertical space with the stack once there's one to
              show, rather than the orb always claiming the same room
              whether or not there's anything else on screen. */}
          <div className={decisions.length ? 'w-full max-w-[200px]' : 'w-full max-w-[280px]'}>{orb}</div>
          <DecisionStack decisions={decisions} />
        </div>

        {/* The reference's docked mini-player bar — here it carries the
            live status instead of a track name, since that's the one thing
            actually changing turn to turn. */}
        <div className="shrink-0 px-gutter pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <div className="neo-panel flex min-h-touch items-center justify-between gap-3 rounded-[28px] bg-paper-raised px-5 py-3">
            <p aria-live="polite" className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-ink">
              {displayText}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="End voice conversation"
              className="neo-raised tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-soft"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="neo-world dialog-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* items-stretch, not the scrim's own align-items:center — the
          transcript column matches the card's height instead of centering
          independently at whatever height its own content happens to want. */}
      <div className="flex max-h-[560px] w-full max-w-4xl items-stretch gap-4">
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
          className="neo-panel flex min-w-0 flex-1 flex-col items-center justify-center gap-6 rounded-[28px] bg-paper-raised p-8 text-center"
        >
          {orb}
          <p aria-live="polite" className="line-clamp-3 min-h-[1.5em] text-sm text-ink-soft">
            {displayText}
          </p>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="End voice conversation"
            className="neo-raised tap-target flex h-11 w-11 items-center justify-center rounded-full text-ink-soft"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {decisions.length ? (
          <div className="hidden w-56 shrink-0 md:block">
            <DecisionStack decisions={decisions} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
