import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Check,
  Download,
  FileText,
  Hand,
  Loader2,
  Mic,
  MicOff,
  Pencil,
  Play,
  Radio,
  RotateCcw,
  X,
} from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { api } from '../lib/api'
/* ?url, not a normal import: an AudioWorkletProcessor is constructed by the
   browser in a scope with no module loader, so addModule needs a real URL and
   the file must NOT be inlined into the app bundle. Vite emits it as an asset
   and hands back the hashed path. */
import micWorkletUrl from '../lib/micCaptureWorklet.js?url'
import { encodeWav } from '../lib/wav'
import { createSileroDetector, SPEECH_ON, SPEECH_OFF } from '../lib/sileroVad'
import * as metrics from '../lib/voiceMetrics'
import { splitDecisions } from '../lib/decisionChecklist'
import { DecisionStack } from './DecisionStack'
import { WeekStrip } from './WeekStrip'

/* Animates this slot's height between whatever its contents happen to be —
 * the checklist, a question card, build progress, the finished-plan card.
 *
 * The measurement runs in a layout effect, not in a requestAnimationFrame
 * inside the ResizeObserver callback. That ordering was the bug: RO fires
 * AFTER paint, so every swap of children rendered one frame at the new size
 * before the height transition had started — a visible jump, then a settle
 * back into the animation. Measuring synchronously before the browser paints
 * means the container is already at the right height for frame one.
 *
 * The RO stays, for content that resizes without React re-rendering (a
 * decision label wrapping to two lines as the window narrows).
 */
function SmoothHeight({ children }) {
  const contentRef = useRef(null)
  const [height, setHeight] = useState(null)

  // useLayoutEffect: runs after DOM mutation, before paint. Re-runs on every
  // children change, which is exactly when a slot swap happens.
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return undefined
    const measure = () => {
      const next = el.getBoundingClientRect().height
      setHeight((prev) => (prev !== null && Math.abs(prev - next) < 0.5 ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children])

  return (
    <div
      style={{
        // null on the very first render only — 'auto' there so the panel opens
        // at its natural size instead of animating up from zero.
        height: height === null ? 'auto' : `${height}px`,
        transition: 'height 260ms cubic-bezier(0.4, 0, 0.2, 1)',
        overflow: 'hidden',
      }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  )
}

/* Live voice mode — the thing the "Chat" control opens now, instead of
 * quietly toggling whether replies get read aloud.
 *
 * Always-on, not push-to-talk: this panel listens continuously and decides
 * for itself when a sentence is finished, the same shape as ChatGPT's own
 * voice mode. Whisper transcribes each finished utterance — not the browser's
 * SpeechRecognition API, which is Chrome/Google-cloud-only in practice and
 * unreliable on iOS Safari, exactly the platform this app's screenshots keep
 * coming from.
 *
 * CAPTURE IS CONTINUOUS, and this is the important structural fact about the
 * file. An AudioWorklet (lib/micCaptureWorklet.js) streams 32ms frames of
 * 16kHz mono into a rolling buffer for as long as the panel is open, and an
 * "utterance" is a WINDOW cut out of that history — starting PREROLL_MS before
 * the detector noticed anything. The previous design started a MediaRecorder
 * when the level crossed a threshold, which meant the front of every utterance
 * was already gone by the time recording began (an energy gate always trips
 * after voicing starts, and unvoiced onsets barely register at all), so Whisper
 * received "ixty" and confidently returned a word that was never said.
 *
 * The loop, per utterance:
 *   frames arriving → (level clears an adaptive bar) → mark the window open →
 *   (silence long enough, judged against two timers and a hard cap) → cut the
 *   window WITH its pre-roll → encode WAV → transcribe → onUtterance(text).
 *
 * The detector runs on the worklet's frame cadence, not requestAnimationFrame:
 * rAF stops on a backgrounded tab, which used to leave the mic live and nothing
 * listening. rAF now only draws the level meter, which is work that should
 * stop when nobody can see it.
 *
 * Recording during a reply is a genuinely different state from being paused —
 * the mic stays live while the assistant talks so barge-in can work at all,
 * with a stricter threshold and AEC-convergence guards to stop the reply
 * interrupting itself through the speaker.
 *
 * Docked, not a takeover: this used to be a phone-first full-screen overlay
 * and a centered desktop dialog with a scrim — a different screen entirely
 * from the chat underneath it. It's now a panel that grows out of the chat
 * box itself, right above the composer (see ChatPage's voice-dock wrapper),
 * so the conversation it's about stays on screen the whole time. What was
 * said either side lives in the ordinary message list behind/above this
 * panel now (utterances land there the same way a typed turn does), which
 * is what freed this component up to drop its own transcript column
 * entirely — it only needs to carry what the chat itself doesn't: mic
 * state, the live caption of whatever's currently being spoken, and the
 * running checklist.
 *
 * Rendered in the .neo-world world (base.css) — soft embossed "neomorphic"
 * surfaces on request, matching the reference images directly rather than
 * translating them into this app's normal flat, high-contrast look. That
 * tradeoff (faint edges, low contrast) is real and is scoped to this one
 * opt-in panel on purpose — see .neo-world's own comment for why it's fine
 * here and would not be fine as a default anywhere else in the app.
 */

/* ── the detector's thresholds, relative to the room rather than absolute ───
 *
 * These used to be flat numbers against full scale: speech at 0.06, barge-in at
 * 0.13. That's 20·log₁₀(0.13/0.06) = 6.7 dB of total working range, which is
 * less than the ~10 dB difference between talking at 30cm and talking at arm's
 * length, never mind the 25-30 dB spread between a quiet room and a noisy one.
 * A single absolute pair genuinely cannot both catch a soft speaker and reject
 * a laptop fan.
 *
 * Worse, the floor moves underneath a fixed gate: getUserMedia is asked for
 * autoGainControl (below, and rightly — it helps Whisper), and AGC only holds
 * gain steady while its own detector hears speech. During pauses it ramps up,
 * so the measured RMS of SILENCE climbs over the course of a turn and a fixed
 * threshold starts tripping on nothing at all.
 *
 * So the thresholds are now multiples of a continuously-estimated noise floor
 * (see noiseFloorRef in tick()), with absolute floors underneath so a
 * pathologically silent input can't drive them to zero. This is the standard
 * adaptive formulation and it costs nothing: one exponential average per frame.
 *
 * Note what this does NOT fix: RMS energy still knows only the LEVEL of the
 * signal, never what kind of signal it is. A controlled comparison puts energy
 * detection at 0.11 MCC against Silero's 0.72 — near chance — and adding a
 * second threshold measurably fails to rescue it. Making it relative removes
 * the device-and-room fragility, which is the part that was making this feel
 * broken; replacing it with Silero (@ricky0123/vad-web is a drop-in for React)
 * is the real ceiling and a bigger change than this one.
 */
const SPEECH_FLOOR_MULT = 2.8
const SPEECH_FLOOR_MIN = 0.022
const BARGE_FLOOR_MULT = 5.0
const BARGE_FLOOR_MIN = 0.075
// How fast the floor estimate tracks. Slow to rise, quick to fall: a rising
// estimate that chases speech would climb into it and go deaf, whereas
// following the room down as it quietens is always safe.
const FLOOR_ATTACK = 0.002
const FLOOR_DECAY = 0.05

/* TWO endpointing timers, not one. Every production stack uses a pair, and the
   reason is that a single value has two incompatible jobs: it has to be short
   enough that "yes" doesn't sit in dead air, and long enough that "the theme
   is… uh… isolation" isn't cut in half. One number cannot be both, and 620ms
   was the compromise that was slightly wrong in both directions.

   SILENCE_MS is now the floor — the pause after which an utterance that looks
   COMPLETE is closed. SILENCE_MS_OPEN is the longer grace given to one that
   looks unfinished, judged by the crudest useful proxy available on the client:
   whether the speaker's pitch/energy trailed off into a pause or stopped flat.
   We don't have a semantic model here, so the proxy is duration — a very short
   burst is far more likely to be a fragment ("week seven—") than a finished
   turn, and gets the longer grace. MAX_SILENCE_MS is the guillotine, so this is
   never WORSE than the old single timeout no matter what the heuristic thinks.

   440ms rather than 620: OpenAI's server VAD defaults to 500ms, LiveKit to
   300-550ms, Pipecat to 200ms with a semantic model behind it. 620 was above
   all of them, and every millisecond of it was silence the teacher sat in. */
const SILENCE_MS = 440
const SILENCE_MS_OPEN = 900
const MAX_SILENCE_MS = 1500
const SHORT_UTTERANCE_MS = 1200
const MIN_UTTERANCE_MS = 300
const MAX_UTTERANCE_MS = 30_000

/* Pre-roll. The single most mechanical bug in the old detector: the recorder
   was CREATED and started only once the level had already crossed the
   threshold, so every millisecond before that instant was gone — and an energy
   gate always trips one or two frames after voicing actually begins, because
   word-initial stops and fricatives (/p/ /t/ /k/ /s/ /f/) carry almost no
   energy compared to the vowel behind them. "Sixty" arrived as "ixty" and
   Whisper confabulated something to fill the hole, which is a large part of why
   utterances came back subtly wrong rather than obviously missing.

   The recorder now runs continuously and utterances are cut out of a rolling
   buffer, so the audio from before the trigger is already captured. 400ms sits
   between OpenAI's 300ms default and LiveKit's 500ms. */
const PREROLL_MS = 400
// One frame from the capture worklet: 512 samples at 16kHz. Kept in sync with
// micCaptureWorklet's own FRAME constant — the pruning arithmetic below needs to
// retain the pre-roll window plus one frame of slack, so it has to know this.
const FRAME_MS = 32

/* The gap the speech threshold alone leaves: a level that never crosses it
   reads identically whether the room is silent or someone's talking too quietly
   to trip it — "the mic isn't working" and "you're just a bit too quiet" look
   the same with nothing but silence either way. This band catches the second
   case specifically: real signal (above room-noise) that still never clears the
   bar, held long enough that it's a pattern and not one soft word. */
const QUIET_FLOOR_MULT = 1.5
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
   enough transient leakage to trip a bare threshold.

   320ms of sustained speech, not 180. LiveKit requires 500ms before it counts
   anything as an interruption, and its reasoning applies here: a cough, a chair
   scrape, or one leaked syllable of the assistant's own voice all clear a
   180ms bar. The cost of raising it is bounded by the false-interruption
   recovery below — cutting off slightly late is recoverable, cutting off for
   nothing is not. */
const BARGE_SUSTAIN_MS = 320

/* False-interruption recovery. Barge-in is now deliberately quick to fire and
   quick to forgive: if the assistant gets cut off and then NOTHING follows
   within this window — no utterance, no speech at all — the interrupt is
   reclassified as a false positive. LiveKit ships this pattern on by default at
   exactly 2.0s, and it converts the worst failure mode (a cough kills a long
   answer and the teacher has to say "sorry, go on") into a two-second hiccup.
   What resumes is the remainder of the reply, which ChatPage still holds. */
const FALSE_INTERRUPT_MS = 2000

/* AEC needs a few seconds of the speaker-and-mic loop before it converges, and
   until it has, the assistant's own voice leaks through at close to full level.
   Evaluating barge-in during that window is how a reply interrupts itself. Two
   guards: nothing counts as an interrupt until the stream has been live this
   long, and each new utterance from the assistant gets a short grace while the
   canceller re-adapts to new far-end content. */
const AEC_WARMUP_MS = 1200
const AEC_REARM_MS = 300

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
                  {answered ? <Check size={11} strokeWidth={3} className="fa-check-pop" /> : null}
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
          className="fa-press neo-raised mt-2 min-h-touch shrink-0 self-start rounded-full bg-accent px-5 text-sm font-medium text-ink-inverse transition-shadow hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
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
function BuiltPlanCard({ builtPlan, fill = true, onClose }) {
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
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={api.planDownloadUrl(builtPlan.planId)}
          download
          className="neo-raised tap-target flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium text-accent-text transition-shadow"
        >
          <Download size={12} aria-hidden="true" />
          Download
        </a>
        {/* The "done" moment this card used to leave entirely implicit —
            the checklist finishing was the only signal, and nothing on
            screen ever suggested the conversation itself had a natural end.
            Still just onClose (the same action the header's Close already
            does); this is a second, better-timed door to it, not a new
            behavior. */}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="tap-target flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium text-ink-soft transition-colors hover:bg-paper-sunken"
          >
            Done — close voice
          </button>
        ) : null}
      </div>
      <p className="flex items-start gap-1.5 text-xs leading-snug text-ink-faint">
        <FileText size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
        Say what to change and I'll revise it.
      </p>
    </div>
  )
}

/* The heard-back echo, made correctable — it used to be a five-second,
 * read-only flash of what the mic thought it heard (see heardText's own
 * comment on why that window exists at all). By the time it's on screen
 * the utterance has ALREADY been sent — delaying every submission to allow
 * a correction window would slow down the other 95% of utterances that
 * transcribed just fine, purely to hedge the rare miss. So this doesn't
 * intercept the original send; it turns the echo into a quick way to
 * follow up on it, the same tap-to-edit language DecisionRow already uses
 * for correcting a settled decision, just aimed at what was HEARD instead
 * of what was DECIDED.
 */
function HeardEcho({ text, onCorrect, onEditingChange }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!editing) setDraft(text)
  }, [text, editing])
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])
  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])

  const save = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== text) onCorrect(next)
  }

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') setEditing(false)
          }}
          className="min-w-0 flex-1 rounded-md border border-edge bg-paper px-2 py-1 text-sm text-ink outline-none"
        />
        <button
          type="button"
          onClick={save}
          className="fa-press neo-raised rounded-full bg-accent px-3 py-1 text-xs font-medium text-ink-inverse transition-shadow hover:bg-accent-hover"
        >
          Fix it
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="rounded-full px-3 py-1 text-xs font-medium text-ink-soft"
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={`You said "${text}" — tap to correct it`}
      className="fa-rise group flex w-full items-center gap-1.5 truncate text-left text-sm leading-relaxed text-ink-muted"
    >
      <span className="eyebrow mr-1.5 shrink-0 not-italic">You said</span>
      <span className="truncate italic">“{text}”</span>
      <Pencil
        size={11}
        aria-hidden="true"
        className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  )
}

export function VoiceModePanel({
  onClose,
  onUtterance,
  // ChatPage's claimWarmMic — a getUserMedia() request already started on
  // pointerdown of whatever button opened this panel, so the permission/
  // hardware negotiation has a head start on the mount that's about to
  // happen. Optional: undefined just means the mic-setup effect below calls
  // getUserMedia itself, exactly as it always did.
  getWarmMic,
  busy,
  isSpeaking,
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
  // isStreaming) — see BuildProgress, which takes over the checklist's own
  // slot for as long as this holds.
  building = false,
  // The plan's own day objects as they arrive mid-stream — ChatPage's
  // stream.preview?.days, the exact same value the text chat's identical
  // WeekStrip usage reads from.
  buildDays = null,
  // Cuts the current reply off mid-sentence — VoiceProvider's voice.stop().
  // Called the instant the teacher starts talking OVER it (see the VAD
  // loop's own comment on barge-in), not after it finishes.
  onInterrupt,
  /* The undo for onInterrupt. Fires when a barge-in turned out to be a cough,
     a chair, or a colleague — nothing followed it within FALSE_INTERRUPT_MS —
     so the reply that got cut off should carry on. Optional: without it, a
     false interrupt just stays an interrupt, which is what it always did. */
  onFalseInterrupt,
  // The clarification the conversation is waiting on, if any, and the way
  // to answer it — see QuestionCards.
  questions = null,
  onAnswer,
  // Speaks the last reply again — undefined (not a no-op) when there's
  // nothing to replay yet, so the header hides the button outright rather
  // than showing it disabled with nothing to explain why.
  onReplayLast,
  messages = [],
  activeClass = null,
  calendar = null,
  onBuild,
}) {
  const [status, setStatus] = useState('requesting-mic') // requesting-mic | listening | transcribing | error
  const [errorMessage, setErrorMessage] = useState(null)
  // Two distinct "something's off" nudges. Both surface through `notice` below
  // — the actionable slot — not the status pill and not the caption: they're
  // about the PIPELINE, they persist until resolved, and they're the kind of
  // thing that got lost when it shared a slot with transient status text.
  // missHint: consecutive attempts that produced nothing usable.
  // quietHint: real signal that never once cleared the speech threshold.
  // Only one shows at a time (missHint wins — see `notice`), so there's no
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
  /* 'auto' (the always-on VAD this whole component was built around) or
     'ptt' (press-and-hold): a classroom is not the quiet room the VAD's
     thresholds were tuned against, and always-on listening means every
     aside to a student risks getting half-captured as an utterance. PTT
     trades the hands-free default for a mode where nothing is heard
     except while a button is actually held. A ref mirror for the same
     reason busy/isSpeaking already have one: the VAD tick loop below reads
     this every frame without re-subscribing to React's render cycle. */
  const [mode, setMode] = useState('auto')
  const modeRef = useRef('auto')
  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  // Whether a press-and-hold utterance is currently under way — guards
  // startPttRecording/stopPttRecording (below) against a stray pointerup
  // with no matching pointerdown, e.g. a hover that never actually pressed.
  const pttHeldRef = useRef(false)
  // Whether the currently-visible heard-back echo is mid-correction (see
  // HeardEcho below) — pauses the echo's own auto-clear timeout so typing
  // a fix doesn't have the input yanked out from under mid-edit.
  const [editingHeard, setEditingHeard] = useState(false)
  // Bumped by "Try again" in the error state — it's the mic-setup effect's
  // only dependency, so changing it re-runs teardown + setup, which is
  // exactly what retrying permission means. Previously the error state was
  // a dead end: fix it in browser settings, then reopen the panel yourself.
  const [retryToken, setRetryToken] = useState(0)
  // Set the moment a barge-in actually fires, cleared shortly after — the
  // interrupt worked silently before, so talking over the assistant felt
  // like it might not have registered.
  const [justInterrupted, setJustInterrupted] = useState(false)
  const panelRef = useRef(null)
  const closeRef = useRef(null)

  const streamRef = useRef(null)
  const audioCtxRef = useRef(null)
  const canvasRef = useRef(null)
  const analyserRef = useRef(null)
  const rafRef = useRef(null)
  const workletRef = useRef(null)
  const vadStateRef = useRef('idle') // idle | recording
  const silenceStartRef = useRef(null)
  const speechStartRef = useRef(null)

  /* ── the rolling capture buffer ────────────────────────────────────────────
     Replaces MediaRecorder entirely. The worklet posts 32ms frames of 16kHz
     mono continuously; these hold them, and an utterance is a WINDOW cut out of
     that history rather than a recording that had to be started in time.

     bufRef       frames, in order, oldest first
     bufStartRef  absolute sample index of bufRef[0]'s first sample
     totalRef     absolute sample index one past the newest sample
     utterStartRef absolute sample index where speech was detected

     "Absolute" means counted from the start of the session, so the arithmetic
     for "give me from 400ms before speech started" is subtraction and nothing
     else. While idle the buffer is pruned down to just the pre-roll window, so
     memory is bounded at ~13KB rather than growing for the life of the panel. */
  const bufRef = useRef([])
  const bufStartRef = useRef(0)
  const totalRef = useRef(0)
  const utterStartRef = useRef(0)
  const CAPTURE_RATE = 16000
  /* The running estimate of what this room and this microphone sound like with
     nobody talking. Every threshold is a multiple of it — see the constants at
     the top of this file for why absolute thresholds could not work. Seeded
     optimistically low and allowed to rise slowly. */
  const noiseFloorRef = useRef(0.006)
  // When the mic stream went live, and when the assistant last started an
  // utterance — both feed the AEC-convergence guards on barge-in.
  const micLiveAtRef = useRef(0)
  const speakStartedAtRef = useRef(0)
  // Set when a barge-in fires; if no real utterance follows within
  // FALSE_INTERRUPT_MS the interrupt is treated as a false positive.
  const falseInterruptRef = useRef(null)
  /* The Silero detector, once it has loaded — null until then and null forever
     if loading failed, in which case the adaptive-energy path below carries on
     doing the job. Never awaited from the frame handler; see sileroVad.js for
     why push/probability are split. */
  // A ref, not state: the only reader is onFrame, which runs outside React's
  // render cycle, and nothing on screen changes when the better detector takes
  // over. Swapping detectors mid-conversation is meant to be unnoticeable.
  const sileroRef = useRef(null)
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
  // The mic/capture pipeline below is set up in a mount-once effect —
  // deliberately, since tearing down and re-requesting getUserMedia every
  // render would be its own bug. But the code that submits a finished utterance
  // runs from inside that effect's world, and it used to call the `onUtterance`
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

  // trap: false — this panel now sits docked beside a live composer rather
  // than blocking the page as a modal, the same reasoning useFocusTrap's own
  // comment gives for the artifact panel's docked case: trapping Tab here
  // would lock a teacher out of the input they were about to type in.
  useFocusTrap(panelRef, { active: true, trap: false, initialFocus: panelRef, onEscape: onClose })

  useEffect(() => {
    // busy alone, not busy || isSpeaking — see pausedRef's own comment.
    // There's genuinely nothing to record INTO yet while busy (no reply
    // exists at all, spoken or otherwise), but isSpeaking has something
    // actively playing that a real utterance should be able to cut off.
    pausedRef.current = Boolean(busy)
  }, [busy])

  useEffect(() => {
    isSpeakingRef.current = Boolean(isSpeaking)
    /* Stamp when the assistant STARTS a stretch of speech, for the barge-in
       guard: browser AEC re-adapts whenever the far-end content changes, and
       during that re-adaptation the assistant's own voice leaks through the mic
       at close to full level. Requiring more evidence in the first few hundred
       milliseconds of each utterance is what stops a reply interrupting itself
       on laptop speakers. */
    if (isSpeaking) speakStartedAtRef.current = performance.now()
  }, [isSpeaking])

  /* Same ref-mirror as onUtterance, and needed for the same reason: the
     false-interrupt timer is armed from inside the detector, which lives outside
     React's render cycle, and this prop's identity changes every turn. */
  const onFalseInterruptRef = useRef(onFalseInterrupt)
  onFalseInterruptRef.current = onFalseInterrupt

  /* `caption` is now the sentence that is being spoken RIGHT NOW, handed down
     from VoiceProvider, which sets it on a timer scheduled against the
     AudioContext clock at the exact moment that sentence's audio begins. So it
     is rendered as-is.
   *
   * What used to be here: a setInterval revealing one character every 42ms.
   * That's 23.8 chars/second, about 260wpm, against TTS speech of roughly 14
   * chars/second — so the text raced about 1.7x ahead of the voice, finished
   * early, and sat frozen while the assistant was still talking. The interval
   * also re-rendered this entire component 24 times a second, concurrently with
   * the VAD loop and audio playback, which is the worst possible moment to be
   * adding render pressure. Both problems are gone rather than tuned: no
   * character interval, no per-frame state, and the caption cannot drift out of
   * step with the audio because the audio is what schedules it.
   *
   * The per-word entrance animation (.karaoke-word, applied in the render
   * below) survives and now means something — it fires once per sentence, on a
   * real event, instead of once per typewriter tick. */

  // Neither hint has any OTHER path back to false if the teacher just gives
  // up rather than resolving it (speaking up, or landing a real utterance —
  // see onFrame()/finishUtterance(), which clear these the moment either
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
  // is the whole window in which noticing a mis-hear is still useful (and,
  // now, the window for HeardEcho below to actually fix it). Whichever
  // comes first clears it: the reply starting, or this timeout — except
  // while mid-correction, where yanking the input out from under a
  // half-typed fix would be its own bug.
  useEffect(() => {
    if (!heardText || editingHeard) return undefined
    const t = setTimeout(() => setHeardText(''), 5000)
    return () => clearTimeout(t)
  }, [heardText, editingHeard])
  useEffect(() => {
    if ((isSpeaking || caption) && !editingHeard) setHeardText('')
  }, [isSpeaking, caption, editingHeard])

  /* 420ms, matching .barge-in-shatter's animation exactly (base.css). It was
     1600ms against a 500ms animation — and because that class runs `forwards`
     and its last keyframe is opacity: 0, the caption row stayed INVISIBLE and
     blurred for the 1.1s after the animation ended. Whatever rendered into it
     during that window was silently swallowed, which in practice was the "You
     said …" echo of the very utterance that caused the barge-in: the
     acknowledgement was hiding the thing being acknowledged. */
  useEffect(() => {
    if (!justInterrupted) return undefined
    const t = setTimeout(() => setJustInterrupted(false), 420)
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

  /* Push-to-talk's own start/stop — the pointerdown/pointerup pair the
     "Hold to talk" button (below) wires up. Mirrors what the detector does
     automatically in 'auto' mode rather than duplicating a second capture
     pipeline: PTT only decides WHEN an utterance begins and ends; the audio
     itself comes out of the same rolling buffer either way, pre-roll included.

     No processingRef guard on the way in any more. It used to refuse to start
     a new utterance while the previous one was still being transcribed, which
     meant a deliberate button press was silently ignored — the one input in the
     whole panel that is unambiguous about intent. */
  const startPttRecording = () => {
    if (mutedRef.current || vadStateRef.current === 'recording') return
    pttHeldRef.current = true
    // Holding the floor (assistant speaking or still generating) while the
    // button is pressed is an explicit, deliberate interrupt in PTT mode —
    // there's no threshold to clear, the press itself IS the signal, so there's
    // nothing to second-guess afterwards either: no false-interrupt timer.
    if (isSpeakingRef.current || pausedRef.current) {
      if (falseInterruptRef.current) {
        clearTimeout(falseInterruptRef.current)
        falseInterruptRef.current = null
      }
      onInterruptRef.current?.()
      setJustInterrupted(true)
    }
    beginUtterance()
  }
  const stopPttRecording = () => {
    if (!pttHeldRef.current) return
    pttHeldRef.current = false
    finishUtterance()
  }

  // Keep fresh references for the global keyboard listener without re-binding it on every render
  const latestHandlersRef = useRef({ startPttRecording, stopPttRecording, toggleMute })
  latestHandlersRef.current = { startPttRecording, stopPttRecording, toggleMute }

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if typing in a text field or if focus is on a button (buttons natively use Space to click)
      if (['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return
      if (e.code === 'Space') {
        e.preventDefault() // Prevent page scrolling
        if (e.repeat) return // Prevent auto-repeat from spamming

        if (modeRef.current === 'ptt') {
          latestHandlersRef.current.startPttRecording()
        } else {
          latestHandlersRef.current.toggleMute()
        }
      }
    }

    const handleKeyUp = (e) => {
      if (['INPUT', 'TEXTAREA', 'BUTTON'].includes(e.target.tagName)) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (modeRef.current === 'ptt') {
          latestHandlersRef.current.stopPttRecording()
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      // Safety catch: if they release space while focused elsewhere, ensure we stop PTT
      if (modeRef.current === 'ptt') latestHandlersRef.current.stopPttRecording()
    }
  }, [])

  /* Marks the start of an utterance. There is no recorder to start — capture
     has been running since the panel opened — so this only notes WHERE in the
     buffer speech began and stops the buffer being pruned. */
  const beginUtterance = () => {
    if (vadStateRef.current === 'recording') return
    vadStateRef.current = 'recording'
    utterStartRef.current = totalRef.current
    speechStartRef.current = performance.now()
    silenceStartRef.current = null
    setHearing(true)
  }

  /* Throws the current utterance away — used when the teacher mutes mid-
     sentence, or the panel is closing. Distinct from finishing one: nothing is
     transcribed and nothing is submitted. */
  const abortUtterance = () => {
    vadStateRef.current = 'idle'
    silenceStartRef.current = null
    speechStartRef.current = null
    setHearing(false)
  }

  /* Cuts the utterance out of the rolling buffer and sends it.
   *
   * The window starts PREROLL_MS BEFORE the detector tripped, which is the
   * whole point of capturing continuously — see micCaptureWorklet's comment on
   * why an energy gate always misses the front of a word.
   */
  const finishUtterance = async () => {
    const started = speechStartRef.current
    const startSample = utterStartRef.current
    const endSample = totalRef.current
    vadStateRef.current = 'idle'
    speechStartRef.current = null
    silenceStartRef.current = null
    setHearing(false)

    // Too short to be real speech — a cough, a tap, a bump of the table.
    if (!started || performance.now() - started < MIN_UTTERANCE_MS) return

    const preroll = Math.round((PREROLL_MS / 1000) * CAPTURE_RATE)
    const from = Math.max(bufStartRef.current, startSample - preroll)
    const available = endSample - bufStartRef.current
    if (available <= 0) return

    // Flatten what's retained, then take the window. bufRef holds the whole
    // utterance plus its pre-roll at this point, because pruning is suspended
    // for the duration of a capture.
    const flat = new Float32Array(available)
    let offset = 0
    for (const frame of bufRef.current) {
      if (offset + frame.length > flat.length) break
      flat.set(frame, offset)
      offset += frame.length
    }
    const window = flat.subarray(Math.max(0, from - bufStartRef.current), offset)
    if (window.length < CAPTURE_RATE * (MIN_UTTERANCE_MS / 1000)) return

    /* processingRef gates SUBMISSION, not listening. It used to gate the whole
       detector — the entire VAD block was wrapped in `!processingRef.current` —
       so for the full duration of the transcribe round trip (most of a second,
       longer on a cold instance) the microphone was effectively deaf: no
       barge-in, and no new utterance could begin. A teacher adding "…and make
       it Tuesday" immediately after their sentence lost the front of it with
       nothing to indicate why. The detector now keeps running throughout. */
    processingRef.current = true
    setStatus('transcribing')
    /* The latency clock starts HERE — the moment the teacher stopped talking,
       not the moment we got a transcript. Everything from this point is silence
       they sit through. See lib/voiceMetrics. */
    metrics.turnStarted()
    try {
      const { text } = await api.transcribe(encodeWav(window, CAPTURE_RATE))
      metrics.transcriptReady()
      if (text && text.trim()) {
        missCountRef.current = 0
        setMissHint(false)
        /* A real utterance landed, so the interrupt that preceded it was
           genuine — cancel the false-interrupt timer rather than let it resume
           a reply the teacher has now actually replaced. */
        if (falseInterruptRef.current) {
          clearTimeout(falseInterruptRef.current)
          falseInterruptRef.current = null
        }
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
        // Nothing usable came back, so there's no reply to wait for and no
        // latency sample to take — drop the open turn rather than let it be
        // closed by whatever happens next.
        metrics.turnAbandoned()
      }
    } catch {
      // A missed utterance used to just mean "say it again" with nothing
      // shown for it — fine once, but a SECOND miss right after is the
      // point a teacher would otherwise keep repeating themselves with no
      // idea whether the mic even heard anything at all.
      missCountRef.current += 1
      if (missCountRef.current >= MISS_HINT_COUNT) setMissHint(true)
      metrics.turnAbandoned()
    } finally {
      processingRef.current = false
      setStatus('listening')
      /* Clear Silero's carried LSTM state between turns. It exists to give the
         model context WITHIN an utterance; carrying it across a turn boundary
         (and across however long the assistant then talks for) just lets it
         drift. Pipecat resets on a timer for the same reason. */
      sileroRef.current?.reset()
    }
  }

  /* ── the detector ─────────────────────────────────────────────────────────
   *
   * Runs once per 32ms frame posted by the capture worklet, NOT on
   * requestAnimationFrame. That move fixes a real bug on its own: rAF is
   * throttled to about 1fps on a hidden tab and suspended outright on iOS when
   * the app is backgrounded, so the detector used to stop making decisions
   * entirely while the microphone stayed live. The old visibilitychange handler
   * resumed the AudioContext on return but nothing restarted the loop, so the
   * panel came back looking active and hearing nothing. Worklet messages keep
   * arriving as long as the context is running, and they arrive at a fixed
   * audio-clock cadence rather than a display-refresh one.
   *
   * rAF is still used, but only to draw the level meter — which is exactly the
   * kind of work that SHOULD stop when nobody can see it.
   */
  const onFrame = (frame) => {
    // ── RMS of this frame, and the running noise-floor estimate ──
    let sumSquares = 0
    for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i]
    const level = Math.sqrt(sumSquares / frame.length)
    levelRef.current = level

    /* The floor follows the room, slowly up and quickly down, and is frozen
       outright while we believe speech is happening — an estimator that keeps
       averaging during an utterance climbs into the speech and then goes deaf to
       it, which is the classic failure of adaptive gating. */
    const floor = noiseFloorRef.current
    if (vadStateRef.current !== 'recording' && !isSpeakingRef.current) {
      const alpha = level > floor ? FLOOR_ATTACK : FLOOR_DECAY
      noiseFloorRef.current = floor + (level - floor) * alpha
    }
    const speechBar = Math.max(SPEECH_FLOOR_MIN, noiseFloorRef.current * SPEECH_FLOOR_MULT)
    const bargeBar = Math.max(BARGE_FLOOR_MIN, noiseFloorRef.current * BARGE_FLOOR_MULT)
    const quietBar = Math.max(noiseFloorRef.current * QUIET_FLOOR_MULT, 0.008)

    // ── keep the rolling buffer ──
    bufRef.current.push(frame)
    totalRef.current += frame.length
    if (vadStateRef.current !== 'recording') {
      // Idle: retain only the pre-roll window, so memory stays bounded.
      const keep = Math.round(((PREROLL_MS + FRAME_MS) / 1000) * CAPTURE_RATE)
      while (totalRef.current - bufStartRef.current > keep && bufRef.current.length > 1) {
        bufStartRef.current += bufRef.current[0].length
        bufRef.current.shift()
      }
    }

    /* ── is this speech? ──────────────────────────────────────────────────────
       Silero when it's loaded, the adaptive energy bars when it isn't. The two
       answer genuinely different questions and the split matters:

       isSpeech    — is this a human voice at all? Silero knows; a level does
                     not. This is what decides when a turn starts and ends.
       loudEnough  — is it loud enough, relative to this room's own floor, to be
                     someone talking TO the app rather than the assistant's own
                     output leaking back through the speaker? Silero cannot help
                     here at all: leaked TTS is speech, and it will say so.

       Barge-in needs both. Starting a turn into a quiet room needs only the
       first, with a very low level gate to reject digital silence. That pairing
       is what Pipecat settled on too (confidence >= threshold AND volume >=
       min_volume) and it is strictly better than either signal alone. */
    const silero = sileroRef.current
    const prob = silero ? silero.probability() : 0
    if (silero) silero.push(frame)

    // Hysteresis, either way: a single bar that decides both entry and exit
    // flaps at the boundary. Silero's canonical gap is 0.5/0.35; the energy
    // fallback reuses its own bar with a 25% relaxation on the way out.
    const speaking = vadStateRef.current === 'recording'
    const isSpeech = silero
      ? prob > (speaking ? SPEECH_OFF : SPEECH_ON)
      : level > (speaking ? speechBar * 0.75 : speechBar)
    const loudEnough = level > bargeBar

    // Muted or push-to-talk: no automatic decisions at all. The track is
    // already delivering silence when muted (see toggleMute); PTT makes every
    // decision below explicit via the button instead, and silence-based
    // endpointing firing mid-hold would cut a teacher off the moment they
    // paused to think with the button still down.
    if (modeRef.current !== 'auto' || mutedRef.current) return

    const now = performance.now()
    // Whether the assistant currently owns the turn — either actively
    // speaking, or still writing the reply it's about to speak.
    const holdingFloor = isSpeakingRef.current || pausedRef.current

    if (vadStateRef.current === 'recording') {
      /* Already capturing. Endpointing uses the ORDINARY speech test, never the
         barge-in one: the barge-in gate exists to decide whether someone started
         talking over the assistant, and reusing it here would read every dip
         between words as the end of the sentence and cut the teacher off
         mid-thought. With Silero this is where the carried LSTM state earns its
         keep — it holds "still speech" across the brief near-silences inside a
         word that an energy gate reads as the end of the turn. */
      if (isSpeech) {
        silenceStartRef.current = null
        if (now - speechStartRef.current > MAX_UTTERANCE_MS) finishUtterance()
      } else if (silenceStartRef.current == null) {
        silenceStartRef.current = now
      } else {
        /* Two timers, not one — see SILENCE_MS's own comment. A very short
           burst is far more likely to be a fragment the teacher is still in
           the middle of ("week seven—") than a finished turn, so it gets the
           longer grace; anything of normal length closes on the short one.
           MAX_SILENCE_MS is the guillotine either way, so this can never be
           slower than a plain fixed timeout. */
        const spokenMs = now - speechStartRef.current
        const quiet = now - silenceStartRef.current
        const grace = spokenMs < SHORT_UTTERANCE_MS ? SILENCE_MS_OPEN : SILENCE_MS
        if (quiet > Math.min(grace, MAX_SILENCE_MS)) finishUtterance()
      }
      return
    }

    if (holdingFloor) {
      /* Idle while the assistant holds the floor: the barge-in test.
         Deliberately hard to pass, because the room is not quiet — a speaker
         inches from the mic is playing the assistant's own voice. Echo
         cancellation removes most of it, but AEC needs seconds to converge and
         re-adapts every time the far-end content changes, so two warm-up
         guards sit in front of the threshold: nothing counts until the stream
         has been live a moment, and each new assistant utterance gets a brief
         grace. Without those, a reply reliably interrupts itself on laptop
         speakers. */
      const warm =
        now - micLiveAtRef.current > AEC_WARMUP_MS && now - speakStartedAtRef.current > AEC_REARM_MS
      /* BOTH signals, and this is the one place the pairing is load-bearing.
         Silero alone would interrupt the assistant with the assistant: leaked
         TTS is speech and the model says so at high confidence. A level alone
         would interrupt on a chair scrape. Requiring "a human voice" AND "louder
         than this room's floor by a wide margin" is what makes an aggressive
         barge-in threshold safe. */
      if (warm && isSpeech && loudEnough) {
        if (bargeStartRef.current == null) bargeStartRef.current = now
        else if (now - bargeStartRef.current > BARGE_SUSTAIN_MS) {
          bargeStartRef.current = null
          // Silences the reply AND aborts the generation behind it, then
          // records exactly like any other utterance.
          onInterruptRef.current?.()
          // Cutting the assistant off used to happen in total silence — the
          // reply just stopped, which is as consistent with "it finished" or
          // "it broke" as with "you interrupted it." A brief acknowledgement is
          // what makes it read as deliberate.
          setJustInterrupted(true)
          /* And arm the undo. If no real utterance follows, the interrupt was a
             cough or a chair and onFalseInterrupt puts the reply back — see
             FALSE_INTERRUPT_MS. This is what lets the barge-in threshold be
             aggressive without punishing anyone for it. */
          if (falseInterruptRef.current) clearTimeout(falseInterruptRef.current)
          falseInterruptRef.current = setTimeout(() => {
            falseInterruptRef.current = null
            if (vadStateRef.current !== 'recording' && !processingRef.current) {
              onFalseInterruptRef.current?.()
            }
          }, FALSE_INTERRUPT_MS)
          beginUtterance()
        }
      } else {
        bargeStartRef.current = null
      }
      return
    }

    /* Ordinary start-of-utterance into a quiet room. Only the speech test — no
       loudness requirement beyond the tiny floor below, because a teacher
       speaking quietly at a laptop is the case this has to catch, and with
       Silero deciding there's no longer any need to demand volume as a proxy
       for "that was probably a voice". */
    if (isSpeech) {
      quietStartRef.current = null
      if (quietHintShownRef.current) {
        quietHintShownRef.current = false
        setQuietHint(false)
      }
      beginUtterance()
    } else if (level > quietBar) {
      // Real signal (someone talking, just not loud enough), sustained — one
      // soft word doesn't warrant a nudge, a whole pattern of them does.
      // Still level-based on purpose: this hint is specifically about VOLUME,
      // which is the one question Silero has no opinion on.
      if (quietStartRef.current == null) quietStartRef.current = now
      else if (!quietHintShownRef.current && now - quietStartRef.current > QUIET_HINT_MS) {
        quietHintShownRef.current = true
        setQuietHint(true)
      }
    } else {
      // True silence — not the same signal as "trying and too quiet," so it
      // doesn't accumulate toward the hint at all.
      quietStartRef.current = null
    }
  }
  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  useEffect(() => {
    let cancelled = false

    const tick = () => {
      const analyser = analyserRef.current
      if (!analyser) return

      // The level meter is now the ONLY thing telling the teacher "I can hear
      // you right now" — the status pill deliberately stopped saying it in
      // words (see `phase`), on the Alexa principle that the conversational
      // states differ by motion rather than by text. So this matters more than
      // it did when it was decoration next to a label that said the same thing.
      //
      // Damped flat under the conditions where the level isn't really about the
      // teacher's own voice: muted (nothing coming through), or while the
      // assistant holds the floor and what's arriving is mostly its own output
      // bleeding back in through the speaker.
      const damped = pausedRef.current || mutedRef.current || processingRef.current

      if (canvasRef.current) {
        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d')

        /* Size the BACKING STORE to device pixels and scale the drawing
           context to match. The canvas used to carry width=48 height=14
           attributes — CSS pixels — so on any display with devicePixelRatio 2
           (every phone and every retina laptop this app runs on) the browser
           upscaled a 48x14 bitmap into a 96x28 box and the bars came out soft.
           Recomputed each frame but only WRITTEN when it changes; assigning
           canvas.width unconditionally would clear the bitmap every tick. */
        const dpr = window.devicePixelRatio || 1
        const cssW = canvas.clientWidth || 48
        const cssH = canvas.clientHeight || 14
        const needW = Math.round(cssW * dpr)
        const needH = Math.round(cssH * dpr)
        if (canvas.width !== needW || canvas.height !== needH) {
          canvas.width = needW
          canvas.height = needH
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, cssW, cssH)

        // Use frequency data for the bar visualizer
        if (!analyserRef.current._freqData) {
          analyserRef.current._freqData = new Uint8Array(analyser.frequencyBinCount)
        }
        const freqData = analyserRef.current._freqData
        analyser.getByteFrequencyData(freqData)

        const barCount = 12
        const gap = 2
        const barWidth = (cssW - gap * (barCount - 1)) / barCount

        /* The accent colour from the live theme, not a hardcoded black. This
           was 'rgba(0, 0, 0, 0.4)' — invisible against the dark theme's own
           dark panel, in an app that ships a theme toggle. Read once per frame
           off the canvas's own computed style so it follows the theme (and the
           neo/skeuomorphic skin toggle) without this file knowing anything
           about either. currentColor via the pill's text colour would also
           work, but the accent token is what the rest of the panel's live
           feedback already uses. */
        ctx.fillStyle = getComputedStyle(canvas).color || 'currentColor'
        for (let i = 0; i < barCount; i++) {
          // sample from the lower frequency bands (human voice)
          const dataIndex = Math.floor((i / barCount) * (freqData.length / 4))
          const value = freqData[dataIndex] || 0

          // Smoothed height mapping
          const mappedValue = damped ? 2 : Math.max(2, (value / 255) * cssH)

          // Draw rounded bar
          const x = i * (barWidth + gap)
          const y = (cssH - mappedValue) / 2

          ctx.beginPath()
          /* roundRect is Safari 16.4+. Fall back to a plain rect rather than
             throwing — at this size the corner radius is a nicety, an exception
             inside a 60fps loop is not. */
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(x, y, barWidth, mappedValue, barWidth / 2)
          } else {
            ctx.rect(x, y, barWidth, mappedValue)
          }
          ctx.fill()
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
        // A warm stream (claimed once — see getWarmMic's own comment above)
        // skips this negotiation outright; its getUserMedia call already
        // happened on the button's pointerdown, before this effect even
        // existed. Falls through to a fresh request otherwise — the normal
        // path for ⌘⇧V (no button press to warm from) and for "Try again"
        // after an error (the warm stream, if any, is long since claimed or
        // released by then).
        //
        // Explicit constraints, not a bare `audio: true` — on a phone the
        // mic sits inches from the speaker this same panel is playing TTS
        // out of, and without the browser's own echo cancellation actually
        // requested, the mic picks up the assistant's own voice bleeding
        // back in (worst right as isSpeaking flips off and the room's still
        // resonating) and transcribes THAT — which reads as "can barely hear
        // what I'm saying" and nonsensical replies, because it isn't
        // transcribing what was said, it's transcribing an echo of itself.
        const warm = getWarmMic?.()
        const stream = await (warm ||
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          }))
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
           gesture or not. A suspended context is silent rather than broken: the
           capture worklet is never pulled, so no frames arrive, the detector
           makes no decisions, and the mic reads as "not picking anything up"
           with no error surfaced anywhere — exactly what iPhone reports and
           desktop Chrome doesn't (Chrome doesn't enforce this as strictly).
           resume() is safe to call even when already running. */
        if (ctx.state === 'suspended') ctx.resume().catch(() => {})
        const source = ctx.createMediaStreamSource(stream)

        /* The analyser is now ONLY for the level meter's frequency bars. Every
           actual decision comes off the capture worklet's own frames — see
           onFrame — because a display-refresh clock is the wrong clock for
           audio and stops entirely on a backgrounded tab. */
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        analyserRef.current = analyser

        /* Continuous capture. addModule takes a URL and the processor runs in a
           scope with no bundler runtime, which is why the worklet is imported
           `?url` and emitted as its own asset rather than inlined. */
        await ctx.audioWorklet.addModule(micWorkletUrl)
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          ctx.close().catch(() => {})
          return
        }
        const node = new AudioWorkletNode(ctx, 'mic-capture')
        node.port.onmessage = (e) => onFrameRef.current?.(e.data)
        source.connect(node)
        /* Not connected to ctx.destination — that would play the microphone
           back through the speakers. A worklet node still gets pulled without a
           downstream connection in every current browser because it has an
           active input; the historical ScriptProcessorNode trick of connecting
           through a zero gain isn't needed here. */
        workletRef.current = node

        // Reset the buffer's bookkeeping for this session, so "Try again"
        // starts from a clean timeline rather than the failed attempt's.
        bufRef.current = []
        bufStartRef.current = 0
        totalRef.current = 0
        noiseFloorRef.current = 0.006
        micLiveAtRef.current = performance.now()

        setStatus('listening')
        rafRef.current = requestAnimationFrame(tick)

        /* Load Silero AFTER the mic is already live and listening, not before.
           The adaptive-energy detector is running from the first frame, so the
           conversation is usable immediately and simply gets better a moment
           later — rather than making the teacher wait on a multi-megabyte
           runtime before they can say anything. Deliberately not awaited into
           the setup path above for exactly that reason.

           Failure is not an error state. Offline, assets not staged, no WASM
           SIMD — any of those leave sileroRef null and the energy detector in
           charge, which is how this behaved before Silero existed. Logged once
           for diagnosis, never surfaced: the teacher has nothing to act on. */
        createSileroDetector()
          .then((det) => {
            if (cancelled) {
              det.close()
              return
            }
            sileroRef.current = det
          })
          .catch((err) => {
            if (!cancelled) {
              // eslint-disable-next-line no-console
              console.warn(
                '[voice] Silero VAD unavailable, using the energy detector instead:',
                err?.message || err
              )
            }
          })
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
      /* abortUtterance, NOT finishUtterance: finishing transcribes and SUBMITS,
         so ending the conversation while a sentence was still being captured
         used to land a stray half-sentence turn in a chat the teacher had
         already walked away from. Aborting drops the window instead. */
      abortUtterance()
      if (falseInterruptRef.current) clearTimeout(falseInterruptRef.current)
      if (sileroRef.current) {
        sileroRef.current.close()
        sileroRef.current = null
      }
      if (workletRef.current) {
        workletRef.current.port.onmessage = null
        workletRef.current.disconnect()
        workletRef.current = null
      }
      bufRef.current = []
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
  /* THE CONVERSATIONAL LOOP IS THREE STATES. It used to be thirteen labels in
     one pill, six of which fired during a single ordinary turn — Listening… →
     Hearing you… → Got it — one sec… → Thinking… → Speaking… (Talk to
     interrupt) → Listening… — each an instant text swap that also resized the
     pill (labels ran 8 to 30 characters), shoving the "N of 4 decided" badge
     beside it sideways every time, and each announced separately through
     aria-live. That churn is most of what read as "jarring", and it wasn't
     buying anything: a controlled study of exactly this (spinner-and-label
     "artificial" feedback vs the assistant saying "hmm, let's see" in its own
     voice) found the artificial kind produced no measurable improvement over
     showing nothing at all. Amazon's own Echo guidelines specify three
     conversational states, on one element, in one colour, distinguished only by
     motion — nothing to read and nothing to reflow.

     So: listening / working / speaking, and the level meter below carries
     "am I actually hearing you" through movement rather than through a fourth
     label. `hearing` deliberately no longer gets its own text — the meter is
     already reacting to the voice that set it. */
  const phase =
    status === 'requesting-mic'
      ? 'connecting'
      : status === 'error'
        ? 'error'
        : muted
          ? 'off'
          : isSpeaking
            ? 'speaking'
            : status === 'transcribing' || busy || building
              ? 'working'
              : 'listening'

  const label =
    phase === 'connecting'
      ? 'Connecting'
      : phase === 'error'
        ? 'No mic'
        : phase === 'off'
          ? 'Mic off'
          : phase === 'speaking'
            ? 'Speaking'
            : phase === 'working'
              ? 'Thinking'
              : 'Listening'

  /* The other half of the split: conditions the teacher has to ACT on, which
     have no business sharing a slot with ephemeral status. A mic that's blocked
     or muted, or two failed utterances in a row, are persistent and need an
     affordance; "Thinking" is transient and needs nothing. Mixing the two meant
     the actionable ones scrolled past inside a stream of status text and got
     missed — the same mechanism as alert blindness. This renders as its own
     line, below, and stays put until it's resolved. */
  const notice =
    status === 'error'
      ? { tone: 'bad', text: errorMessage, action: 'retry' }
      : muted
        ? { tone: 'muted', text: 'Microphone is off — nothing is being heard.', action: 'unmute' }
        : missHint
          ? { tone: 'bad', text: "Didn't catch that. Try again, a little closer to the mic." }
          : quietHint
            ? { tone: 'muted', text: "You're coming through very quietly — try speaking up." }
            : null

  /* The caption area holds CONTENT — words that were said, by either side —
     and the pill holds STATUS. They used to share: the caption fell back to
     `label` whenever there was no caption, so "Listening…" rendered twice
     on screen at once (pill and caption) for most of every conversation,
     and a screen reader announced the same string from two live regions.
     Now the caption goes quiet when there's nothing said to show, and the
     pill is the single place status lives. */
  const spokenText = caption || ''
  const showHeard = !spokenText && Boolean(heardText)

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
      /* min-w + justify-center is the whole fix for the pill's own jitter: the
         label changes but the BOX doesn't, so nothing beside it moves. Wide
         enough for the longest of the four labels ("Connecting") at this size.
         And the meter is ALWAYS mounted now rather than toggled with `hidden` —
         it used to appear and disappear with the status, which snapped the
         pill's width between a 48px canvas and a 1.5px dot on every transition,
         a geometry change dressed up as a status change. It just goes flat when
         there's no live level worth showing. */
      className={`inline-flex min-w-[8.5rem] items-center justify-center gap-2 rounded-full px-3 py-1 text-2xs font-semibold uppercase tracking-caps transition-colors ${
        phase === 'error'
          ? 'bg-mark-tint text-mark'
          : phase === 'off'
            ? 'bg-paper-sunken text-ink-muted'
            : 'bg-accent-tint text-accent-text'
      }`}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        /* No width/height ATTRIBUTES here — the backing store is sized in the
           draw loop against devicePixelRatio (see tick()). Setting them here
           would fight that, and setting them to CSS pixels is what made this
           render at half resolution on every retina display, which is every
           device this app is actually used on. */
        className="h-3.5 w-12 shrink-0"
      />
      {label}
    </span>
  )

  /* The actionable slot — see `notice`. Its own row, persistent, with the
     control that resolves it right there rather than somewhere else in the
     header. */
  const noticeRow = notice ? (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-snug ${
        notice.tone === 'bad' ? 'text-mark' : 'text-ink-muted'
      }`}
    >
      <span>{notice.text}</span>
      {notice.action === 'retry' ? (
        <button
          type="button"
          onClick={retryMic}
          className="neo-raised tap-target inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium text-accent-text transition-shadow"
        >
          <RotateCcw size={11} aria-hidden="true" />
          Try again
        </button>
      ) : null}
      {notice.action === 'unmute' ? (
        <button
          type="button"
          onClick={toggleMute}
          className="neo-raised tap-target inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs font-medium text-accent-text transition-shadow"
        >
          <Mic size={11} aria-hidden="true" />
          Turn it back on
        </button>
      ) : null}
    </div>
  ) : null

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

  /* Push-to-talk's own control, replacing Mute entirely while active — the
     two don't coexist: PTT already only listens while physically held, so
     a separate mute toggle on top of that has nothing left to mean.
     Pressed-in (neo-inset) for the whole duration of the hold, the same
     physical language every other pressed/idle pair here already speaks —
     this is the one control in the panel where that has to track a raw
     pointer hold rather than a click-toggle. pointerLeave/pointerCancel
     both release it too: a press that drags off the button (or gets
     interrupted by a system dialog) must not leave the mic silently stuck
     open. */
  const pttButton = (
    <button
      type="button"
      onPointerDown={startPttRecording}
      onPointerUp={stopPttRecording}
      onPointerLeave={stopPttRecording}
      onPointerCancel={stopPttRecording}
      disabled={status === 'error'}
      aria-pressed={hearing}
      aria-label="Hold to talk"
      className={`tap-target select-none flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-shadow disabled:cursor-not-allowed disabled:opacity-40 ${
        hearing ? 'neo-inset text-accent-text' : 'neo-raised text-ink-soft'
      }`}
    >
      <Mic size={15} aria-hidden="true" />
      Hold to talk
    </button>
  )

  /* Switches between always-listening (the VAD this panel was built
     around) and push-to-talk — a classroom is not the quiet room the VAD's
     thresholds assume, so this is an escape hatch for a noisy room rather
     than a replacement default. Quiet icon-only treatment, same as Close:
     a mode switch is a rare, deliberate choice, not something to give equal
     visual weight to Mute/Hold-to-talk, the control actually used every
     turn. */
  const modeToggleButton = (
    <button
      type="button"
      onClick={() => {
        setMode((m) => {
          const next = m === 'auto' ? 'ptt' : 'auto'
          // PTT's own hold IS the gate on when the mic is heard — a mute
          // left on from 'auto' mode would otherwise silently block every
          // press with no visible reason why, since Mute itself is gone
          // from the header the moment PTT takes its place.
          if (next === 'ptt' && muted) {
            setMuted(false)
            mutedRef.current = false
            streamRef.current?.getAudioTracks().forEach((t) => {
              t.enabled = true
            })
          }
          return next
        })
      }}
      aria-label={mode === 'auto' ? 'Switch to push-to-talk' : 'Switch to always-listening'}
      title={mode === 'auto' ? 'Switch to push-to-talk' : 'Switch to always-listening'}
      className="tap-target flex h-9 w-9 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-paper-sunken hover:text-ink-soft"
    >
      {mode === 'auto' ? <Radio size={15} aria-hidden="true" /> : <Hand size={15} aria-hidden="true" />}
    </button>
  )

  const recentAssistantMessages = messages
    .filter((m) => m.role === 'assistant' && !m.tool_calls)
    .slice(-2)

  /* What was actually SAID, either side of the conversation — never status
     (that's statusPill's job) and no longer errors either (that's noticeRow's,
     which owns everything the teacher has to act on). Three states, in order:
     the sentence the assistant is speaking right now, the echo of what was just
     heard from the teacher, or the hint that they can cut in. */
  const captionBlock =
    spokenText ? (
      <div className="flex flex-col gap-2">
        {recentAssistantMessages.length > 0 && (
          <div className="flex flex-col gap-1">
            {recentAssistantMessages.map((m) => (
              <p key={m.id} className="truncate text-xs leading-relaxed text-ink-faint">
                {m.content}
              </p>
            ))}
          </div>
        )}
        {/* Keyed on the caption text, so React remounts these spans when the
            sentence changes and .karaoke-word's entrance actually replays.
            Keyed on index alone (as it was) the nodes persisted across
            sentences and only newly-added words animated — fine for a
            typewriter growing one character at a time, wrong now that the whole
            line is replaced per sentence. */}
        <p className="truncate text-sm leading-relaxed text-ink-soft">
          {spokenText.split(/(\s+)/).map((w, i) =>
            w.trim() ? (
              <span key={`${spokenText.length}-${i}`} className="karaoke-word">
                {w}
              </span>
            ) : (
              <span key={`${spokenText.length}-${i}`}>{w}</span>
            )
          )}
        </p>
      </div>
    ) : showHeard ? (
      <HeardEcho
        text={heardText}
        onEditingChange={setEditingHeard}
        onCorrect={(fixed) => {
          // Phrased as a correction, not a repeat — a bare resend of the
          // fixed text reads to the model as a brand new statement, not an
          // amendment to the turn it already answered.
          onUtterance(`Sorry, I actually said: "${fixed}"`)
          setHeardText('')
        }}
      />
    ) : isSpeaking ? (
      <p className="text-sm text-ink-faint">
        {mode === 'ptt' ? 'Hold the talk button to cut in.' : 'Talk any time to cut in.'}
      </p>
    ) : null

  // The checklist is only actually on screen in its own default rotation
  // slot (not while a question/build/built-plan state has taken it over) —
  // showing "N of 4 decided" during those other states would describe a
  // list that isn't even visible right now.
  const showingChecklist = !questions?.length && !building && !builtPlan
  const { checklist: coreChecklist } = splitDecisions(decisions)
  const decidedCount = coreChecklist.filter((item) => item.value != null).length

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label="Voice conversation"
      className={`relative flex w-full flex-col gap-3 px-3 pb-3 pt-4 transition-colors ${
        isSpeaking || busy ? 'aurora-glow' : ''
      }`}
    >
      {/* Header row: status (+ a running "N of 4 decided" count while the
          checklist is actually the thing on screen) on the left, every
          control for the conversation on the right — mirrors the artifact
          drawer's own handle+content shape, just inline instead of a
          separate strip, since this panel is short enough not to need one.
          There is no orb here anymore — a big pulsing circle used to split
          this panel's space with the checklist; the checklist is the one
          thing this panel exists to show, so the mic gets exactly the room
          its own status pill needs and nothing more. flex-wrap on the
          controls cluster: Replay, the mode toggle, Mute/Hold-to-talk, and
          Close is a lot of buttons for one row on a narrow phone. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {statusPill}
          {showingChecklist ? (
            <span className="text-2xs font-semibold uppercase tracking-caps text-ink-faint">
              {decidedCount} of {coreChecklist.length} decided
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Quiet, icon-only, same treatment as Close — the old
              full-screen transcript column had a Replay action on every
              reply; dropping that column when the chat's own message list
              took over its job meant there was no way left to hear a missed
              line again without retyping. Hidden outright (not disabled)
              when there's nothing yet to replay. */}
          {onReplayLast ? (
            <button
              type="button"
              onClick={onReplayLast}
              aria-label="Replay the last reply"
              title="Replay the last reply"
              className="tap-target flex h-9 w-9 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-paper-sunken hover:text-ink-soft"
            >
              <Play size={14} aria-hidden="true" fill="currentColor" />
            </button>
          ) : null}
          <span className="hidden sm:inline text-2xs font-medium uppercase tracking-wider text-ink-faint mr-1">
            {mode === 'ptt' ? 'Hold Space to talk' : 'Press Space to toggle'}
          </span>
          {modeToggleButton}
          {mode === 'ptt' ? pttButton : muteButton}
          {/* Quieter than muteButton on purpose — no neo-raised emboss, no
             shadow, just the glyph with a hover state. Mute is the control
             actually used mid-conversation; Close ends it. Giving both the
             same raised-pill treatment made them read as equally weighted
             choices when they aren't. */}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close voice conversation"
            className="tap-target flex h-9 w-9 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-paper-sunken hover:text-ink-soft"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* What's currently being said, either side — a single line under
          the status bar rather than a boxed caption card, since it's
          secondary now: worth showing, not worth the space a whole panel
          of its own used to cost. Always mounted (unlike before) so its
          height can actually TRANSITION between nothing and one line
          (.caption-line's own grid-rows trick, same shape as .voice-dock's)
          instead of the checklist below getting shoved down in one abrupt
          jump every time a caption appears or clears. */}
      <div className={`caption-line shrink-0${captionBlock ? ' is-visible' : ''}`}>
        {/* No aria-live here. The statusPill above already carries one, and two
            live regions a line apart meant a screen reader announced the state
            and the caption as competing interruptions. This is content that's
            also being spoken aloud — the audio IS the announcement. */}
        <div className={`caption-line-inner ${justInterrupted ? 'barge-in-shatter' : ''}`}>
          {captionBlock}
        </div>
      </div>

      {/* Anything the teacher has to act on — a blocked mic, a muted mic, two
          misses in a row — with the control that fixes it. Its own row, held
          until resolved, deliberately not sharing the pill's slot. */}
      {noticeRow ? <div className="shrink-0">{noticeRow}</div> : null}

      {/* The checklist — or whichever of questions/build progress/built
          plan currently owns this slot, same rotation the old side column
          used — now full width and the clear focus of the panel: talk,
          and watch it get checked off. */}
      <div className="min-w-0">
        <SmoothHeight>
          {questions?.length ? (
            <QuestionCards questions={questions} onAnswer={onAnswer} />
          ) : building ? (
            <BuildProgress days={buildDays} fill={false} />
          ) : builtPlan ? (
            <BuiltPlanCard builtPlan={builtPlan} fill={false} onClose={onClose} />
          ) : (
            <div className="flex flex-col">
              {/* A checklist that's still all "Not yet decided" is a cold
                  open for a first-time voice conversation — the old
                  full-screen takeover had a spoken greeting to lean on, but
                  nothing on screen ever said what the checklist below it was
                  even for. One line, gone the moment anything's actually
                  settled (see decisions.length), so it never argues with the
                  real progress once there is some. */}
              {decisions.length === 0 ? (
                <p className="mb-2 px-1 text-sm text-ink-muted">
                  Tell me the week, the anchor text, and the skill focus — I'll check these off as we go.
                </p>
              ) : null}
              <DecisionStack decisions={decisions} fill={false} onRevise={reviseDecision} />
              <VoiceSuggestions decisions={decisions} activeClass={activeClass} calendar={calendar} onSelect={onUtterance} />
              {decidedCount === 4 && !building && !builtPlan && onBuild && (
                <button
                  type="button"
                  onClick={onBuild}
                  /* text-ink-inverse, not text-accent-text — that paired the
                     same hue as this button's own bg-accent fill, which read
                     as barely-there text on a solid blue button.
                     fa-press/fa-rise, not active:scale-[0.98]/animate-in —
                     this was the one button in the app reaching for raw
                     Tailwind press/entrance animation instead of the shared
                     vocabulary every other tap target and entrance in this
                     file already uses (QuestionCards, DecisionStack, the
                     checklist rows below). Same visual result, one fewer
                     animation dialect to keep in sync if the timing/easing
                     tokens they're built from ever change. */
                  className="fa-press fa-rise mt-4 w-full flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-ink-inverse shadow-sm transition-all hover:bg-accent-hover"
                >
                  ✨ Build Lesson Plan
                </button>
              )}
            </div>
          )}
        </SmoothHeight>
      </div>
    </div>
  )
}

/* Assessment suggestions tailored to the class's own subject and to the
 * skill focus already decided — was four hardcoded options regardless of
 * either. `subject` is the raw framework id (e.g. "ap-lang", "algebra-1"),
 * not a full framework record — good enough for a coarse ELA/math/science/
 * history split without plumbing the whole /api/frameworks list through
 * ChatPage just for four suggestion chips. Capped at 4 so the row never
 * outgrows what a phone can show in one wrap. */
function assessmentOptions(subject, skillValue) {
  const subj = (subject || '').toLowerCase()
  const skill = (skillValue || '').toLowerCase()
  const isELA = /english|lang|ela|literature|composition|reading|writing|literacy/.test(subj)
  const isMath = /math|algebra|geometry|calculus|statistics|precalculus/.test(subj)
  const isScience = /science|biology|chemistry|physics|environmental/.test(subj)
  const isHistory = /history|social studies|government|geography|economics|psychology/.test(subj)
  const wantsAnalysis = /rhetoric|analysis|argument|persuas/.test(skill)
  const wantsNarrative = /narrative|creative|voice/.test(skill)

  const opts = []
  if (isELA) {
    if (wantsAnalysis) {
      opts.push({ label: 'Timed Write / Rhetorical Précis', value: 'Let us do a timed write, like a rhetorical précis.' })
    }
    if (wantsNarrative) {
      opts.push({ label: 'Creative / Narrative Response', value: 'Let us do a creative narrative response.' })
    }
    opts.push({ label: 'Socratic Seminar', value: 'Let us do a Socratic seminar.' })
    opts.push({ label: 'Short Answer / Essay', value: 'Let us do a short answer essay.' })
  } else if (isMath || isScience) {
    opts.push({ label: 'Problem Set', value: 'Let us do a problem set.' })
    if (isScience) opts.push({ label: 'Lab Report', value: 'Let us do a lab report.' })
    opts.push({ label: 'Multiple Choice Quiz', value: 'Let us do a multiple choice quiz.' })
  } else if (isHistory) {
    opts.push({ label: 'Document-Based Question (DBQ)', value: 'Let us do a document-based question.' })
    opts.push({ label: 'Socratic Seminar', value: 'Let us do a Socratic seminar.' })
    opts.push({ label: 'Multiple Choice Quiz', value: 'Let us do a multiple choice quiz.' })
  } else {
    opts.push({ label: 'Multiple Choice Quiz', value: 'Let us do a multiple choice quiz.' })
    opts.push({ label: 'Short Answer / Essay', value: 'Let us do a short answer essay.' })
    opts.push({ label: 'Socratic Seminar', value: 'Let us do a Socratic seminar.' })
  }
  opts.push({ label: 'Exit Ticket', value: 'An exit ticket.' })
  return opts.slice(0, 4)
}

function VoiceSuggestions({ decisions, activeClass, calendar, onSelect }) {
  const { checklist } = splitDecisions(decisions)
  const nextUndecided = checklist.find((c) => c.value == null)

  if (!nextUndecided) return null

  let title = ''
  let options = []
  // Set on the one option actually pulled from real class/calendar data
  // (the week's own notes, its own topic, or an assessment tailored to the
  // class's subject) — a faint accent tint distinguishes "this came from
  // your own calendar" from "this is a generic fallback," which plain
  // identical chips couldn't say on their own.
  let smartIdx = -1

  if (nextUndecided.key === 'week' && calendar?.weeks) {
    title = 'Upcoming Schedule'
    // Show the first 4 weeks that aren't already built
    options = calendar.weeks
      .filter((w) => !w.built)
      .slice(0, 4)
      .map((w) => ({
        label: `Week ${w.week}: ${w.topic || w.unit || 'Untitled'}`,
        value: `Let's plan Week ${w.week}.`,
      }))
  } else if (nextUndecided.key === 'anchor') {
    title = 'Suggested Texts'
    // Look at the selected week to see if there are texts in the notes.
    // Was `.replace(/\\D/g, '')` — a doubled backslash, which as a regex
    // literal matches the two-character string "\D" rather than "any
    // non-digit" — so this always returned NaN and weekData never resolved,
    // silently disabling the one truly contextual suggestion below.
    const selectedWeekDec = checklist.find((c) => c.key === 'week')
    const selectedWeekNum = selectedWeekDec?.value ? parseInt(String(selectedWeekDec.value).replace(/\D/g, ''), 10) : null
    const weekData = calendar?.weeks?.find((w) => w.week === selectedWeekNum)

    if (weekData?.notes) {
      options.push({
        label: `From Calendar: ${weekData.notes.slice(0, 40)}${weekData.notes.length > 40 ? '...' : ''}`,
        value: `Let's use the text from the calendar: ${weekData.notes}`,
      })
      smartIdx = 0
    }
    options.push({ label: 'Recommend a text for me', value: 'Can you recommend an anchor text for this week?' })
    options.push({ label: 'I will provide my own text', value: 'I have my own text in mind.' })
  } else if (nextUndecided.key === 'skill') {
    title = 'Suggested Focus'
    const selectedWeekDec = checklist.find((c) => c.key === 'week')
    const selectedWeekNum = selectedWeekDec?.value ? parseInt(String(selectedWeekDec.value).replace(/\D/g, ''), 10) : null
    const weekData = calendar?.weeks?.find((w) => w.week === selectedWeekNum)

    if (weekData?.topic || weekData?.unit) {
      options.push({
        label: `Focus on ${weekData.topic || weekData.unit}`,
        value: `Let's make the skill focus about ${weekData.topic || weekData.unit}.`,
      })
      smartIdx = 0
    }
    options.push({ label: 'Recommend a skill', value: 'Can you recommend a skill focus based on the text?' })
  } else if (nextUndecided.key === 'assessment') {
    title = 'Assessment Options'
    const skillDec = checklist.find((c) => c.key === 'skill')
    options = assessmentOptions(activeClass?.subject, skillDec?.value)
  }

  if (options.length === 0) return null

  return (
    <div className="mt-4 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out flex flex-col gap-2">
      <span className="text-xs font-semibold text-ink-soft uppercase tracking-wider">{title}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => onSelect(opt.value)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-all hover:bg-accent-tint hover:text-accent-text hover:border-transparent active:scale-[0.98] ${
              i === smartIdx
                ? 'border-transparent bg-accent-tint text-accent-text'
                : 'border-edge-strong bg-paper text-ink'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}
