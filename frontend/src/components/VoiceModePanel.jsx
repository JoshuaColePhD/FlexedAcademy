import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Play, X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { api } from '../lib/api'
import { DecisionStack } from './DecisionStack'

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

/* What it's said — not a two-sided transcript. This used to show both
 * turns, styled after the real text chat's bubbles (teacher's own line
 * pressed into a groove, assistant's bare on the panel). But the teacher
 * already knows what they just said a moment ago; what's actually hard to
 * catch in a SPOKEN conversation is the assistant's side, especially once
 * it's scrolled past and the audio is gone. So this is now a running,
 * untruncated log of assistant replies only — the answer to "wait, what did
 * it just say?" without needing Replay for anything but the very latest
 * line. Desktop only, in the left column — on a phone this is still one
 * swipe away underneath the panel, and there's no room for a second column
 * at that width anyway. */
// A question round with nothing extra to say gets the same fixed line every
// time ("A couple of quick questions to get this right:" — see ChatPage's
// onDone), which made a run of questions read as the identical bubble
// repeated over and over in this log. spokenContent (ChatPage's own
// speakableQuestions) already boils a question message down to the actual
// question text — using it here too, not just for TTS, means the log and
// the audio never disagree about what was "said."
function saidText(m) {
  if (!m.questions?.length) return m.content
  return m.spokenContent || m.questions.map((q) => q.text).join(' ')
}

function Transcript({ messages, onReplay }) {
  const said = messages.filter((m) => m.role !== 'user')
  return (
    <div className="neo-panel flex h-full flex-col overflow-hidden rounded-[28px] bg-paper-raised">
      <div className="shrink-0 px-5 py-4">
        <p className="text-sm font-semibold text-ink">What it's said</p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        {said.length ? (
          said.map((m) => (
            <div key={m.id} className="fa-rise group flex w-full flex-col items-start">
              <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-ink">{saidText(m)}</p>
              {/* Replay is voice mode's own affordance, with no text-chat
                  equivalent — kept as a quiet text-and-icon action under
                  the reply rather than the old always-visible round
                  button, so it reads as an extra on the line instead of a
                  second UI language next to it. */}
              <button
                type="button"
                onClick={() => onReplay(saidText(m))}
                aria-label="Replay this reply"
                className="mt-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-ink-muted opacity-0 transition-opacity hover:text-accent-text focus-within:opacity-100 group-hover:opacity-100"
              >
                <Play size={11} aria-hidden="true" fill="currentColor" />
                Replay
              </button>
            </div>
          ))
        ) : (
          <p className="px-1 py-3 text-sm text-ink-muted">Its replies will show up here.</p>
        )}
      </div>
    </div>
  )
}

/* The clarification cards. When the teacher says something too vague to
 * build from, the model asks one or more short questions (see the backend's
 * voice prompt) and their options land here as real, tappable buttons —
 * a SHORTCUT for answering, not a replacement for talking. The mic never
 * stops listening while these are on screen (busy only pauses it during an
 * actual generation, see VoiceModePanel's pausedRef), so saying the answer
 * out loud works exactly the same as tapping one of these; the hint below
 * the cards says so, because nothing else about a row of buttons implies
 * that on its own.
 *
 * Styled like DecisionStack (the "plan so far" column this replaces while
 * a question is on the table): same checkmark-in-a-circle language, so a
 * question mid-answer and a decision already locked in read as two states
 * of the same list, not two different components.
 *
 * Voice mode's own system prompt (backend/routes/generate.py) always asks
 * exactly ONE question at a time — the multi-question, answer-them-all-then-
 * Continue shape only exists here for whatever isn't that. So the single-
 * question case (the actual common case) skips Continue entirely: tapping
 * an option IS the answer, sent immediately. Requiring a second tap to
 * confirm a choice already made was pure friction with nothing to weigh. */
function QuestionCards({ questions, onAnswer }) {
  const [answers, setAnswers] = useState({})
  const single = questions.length === 1
  const allAnswered = questions.every((q) => answers[q.id])

  const send = (finalAnswers) => {
    const text = questions.map((q) => `${q.text} ${finalAnswers[q.id]}`).join('\n')
    onAnswer(text)
  }

  const choose = (q, opt) => {
    const next = { ...answers, [q.id]: opt }
    setAnswers(next)
    if (single) send(next)
  }

  return (
    <div className="neo-panel flex min-h-0 w-full flex-col overflow-hidden rounded-[28px] bg-paper-raised p-4">
      <p className="eyebrow shrink-0 pb-2">{single ? 'One quick question' : 'A couple of quick questions'}</p>
      <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
        {questions.map((q, i) => {
          const answered = Boolean(answers[q.id])
          return (
            <li
              key={q.id}
              style={{ animationDelay: `${i * 60}ms` }}
              className="fa-card-drop neo-raised flex shrink-0 flex-col gap-2.5 rounded-2xl bg-paper-raised px-3.5 py-3 text-left"
            >
              <div className="flex items-start gap-2.5">
                {/* Inset once answered — the same "pressed into the card"
                    mark DecisionStack uses for a settled item — raised and
                    empty while still open. */}
                <span
                  aria-hidden="true"
                  className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full transition-shadow ${
                    answered ? 'neo-inset text-accent-text' : 'neo-raised text-ink-faint'
                  }`}
                >
                  {answered ? <Check size={11} strokeWidth={3} /> : null}
                </span>
                <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-ink">{q.text}</p>
              </div>
              <div className="flex flex-wrap gap-2 pl-[30px]">
                {(q.options || []).map((opt) => {
                  const selected = answers[q.id] === opt
                  return (
                    <button
                      key={opt}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => choose(q, opt)}
                      /* Pressed-in when chosen, standing proud when not — the
                         same physical language every other selected/unselected
                         pair in this app already speaks. */
                      className={`tap-target rounded-full px-3 py-1.5 text-xs font-medium transition-shadow ${
                        selected ? 'neo-inset text-accent-text' : 'neo-raised text-ink-soft'
                      }`}
                    >
                      {opt}
                    </button>
                  )
                })}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 shrink-0 text-center text-2xs text-ink-faint">Or just say your answer</p>
      {!single ? (
        <button
          type="button"
          disabled={!allAnswered}
          onClick={() => send(answers)}
          className="neo-raised mt-2 min-h-touch shrink-0 self-start rounded-full bg-accent-tint px-5 text-sm font-medium text-accent-text transition-shadow disabled:cursor-not-allowed disabled:opacity-50"
        >
          Continue
        </button>
      ) : null}
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

  // Tapping a settled decision to fix it (DecisionStack's onRevise) is a
  // typed version of saying the correction out loud — same destination
  // (ChatPage's submit, via onUtterance) as a finished spoken utterance, just
  // skipping the mic. No ref needed here: this only ever fires from a click
  // handler in the render below, not from the mic loop's persistent effect.
  const reviseDecision = (label, value) => onUtterance(`Change ${label.toLowerCase()} to ${value}.`)

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
  // in the effect above) glowing inside it. Used to shrink while a question
  // was on the table, because the cards used to live in this same column,
  // underneath it. Now that they live in the side column instead (see
  // QuestionCards' own comment), the orb has nothing left to make room for
  // and stays full size regardless.
  const orb = (
    <div className="neo-raised neo-ring relative flex aspect-square w-full max-w-[280px] shrink-0 items-center justify-center rounded-full">
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
            <DecisionStack decisions={decisions} fill={false} onRevise={reviseDecision} />
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
      className="neo-world dialog-scrim flex flex-col items-center gap-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* A GRID with two fixed-width flanking columns, not flex siblings
          that come and go. This used to mount/unmount the flanking cards
          themselves too — Transcript only once there was a message,
          DecisionStack only once there was a decision — so the whole
          dialog visibly popped and resized as the conversation went, on
          top of the column tracks already being fixed. All three boxes are
          now permanent from the moment the panel opens: Transcript and
          DecisionStack already have their own "nothing yet" copy for an
          empty list (see each component), so there's always something
          real to show in an empty box rather than an empty box appearing
          from nothing. */}
      <div className="grid w-full max-w-4xl grid-cols-[280px_minmax(0,1fr)_280px] items-stretch gap-4">
        <Transcript messages={messages} onReplay={onReplay} />
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Voice conversation"
          className="neo-panel flex min-w-0 flex-col items-center justify-center gap-5 rounded-[28px] bg-paper-raised p-8 text-center"
        >
          {orb}
          {/* A FIXED height, not a max — a growing-then-shrinking caption
              was the other half of the "ebb and flow" complaint alongside
              the boxes that came and went: the orb crept up and down as
              the line below it gained and lost lines while typing out.
              Fixed height + scroll means this spot never moves regardless
              of how much (or how little) the current line has to say.

              h-48 and text-base, not the original h-28/text-sm: the orb
              stays full size (it's staying, on request), so the room this
              needs has to come from actually being bigger, not from
              shrinking anything else — a cramped scroll box was the whole
              complaint. Bigger text for the same reason: legible while
              it's actively typing out, not just technically present. */}
          <p
            aria-live="polite"
            className="h-48 w-full overflow-y-auto text-base leading-relaxed text-ink-soft"
          >
            {displayText}
          </p>
        </div>
        {/* The side column: a pending clarification takes over the same
            slot "the plan so far" normally holds — while a question is on
            the table, what to answer next IS the working state, same as a
            decision already locked in is once it's settled. Checking each
            question off as it's answered (see QuestionCards) is what makes
            this readable as a to-do list rather than a form dropped on top
            of the conversation. DecisionStack, not null, is the default —
            same reasoning as Transcript above. */}
        {questions?.length ? (
          <QuestionCards questions={questions} onAnswer={onAnswer} />
        ) : (
          <DecisionStack decisions={decisions} onRevise={reviseDecision} />
        )}
      </div>
      {/* A labeled control below all three panels, not an icon pinned to a
         corner of one of them — the close button used to live inside the
         orb's own card (first absolute in a corner, before that stacked
         under the caption), which made it read as part of that card
         specifically rather than a control for the whole conversation.
         Clicking the scrim or pressing Escape (useFocusTrap below) both
         still close it too; this is the discoverable, labeled way to. */}
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="neo-raised tap-target flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-ink-soft"
      >
        <X size={15} aria-hidden="true" />
        End conversation
      </button>
    </div>
  )
}
