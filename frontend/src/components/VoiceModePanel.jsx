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
/* How long a pause has to last before the utterance is considered finished.
   This is pure turn-taking latency — every millisecond here is dead air the
   teacher sits through after they've stopped talking, before anything is
   even sent. 900ms was a noticeable beat; ~600 still comfortably rides out
   the pause inside "Week seven… uh… on Poe" without cutting it in half. */
const SILENCE_MS = 620
const MIN_UTTERANCE_MS = 300
const MAX_UTTERANCE_MS = 30_000

/* Barge-in (talking over the assistant) is held to a stricter standard than
   starting a fresh utterance into silence, because the room is not silent —
   the assistant's own voice is coming out of a speaker inches from the mic.
   getUserMedia's echoCancellation removes most of it, but "most" leaves
   enough transient leakage to trip a bare threshold, and a false interrupt
   is worse than a missed one: it cuts the assistant off mid-word for
   nothing. So: a higher bar, held for a sustained stretch rather than one
   lucky frame. */
const BARGE_THRESHOLD = 0.13
const BARGE_SUSTAIN_MS = 180

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

/* What's been settled in the conversation so far (llm.extract_decisions) —
 * the running plan, building itself in front of the teacher.
 *
 * A vertical column, not the fanned deck this used to be: a deck reads as
 * "a pile of things" and only its top card is legible, which is exactly
 * wrong for the job. These are the durable decisions the week is being
 * built from, and all of them need to stay readable at once — so each new
 * one drops in UNDER the last, the column grows downward as the
 * conversation goes, and the whole set reads top to bottom like the outline
 * it is. Newest at the bottom, in the order they were decided, because that
 * is the order the teacher said them.
 */
function DecisionStack({ decisions }) {
  const endRef = useRef(null)
  // Keep the newest card in view as the column outgrows its container —
  // otherwise the one that just landed is the one you can't see.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [decisions.length])

  return (
    <div className="neo-panel flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[28px] bg-paper-raised p-4">
      <p className="eyebrow shrink-0 pb-2">The plan so far</p>
      {decisions.length ? (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
          {decisions.map((d, i) => (
            <li
              key={`${d.label}:${i}`}
              className="fa-card-drop neo-raised flex shrink-0 items-start gap-2.5 rounded-2xl bg-paper-raised px-3.5 py-2.5 text-left"
            >
              {/* Inset, not raised — a completed mark, something already
                  pressed into the card rather than another thing to tap. */}
              <span
                aria-hidden="true"
                className="neo-inset mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-accent-text"
              >
                <Check size={11} strokeWidth={3} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                  {d.label}
                </span>
                <span className="block text-sm leading-snug text-ink">{d.value}</span>
              </span>
            </li>
          ))}
          <li ref={endRef} aria-hidden="true" />
        </ul>
      ) : (
        <p className="text-xs leading-relaxed text-ink-muted">
          As you settle things — the week, the text, what they’ll be graded on — they’ll stack up
          here.
        </p>
      )}
    </div>
  )
}

/* The clarification cards. When the teacher says something too vague to
 * build from, the model asks ONE short question (see the backend's voice
 * prompt) and its options land here as real, tappable buttons rather than
 * a list read aloud — faster to answer, and it keeps the spoken half of
 * the conversation short, which is the whole point of voice mode.
 */
function QuestionCards({ questions, onAnswer }) {
  const [answers, setAnswers] = useState({})
  const allAnswered = questions.every((q) => answers[q.id])

  const send = () => {
    const text = questions.map((q) => `${q.text} ${answers[q.id]}`).join('\n')
    onAnswer(text)
  }

  return (
    <div className="fa-card-drop neo-panel flex w-full flex-col gap-3 rounded-[28px] bg-paper-raised p-4">
      {questions.map((q) => (
        <div key={q.id} className="flex flex-col gap-2">
          <p className="text-sm font-medium leading-snug text-ink">{q.text}</p>
          <div className="flex flex-wrap gap-2">
            {(q.options || []).map((opt) => {
              const selected = answers[q.id] === opt
              return (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: opt }))}
                  /* Pressed-in when chosen, standing proud when not — the
                     same physical language every other selected/unselected
                     pair in this app already speaks. */
                  className={`tap-target rounded-full px-3.5 py-2 text-sm font-medium transition-shadow ${
                    selected ? 'neo-inset text-accent-text' : 'neo-raised text-ink-soft'
                  }`}
                >
                  {opt}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={!allAnswered}
        onClick={send}
        className="neo-raised mt-1 min-h-touch self-start rounded-full bg-accent-tint px-5 text-sm font-medium text-accent-text transition-shadow disabled:cursor-not-allowed disabled:opacity-50"
      >
        Continue
      </button>
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
  // Cuts the current reply off mid-sentence — VoiceProvider's voice.stop().
  // Called the instant the teacher starts talking OVER it (see the VAD
  // loop's own comment on barge-in), not after it finishes.
  onInterrupt,
  // The clarification the conversation is waiting on, if any, and the way
  // to answer it — see QuestionCards.
  questions = null,
  onAnswer,
}) {
  const [status, setStatus] = useState('requesting-mic') // requesting-mic | listening | transcribing | error
  const [errorMessage, setErrorMessage] = useState(null)
  const [typedCaption, setTypedCaption] = useState('')
  // How far the type-out has got, and what it was typing — kept across
  // renders so a caption that GROWS mid-sentence (streamed speech) picks up
  // where it left off instead of restarting. See the caption effect below.
  const typedIdxRef = useRef(0)
  const prevCaptionRef = useRef('')
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
  // Mirrors `busy` into the animation loop without re-subscribing the loop
  // itself to React's render cycle — read every frame, written only when
  // the prop actually changes. isSpeaking used to be folded in here too,
  // pausing the mic outright while a reply played — which is exactly what
  // made it impossible to interrupt: the mic was DEAF to the teacher's
  // voice for as long as the assistant kept talking, not merely ignoring
  // it. Recording during a reply is a genuinely different pipeline state
  // (see isSpeakingRef below), not just "still paused."
  const pausedRef = useRef(false)
  // Read by the VAD loop to tell "the mic caught something during a reply"
  // (barge-in — interrupt, then record) apart from "the mic caught
  // something while idle" (an ordinary new utterance). Same ref-mirror
  // pattern as pausedRef/onUtteranceRef, for the same reason: the loop
  // reads this every frame without resubscribing to isSpeaking's renders.
  const isSpeakingRef = useRef(false)
  // When the current run of over-threshold audio began, while the assistant
  // holds the floor. Null whenever the level drops back below it — the
  // "sustained" half of the barge-in test.
  const bargeStartRef = useRef(null)
  const onInterruptRef = useRef(onInterrupt)
  onInterruptRef.current = onInterrupt
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
    // busy alone, not busy || isSpeaking — see pausedRef's own comment.
    // There's genuinely nothing to record INTO yet while busy (no reply
    // exists at all, spoken or otherwise), but isSpeaking has something
    // actively playing that a real utterance should be able to cut off.
    pausedRef.current = Boolean(busy)
  }, [busy])

  useEffect(() => {
    isSpeakingRef.current = Boolean(isSpeaking)
  }, [isSpeaking])

  // Reveals `caption` a character at a time rather than all at once — an
  // approximation of speech pace (no real word-level timing exists without
  // aligning against the TTS audio itself, which this app's turn-based
  // record→transcribe→speak pipeline has no hook for). ~22 chars/sec is a
  // touch brisker than average spoken English, on purpose: a caption that
  // finishes slightly AHEAD of the audio reads as natural anticipation, one
  // that lags behind it reads as broken.
  useEffect(() => {
    if (!caption) {
      typedIdxRef.current = 0
      prevCaptionRef.current = ''
      setTypedCaption('')
      return undefined
    }
    /* A streamed reply GROWS — each finished sentence appends to the
       caption while the last one is still being typed out. Restarting from
       zero on every change (which is what this did before sentence-level
       streaming existed, when the caption only ever arrived whole) would
       re-type the whole reply from the top several times per turn. Keeping
       the cursor where it is whenever the new caption merely extends the
       old one turns that into one continuous type-out; anything that isn't
       an extension is a genuinely new utterance and starts over. */
    if (!caption.startsWith(prevCaptionRef.current)) typedIdxRef.current = 0
    prevCaptionRef.current = caption
    if (typedIdxRef.current >= caption.length) {
      setTypedCaption(caption)
      return undefined
    }
    const CHAR_MS = 42
    const id = setInterval(() => {
      typedIdxRef.current += 1
      setTypedCaption(caption.slice(0, typedIdxRef.current))
      if (typedIdxRef.current >= caption.length) clearInterval(id)
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
    typedIdxRef.current = caption.length
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

      if (!processingRef.current) {
        const now = performance.now()
        // Whether the assistant currently owns the turn — either actively
        // speaking, or still writing the reply it's about to speak.
        const holdingFloor = isSpeakingRef.current || pausedRef.current

        if (vadStateRef.current === 'recording') {
          /* Already capturing. Endpointing always uses the ORDINARY bar,
             even mid-barge-in: the strict barge-in threshold exists to
             decide whether someone started talking over the assistant, and
             reusing it here would treat every ordinary dip between words as
             the end of the sentence and cut the teacher off mid-thought. */
          if (level > SPEECH_THRESHOLD) {
            silenceStartRef.current = null
            if (now - speechStartRef.current > MAX_UTTERANCE_MS) stopRecorder()
          } else if (silenceStartRef.current == null) {
            silenceStartRef.current = now
          } else if (now - silenceStartRef.current > SILENCE_MS) {
            stopRecorder()
          }
        } else if (holdingFloor) {
          /* Idle while the assistant holds the floor: this is the barge-in
             test, and it is deliberately hard to pass. The mic is hearing a
             speaker playing the assistant's own voice a few inches away —
             echo cancellation removes most of that, and the stricter bar
             held for a sustained stretch covers the rest. A cough, a chair,
             or one leaked syllable does not get to cut the reply off. */
          if (level > BARGE_THRESHOLD) {
            if (bargeStartRef.current == null) bargeStartRef.current = now
            else if (now - bargeStartRef.current > BARGE_SUSTAIN_MS) {
              bargeStartRef.current = null
              // Silences the reply AND aborts the generation behind it,
              // then records exactly like any other utterance.
              onInterruptRef.current?.()
              beginUtterance()
            }
          } else {
            bargeStartRef.current = null
          }
        } else if (level > SPEECH_THRESHOLD) {
          // Ordinary start-of-utterance into a quiet room.
          beginUtterance()
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
      /* abortUtterance, NOT stopRecorder: stopRecorder asks the recorder to
         finish, which fires its `stop` event, which runs
         handleUtteranceReady — so ending the conversation while a sentence
         was still being captured transcribed and SUBMITTED that half-
         sentence after the panel had already closed, landing a stray turn
         in the chat the teacher had just walked away from. Aborting drops
         the audio and unhooks the handler instead. */
      abortUtterance()
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
  // Shrinks out of the way while a question is on the table: the cards are
  // what the teacher has to act on, and at full size the orb pushed them —
  // and the close button under them — past the bottom of the dialog.
  const orb = (
    <div
      className={`neo-raised neo-ring relative flex aspect-square w-full shrink-0 items-center justify-center rounded-full transition-[max-width] duration-300 ${
        questions?.length ? 'max-w-[104px]' : 'max-w-[280px]'
      }`}
    >
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

        <div className="flex min-h-0 flex-1 flex-col gap-4 px-gutter pb-2">
          {/* A quiet "it's live" cue, not the desktop's big level-reactive
              orb — on a phone the cards are the actual content; this only
              has to say the mic is on, not perform. */}
          <span
            aria-hidden="true"
            className={`mx-auto h-2.5 w-2.5 shrink-0 rounded-full transition-colors ${
              status === 'error' ? 'bg-mark' : isSpeaking ? 'bg-accent' : 'bg-ink-soft'
            } ${status === 'error' ? '' : 'animate-pulse'}`}
          />
          {/* Answering takes precedence over watching the plan build: while
              a question is on the table it IS the conversation, and on a
              phone there is no room to show both without shrinking the tap
              targets that exist to be tapped. */}
          {questions?.length ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <QuestionCards questions={questions} onAnswer={onAnswer} />
            </div>
          ) : (
            <DecisionStack decisions={decisions} />
          )}
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
      {/* A GRID with two fixed-width flanking columns, not flex siblings
          that come and go — the transcript only exists once there's a
          message and the card stack only once there's a decision, and as
          flex items, each one mounting/unmounting shifted how much space
          the center column got, which visibly shoved the orb sideways the
          moment either one appeared. Both flanks are ALWAYS present as grid
          tracks (280px each) — empty is just an empty column, not a missing
          one — so the center column, and the orb centered inside it, never
          moves regardless of what's showing on either side. */}
      <div className="grid w-full max-w-4xl grid-cols-[280px_minmax(0,1fr)_280px] items-stretch gap-4">
        <div>{messages.length ? <Transcript messages={messages} onReplay={onReplay} /> : null}</div>
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Voice conversation"
          /* overflow-y-auto, not a fixed centred stack: with a question
             card open this column carries the orb, the caption, 3-4 option
             pills and the close button, which together overrun the
             dialog's own max height on a short laptop screen — the close
             button was the part that fell off the bottom. */
          className="neo-panel flex min-w-0 flex-col items-center justify-center gap-5 overflow-y-auto rounded-[28px] bg-paper-raised p-8 text-center"
        >
          {orb}
          <p aria-live="polite" className="line-clamp-3 min-h-[1.5em] text-sm text-ink-soft">
            {displayText}
          </p>
          {/* The clarification sits under the orb, in the middle column —
              it's the live turn of the conversation, not a side panel. */}
          {questions?.length ? (
            <div className="w-full">
              <QuestionCards questions={questions} onAnswer={onAnswer} />
            </div>
          ) : null}
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
        <div className="min-h-0">
          {decisions.length ? <DecisionStack decisions={decisions} /> : null}
        </div>
      </div>
    </div>
  )
}
