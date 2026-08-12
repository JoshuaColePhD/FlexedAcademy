import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Download,
  FileText,
  Keyboard,
  Loader2,
  Mic,
  MicOff,
  Play,
  RotateCcw,
} from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { api } from '../lib/api'
import { DecisionStack } from './DecisionStack'
import { WeekStrip } from './WeekStrip'

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

/* The gap SPEECH_THRESHOLD alone leaves: a level that never crosses it reads
   identically whether the room is silent or someone's talking too quietly
   to trip it — "the mic isn't working" and "you're just a bit too quiet"
   look the same with nothing but silence either way. This band catches the
   second case specifically: real signal (above room-noise) that still never
   clears the bar, held long enough that it's a pattern and not one soft
   word. */
const QUIET_FLOOR = 0.02
const QUIET_HINT_MS = 2500
// How many finished-but-unusable utterances (transcribe failed, or came back
// empty) in a row before saying so — one miss is normal noise; a second one
// right after is the point a teacher would otherwise just keep repeating
// themselves into silence with no idea why nothing's landing.
const MISS_HINT_COUNT = 2

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
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          What it's said
        </p>
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

/* "Making it," the half of the request BuiltPlanCard below doesn't cover —
 * that one only answers "did it finish," and until now there was nothing
 * between the mic panel and a generic "Thinking…" label for however long
 * the model actually spends writing five days. WeekStrip's own writing+loose
 * form already does exactly this in the text chat (see ChatPage's identical
 * usage next to the composer) — reused here rather than re-invented, so a
 * teacher who's used both surfaces recognizes the same progress read in
 * either one. Takes over whichever slot would otherwise hold the transcript
 * (desktop) or the decisions list (phone) while actually streaming; once
 * `builtPlan` lands, BuiltPlanCard takes over from there. */
function BuildProgress({ days, fill = true }) {
  return (
    <div
      className={`neo-panel flex w-full flex-col gap-3 rounded-[28px] bg-paper-raised p-4 ${
        fill ? 'h-full justify-center' : ''
      }`}
    >
      <p className="flex shrink-0 items-center gap-2 text-sm font-semibold text-ink">
        <Loader2 size={14} className="animate-spin text-accent-text" aria-hidden="true" />
        Building your week
      </p>
      <WeekStrip days={days} writing loose className="w-full" />
    </div>
  )
}

/* The side column's third state, once a week actually exists — after that,
 * "the plan so far" (DecisionStack) is stale news; the teacher already knows
 * it built, or should. This is a persistent, visual answer to "did that
 * work?" that doesn't depend on catching a spoken line the moment it plays
 * — see ChatPage's own auto-speak effect, which already queues "Built
 * {week}. Tell me what to change and I'll revise it." through the TTS the
 * instant the plan lands, but a sentence spoken once and gone is easy to
 * miss entirely if the room is noisy or attention was elsewhere. This card
 * stays up for as long as the conversation does. */
function BuiltPlanCard({ builtPlan, fill = true }) {
  return (
    <div
      className={`neo-panel flex w-full flex-col items-start gap-3 rounded-[28px] bg-paper-raised p-4 ${
        fill ? 'h-full justify-center' : ''
      }`}
    >
      <span
        aria-hidden="true"
        className="neo-inset grid h-9 w-9 shrink-0 place-items-center rounded-full text-accent-text"
      >
        <Check size={16} strokeWidth={3} />
      </span>
      <div>
        <p className="eyebrow pb-1">Built</p>
        <p className="fa-rise text-sm font-medium leading-snug text-ink">
          {builtPlan.weekLabel || 'This week'}
        </p>
      </div>
      <a
        href={api.planDownloadUrl(builtPlan.planId)}
        download
        className="neo-raised tap-target flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium text-accent-text transition-shadow"
      >
        <Download size={12} aria-hidden="true" />
        Download
      </a>
      <p className="flex items-start gap-1.5 text-xs leading-snug text-ink-faint">
        <FileText size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
        Say what to change and I'll revise it.
      </p>
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
  // Non-null once a week has actually been built — see BuiltPlanCard, which
  // takes over the side column from DecisionStack the moment this is set.
  builtPlan = null,
  // True while a week is actually being generated (ChatPage's stream.
  // isStreaming) — see BuildProgress, which takes over the transcript
  // (desktop) or decisions (phone) slot for as long as this holds.
  building = false,
  // The plan's own day objects as they arrive mid-stream — ChatPage's
  // stream.preview?.days, the exact same value the text chat's identical
  // WeekStrip usage reads from.
  buildDays = null,
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
  // Two distinct "something's off" nudges, both surfaced through the status
  // pill (see `label` below) rather than the caption — they're about the
  // PIPELINE, not something said, and the caption is reserved for that.
  // missHint: consecutive attempts that produced nothing usable.
  // quietHint: real signal that never once cleared SPEECH_THRESHOLD.
  // Only one shows at a time (missHint wins — see `label`), so there's no
  // need to track them as mutually exclusive here, just independently.
  const [missHint, setMissHint] = useState(false)
  const [quietHint, setQuietHint] = useState(false)
  const missCountRef = useRef(0)
  const quietStartRef = useRef(null)
  const quietHintShownRef = useRef(false)
  /* Whether the recorder is capturing RIGHT NOW. The VAD already tracked
     this in vadStateRef, but a ref doesn't re-render — so the panel spent
     every utterance still saying "Listening…", with the orb's volume
     reaction as the only sign anything was being captured at all. That's
     ambient, not confirmation: it says "the mic is on," never "I've got
     you, keep going," which is the one thing you want to know mid-sentence. */
  const [hearing, setHearing] = useState(false)
  /* What the last utterance actually transcribed to. The transcript column
     is assistant-replies-only by design, so a mis-hear ("week seven" →
     "week eleven") was invisible until the reply came back answering the
     wrong question — a whole wasted turn before you could even tell
     something went wrong. Echoing it back for a few seconds is the input
     half of the same "nothing is silently wrong" promise the rest of this
     product makes about its output. */
  const [heardText, setHeardText] = useState('')
  /* Teacher-controlled mic pause — distinct from pausedRef, which is the
     PIPELINE pausing itself while busy. Without this, a student walking up
     mid-conversation meant ending the whole thing; the mic was live from
     open to close with no way to hold it. */
  const [muted, setMuted] = useState(false)
  const mutedRef = useRef(false)
  // Bumped by "Try again" in the error state — it's the mic-setup effect's
  // only dependency, so changing it re-runs teardown + setup, which is
  // exactly what retrying permission means. Previously the error state was
  // a dead end: fix it in browser settings, then reopen the panel yourself.
  const [retryToken, setRetryToken] = useState(0)
  // Set the moment a barge-in actually fires, cleared shortly after — the
  // interrupt worked silently before, so talking over the assistant felt
  // like it might not have registered.
  const [justInterrupted, setJustInterrupted] = useState(false)
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

  // Neither hint has any OTHER path back to false if the teacher just gives
  // up rather than resolving it (speaking up, or landing a real utterance —
  // see tick()/handleUtteranceReady, which clear these the moment either
  // actually happens). Without this they'd sit there claiming "still having
  // trouble" indefinitely once true, long after it stopped being current.
  useEffect(() => {
    if (!missHint) return undefined
    const t = setTimeout(() => setMissHint(false), 6000)
    return () => clearTimeout(t)
  }, [missHint])
  useEffect(() => {
    if (!quietHint) return undefined
    const t = setTimeout(() => {
      setQuietHint(false)
      quietHintShownRef.current = false
    }, 6000)
    return () => clearTimeout(t)
  }, [quietHint])

  // The heard-back echo is a CHECK, not a log — it exists for the few
  // seconds between "you finished saying it" and "the reply starts," which
  // is the whole window in which noticing a mis-hear is still useful.
  // Whichever comes first clears it: the reply starting, or this timeout.
  useEffect(() => {
    if (!heardText) return undefined
    const t = setTimeout(() => setHeardText(''), 5000)
    return () => clearTimeout(t)
  }, [heardText])
  useEffect(() => {
    if (isSpeaking || caption) setHeardText('')
  }, [isSpeaking, caption])

  useEffect(() => {
    if (!justInterrupted) return undefined
    const t = setTimeout(() => setJustInterrupted(false), 1600)
    return () => clearTimeout(t)
  }, [justInterrupted])

  /* Really mutes, rather than just ignoring the level: track.enabled =
     false makes the browser itself deliver silence, so "off" is off at the
     source and not a promise this component is making on its own. Anything
     mid-capture is dropped rather than sent — a half sentence cut off by
     hitting mute is not something the teacher meant to submit. */
  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    mutedRef.current = next
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next
    })
    if (next) {
      abortUtterance()
      quietStartRef.current = null
    }
  }

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
    setHearing(false)
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
    setHearing(true)
  }

  const handleUtteranceReady = async () => {
    const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current })
    chunksRef.current = []
    const started = speechStartRef.current
    vadStateRef.current = 'idle'
    speechStartRef.current = null
    silenceStartRef.current = null
    setHearing(false)
    // Too short to be real speech — a cough, a tap, a bump of the table.
    if (!started || performance.now() - started < MIN_UTTERANCE_MS || blob.size === 0) return
    processingRef.current = true
    setStatus('transcribing')
    try {
      const { text } = await api.transcribe(blob)
      if (text && text.trim()) {
        missCountRef.current = 0
        setMissHint(false)
        // Shown back in the caption box for a few seconds (see heardText's
        // own comment) so a mis-hear is catchable BEFORE the reply arrives.
        setHeardText(text.trim())
        onUtteranceRef.current(text.trim())
      } else {
        // Transcribed successfully but got nothing usable back (Whisper
        // heard only noise/silence in what still passed the length check
        // above) — same "did that actually land" gap as a thrown error,
        // just without one.
        missCountRef.current += 1
        if (missCountRef.current >= MISS_HINT_COUNT) setMissHint(true)
      }
    } catch {
      // A missed utterance used to just mean "say it again" with nothing
      // shown for it — fine once, but a SECOND miss right after is the
      // point a teacher would otherwise keep repeating themselves with no
      // idea whether the mic even heard anything at all.
      missCountRef.current += 1
      if (missCountRef.current >= MISS_HINT_COUNT) setMissHint(true)
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
      // Was 0.22 — the outer layers' own pulse range was small enough next
      // to their low alpha (below) that the whole orb read as barely
      // reactive, not just faint.
      const extra = Math.min(width, height) * 0.3
      // Muted reads the same as paused here on purpose — both mean "your
      // voice is not going anywhere right now," and that's the one thing
      // the orb has to be honest about. (The label distinguishes them.)
      const damped = pausedRef.current || mutedRef.current
      const effectiveLevel = damped ? 0.05 : Math.max(0.05, level)
      const rgb = damped ? '150 150 150' : resolvedAccentRgb
      // Outer two layers' alpha raised (0.16→0.28, 0.28→0.44) — at the old
      // values they mostly disappeared into the page background, leaving
      // only the small solid core layer actually visible, which read as
      // one weak dot rather than a set of rings.
      const layers = [
        { mult: 1, alpha: 0.28 },
        { mult: 0.7, alpha: 0.44 },
        { mult: 0.42, alpha: 0.9 },
      ]
      for (const { mult, alpha } of layers) {
        const r = base * mult + extra * mult * effectiveLevel
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fillStyle = `rgb(${rgb} / ${alpha})`
        ctx.fill()
      }
      // A crisp stroked edge on the outermost layer only — the fills alone
      // still fade to nothing at their own boundary, which is soft by
      // design for the inner glow but left the whole orb without a single
      // defined edge to actually read as a "ring."
      const outer = layers[0]
      const outerR = base * outer.mult + extra * outer.mult * effectiveLevel
      ctx.beginPath()
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgb(${rgb} / 0.5)`
      ctx.lineWidth = 1.5
      ctx.stroke()
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

      // Muted: the orb keeps drawing (damped, above) so the panel doesn't
      // look frozen, but nothing below this line runs — no endpointing, no
      // barge-in, no quiet-hint accumulation. The track is already
      // delivering silence (see toggleMute), this just stops the VAD from
      // reasoning about it at all.
      if (!processingRef.current && !mutedRef.current) {
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
              // Cutting the assistant off used to happen in total silence —
              // the reply just stopped, which is as consistent with "it
              // finished" or "it broke" as with "you interrupted it." A
              // brief acknowledgement is what makes it read as deliberate.
              setJustInterrupted(true)
              beginUtterance()
            }
          } else {
            bargeStartRef.current = null
          }
        } else if (level > SPEECH_THRESHOLD) {
          // Ordinary start-of-utterance into a quiet room.
          quietStartRef.current = null
          if (quietHintShownRef.current) {
            quietHintShownRef.current = false
            setQuietHint(false)
          }
          beginUtterance()
        } else if (level > QUIET_FLOOR) {
          // Real signal (someone talking, just not loud enough), sustained —
          // one soft word doesn't warrant a nudge, a whole pattern of them
          // does.
          if (quietStartRef.current == null) quietStartRef.current = now
          else if (!quietHintShownRef.current && now - quietStartRef.current > QUIET_HINT_MS) {
            quietHintShownRef.current = true
            setQuietHint(true)
          }
        } else {
          // True silence — not the same signal as "trying and too quiet,"
          // so it doesn't accumulate toward the hint at all.
          quietStartRef.current = null
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    /* iOS Safari suspends an AudioContext outright when the tab is
       backgrounded (app-switched away from, screen locked) — coming back
       doesn't resume it on its own, which reads as the panel having frozen:
       the orb stops animating and the mic stops hearing anything, silently,
       because tick()'s analyser is reading a suspended (silent) context. */
    const onVisible = () => {
      if (document.visibilityState === 'visible' && audioCtxRef.current?.state === 'suspended') {
        audioCtxRef.current.resume().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)

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
        /* iOS Safari starts an AudioContext created outside the SYNCHRONOUS
           call stack of a user gesture in "suspended" state — and the await
           on getUserMedia just above means construction here never counts,
           gesture or not. A suspended context still returns silence/zeros
           from the analyser, not an error, so the VAD's level never crosses
           SPEECH_THRESHOLD and the mic reads as "not picking anything up"
           with no error surfaced anywhere — exactly what iPhone reports and
           desktop Chrome doesn't (Chrome doesn't enforce this as strictly).
           resume() is safe to call even when already running. */
        if (ctx.state === 'suspended') ctx.resume().catch(() => {})
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
      document.removeEventListener('visibilitychange', onVisible)
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
    // retryToken, not [] — the whole body of this effect IS "set the mic
    // up," and its cleanup above already tears every piece of it back down,
    // so re-running it is exactly what "Try again" has to mean. Still
    // mount-once in practice: nothing bumps the token but that button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken])

  /* Re-request the mic from scratch. Resets the state the failed attempt
     left behind first, so a second failure re-renders as a fresh error
     rather than looking like the old one never cleared. */
  const retryMic = () => {
    setErrorMessage(null)
    setStatus('requesting-mic')
    setMuted(false)
    mutedRef.current = false
    setRetryToken((n) => n + 1)
  }

  /* Ordered by immediacy, not by pipeline stage: whatever is truest about
     THIS instant wins. So the teacher's own mic state (off, being heard)
     outranks whatever the assistant happens to be doing in the background —
     during a barge-in or a build both are true at once, and "Hearing you"
     is the half that's actually about them.

     missHint and quietHint sit at the bottom, applying only to the plain
     "listening, nothing else going on" state: every branch above them means
     something is actively happening that already explains the pill, and a
     stale hint from three turns ago has no business outranking it. */
  const label =
    status === 'requesting-mic'
      ? 'Asking for microphone access…'
      : status === 'error'
        ? errorMessage
        : muted
          ? 'Mic off'
          : justInterrupted
            ? 'Go ahead'
            : hearing
              ? 'Hearing you…'
              : status === 'transcribing'
                ? 'Got it — one sec…'
                : building
                  ? 'Building your week…'
                  : busy
                    ? 'Thinking…'
                    : isSpeaking
                      ? 'Speaking…'
                      : missHint
                        ? "Didn't catch that — try again"
                        : quietHint
                          ? 'Having trouble hearing you — try speaking up'
                          : 'Listening…'

  /* The caption area holds CONTENT — words that were said, by either side —
     and the pill holds STATUS. They used to share: the caption fell back to
     `label` whenever there was no caption, so "Listening…" rendered twice
     on screen at once (pill and caption) for most of every conversation,
     and a screen reader announced the same string from two live regions.
     Now the caption goes quiet when there's nothing said to show, and the
     pill is the single place status lives. */
  const spokenText = typedCaption || ''
  const showHeard = !spokenText && Boolean(heardText)
  // captionBlock below is a JSX element either way — always truthy — so
  // "is there actually anything in it" has to be its own test. The phone
  // reads this to decide whether to render its container at all, rather
  // than docking an empty card between turns.
  const hasCaption = status === 'error' || Boolean(spokenText) || showHeard || Boolean(isSpeaking)

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
      {/* A slow highlight chasing the ring's own edge — the level-driven
          canvas above already answers "is it hearing volume," this answers
          "is it alive" independent of that, the same way a spinner keeps
          moving even mid-silence. Purely decorative (aria-hidden), and
          collapses under the app's global prefers-reduced-motion rule like
          every other animation here. */}
      <div className="voice-orb-sheen" aria-hidden="true" />
    </div>
  )

  /* The one place status lives, on BOTH layouts now — the phone used to
     have only a bare pulsing dot here (mic on/off and nothing else) and
     leaned on its docked bar to carry status text, which is why that bar
     could never be given over to actual content the way the desktop
     caption box could.

     aria-live sits here rather than on the caption: this is the region
     whose changes are worth announcing on their own ("Hearing you",
     "Mic off"), and it no longer duplicates the caption's text. */
  const statusPill = (
    <span
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-2xs font-semibold uppercase tracking-caps transition-colors ${
        status === 'error'
          ? 'bg-mark-tint text-mark'
          : muted
            ? 'bg-paper-sunken text-ink-muted'
            : 'bg-accent-tint text-accent-text'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${
          status === 'error' ? 'bg-mark' : muted ? 'bg-ink-faint' : 'bg-accent'
        } ${status === 'error' || muted ? '' : 'animate-pulse'}`}
      />
      {label}
    </span>
  )

  /* Hold the mic without ending the conversation — a student walks up, a
     colleague asks something, and the only previous option was to close the
     whole panel. Pressed-in while muted, the same physical language every
     other on/off pair in this app speaks. */
  const muteButton = (
    <button
      type="button"
      onClick={toggleMute}
      disabled={status === 'error'}
      aria-pressed={muted}
      aria-label={muted ? 'Turn the microphone back on' : 'Turn the microphone off'}
      className={`tap-target flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-shadow disabled:cursor-not-allowed disabled:opacity-40 ${
        muted ? 'neo-inset text-accent-text' : 'neo-raised text-ink-soft'
      }`}
    >
      {muted ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
      {muted ? 'Unmute' : 'Mute'}
    </button>
  )

  /* What was actually SAID, either side of the conversation — never status
     (that's statusPill's job now; see spokenText's comment). Three states,
     in order: the assistant's reply typing itself out, the echo of what was
     just heard from the teacher, or the error state's own recovery path. */
  const captionBlock =
    status === 'error' ? (
      <div className="flex flex-col items-center gap-3">
        <p className="text-base leading-relaxed text-mark">{errorMessage}</p>
        {/* The error used to be terminal — the message named the fix
            (browser settings) but left no way to act on it, so the only
            route back was closing and reopening the panel. */}
        <button
          type="button"
          onClick={retryMic}
          className="neo-raised tap-target flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-accent-text transition-shadow"
        >
          <RotateCcw size={14} aria-hidden="true" />
          Try again
        </button>
      </div>
    ) : (
      <>
        {spokenText ? (
          <p className="text-base leading-relaxed text-ink-soft">{spokenText}</p>
        ) : showHeard ? (
          <p className="fa-rise text-base leading-relaxed text-ink-muted">
            <span className="eyebrow mr-2 not-italic">You said</span>
            <span className="italic">“{heardText}”</span>
          </p>
        ) : null}
        {/* Barge-in is real but was never advertised — nothing on screen
            suggested talking over a reply would do anything but collide
            with it. Sits BELOW whatever is being said rather than instead
            of it: while the assistant speaks there's almost always caption
            text in the slot above, so an either/or would have meant this
            tip effectively never rendered at the one moment it's
            actionable. */}
        {isSpeaking ? <p className="text-sm text-ink-faint">Talk any time to cut in.</p> : null}
      </>
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
            // Matches the labeled control above the docked bar rather than
            // the old "End voice conversation" — same action, and nothing
            // about it ends the conversation.
            aria-label="Back to typing"
            className="neo-raised tap-target flex h-10 w-10 items-center justify-center rounded-full text-ink-soft"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 px-gutter pb-2">
          {/* Was a bare pulsing dot that could only say "the mic is on" —
              the same statusPill the desktop uses now, so a phone gets the
              real state (hearing you, mic off, building) rather than the
              one bit it had before. */}
          <div className="flex shrink-0 justify-center">{statusPill}</div>
          {/* Answering takes precedence over watching the plan build: while
              a question is on the table it IS the conversation, and on a
              phone there is no room to show both without shrinking the tap
              targets that exist to be tapped. */}
          {questions?.length ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <QuestionCards questions={questions} onAnswer={onAnswer} />
            </div>
          ) : building ? (
            <BuildProgress days={buildDays} fill={false} />
          ) : builtPlan ? (
            <BuiltPlanCard builtPlan={builtPlan} fill={false} />
          ) : (
            <DecisionStack decisions={decisions} fill={false} onRevise={reviseDecision} />
          )}
        </div>

        {/* The reference's docked mini-player bar. Carries CONTENT now
            (what was said, either side) rather than status — the pill above
            took that over, which is what freed this bar up for the
            heard-back echo it never had room for before. */}
        <div className="shrink-0 space-y-3 px-gutter pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {hasCaption ? (
            <div
              aria-live="polite"
              className="neo-panel flex max-h-32 flex-col items-center gap-2 overflow-y-auto rounded-[28px] bg-paper-raised px-5 py-3 text-center"
            >
              {captionBlock}
            </div>
          ) : null}
          <div className="flex items-center justify-center gap-3">
            {muteButton}
            {/* One labeled control, not the bare X this used to be alongside
                a separate "Type instead" link — they both called onClose,
                so the pair only ever posed a difference that didn't exist.
                This is the honest description of the single action: the
                conversation continues, typed. (The header's back arrow
                stays as ordinary phone navigation.) */}
            <button
              type="button"
              onClick={onClose}
              className="neo-raised tap-target flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-ink-soft"
            >
              <Keyboard size={15} aria-hidden="true" />
              Type instead
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
      <div className="relative w-full max-w-4xl">
        {/* A literal thread running behind all three cards, only visible in
            the gaps between them (the cards' own opaque backgrounds cover
            the rest) — the same "several things resolving to one" motif
            the landing page's proof/mechanism sections use, here saying
            "these three boxes are one conversation," not three unrelated
            panels that happen to share a row. */}
        <div aria-hidden="true" className="voice-thread pointer-events-none absolute inset-x-8 top-1/2 hidden -translate-y-1/2 md:block" />
        <div className="grid w-full grid-cols-[280px_minmax(0,1fr)_280px] items-stretch gap-4">
          {/* Building takes over the transcript's own slot rather than
              stacking above/below it — the transcript is a log of what's
              ALREADY been said, and there's nothing new to log while the
              model is silently writing five days; showing both at once
              would just be an idle box next to a busy one. */}
          {building ? (
            <BuildProgress days={buildDays} />
          ) : (
            <Transcript messages={messages} onReplay={onReplay} />
          )}
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Voice conversation"
            className="neo-panel flex min-w-0 flex-col items-center justify-center gap-5 rounded-[28px] bg-paper-raised p-8 text-center"
          >
            {statusPill}
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
                it's actively typing out, not just technically present.

                It legitimately renders EMPTY between turns now, where it
                used to fall back to the status text the pill above already
                shows. That's the point: the reserved height keeps the orb
                from moving, and silence here means nothing is being said
                rather than the panel having nothing to report. */}
            <div
              aria-live="polite"
              className="flex h-48 w-full flex-col items-center gap-3 overflow-y-auto"
            >
              {captionBlock}
            </div>
          </div>
          {/* The side column: a pending clarification takes over the same
              slot "the plan so far" normally holds — while a question is on
              the table, what to answer next IS the working state, same as a
              decision already locked in is once it's settled. Checking each
              question off as it's answered (see QuestionCards) is what makes
              this readable as a to-do list rather than a form dropped on top
              of the conversation. Once a week actually exists, BuiltPlanCard
              takes over instead — "the plan so far" is stale news once
              there's an actual plan. DecisionStack, not null, is the
              fallback default — same reasoning as Transcript above. */}
          {questions?.length ? (
            <QuestionCards questions={questions} onAnswer={onAnswer} />
          ) : builtPlan ? (
            <BuiltPlanCard builtPlan={builtPlan} />
          ) : (
            <DecisionStack decisions={decisions} onRevise={reviseDecision} />
          )}
        </div>
      </div>
      {/* Controls for the whole conversation, below all three panels rather
         than pinned inside the orb's own card — the close button used to
         live in that card (first absolute in a corner, before that stacked
         under the caption), which made it read as belonging to that panel
         specifically instead of to the conversation.

         ONE close control, not the two that briefly sat here: "End
         conversation" and "Type instead" both called onClose, so the pair
         posed a distinction that didn't exist and left you guessing which
         one lost your work. Neither does — closing returns to the same
         chat with its history intact — so the surviving label is the one
         that says so. Clicking the scrim or pressing Escape (useFocusTrap)
         still close it too; this is the discoverable, labeled way. */}
      <div className="flex items-center gap-3">
        {muteButton}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="neo-raised tap-target flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-ink-soft"
        >
          <Keyboard size={15} aria-hidden="true" />
          Type instead
        </button>
      </div>
    </div>
  )
}
