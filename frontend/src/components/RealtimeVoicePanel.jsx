import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Keyboard, Mic, MicOff, RotateCcw } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useRealtimeVoice } from '../lib/realtimeVoice'
import { BuildProgress, BuiltPlanCard, QuestionCards, Transcript } from './VoiceModePanel'
import { DecisionStack } from './DecisionStack'

/* The fast voice mode — a live speech-to-speech WebRTC session (see
 * lib/realtimeVoice.js and backend/routes/realtime.py) instead of
 * VoiceModePanel's record-clip -> Whisper -> chat-completion -> tts-1
 * cascade. Same conversation, same three tools (generate_lesson_plan,
 * generate_quiz, ask_clarifying_questions), same downstream actions in
 * ChatPage — only the transport underneath changes, which is why this
 * reuses VoiceModePanel's Transcript/QuestionCards/BuildProgress/
 * BuiltPlanCard rather than re-deriving them.
 *
 * What's genuinely different from VoiceModePanel, not just simplified for
 * time: there is no client-side VAD, no MediaRecorder, no per-sentence TTS
 * queue — the server detects speech start/end and barge-in on its own, and
 * the assistant's voice is a live WebRTC audio track, not a fetched clip.
 *
 * What IS simplified for v1, on purpose, and worth revisiting: the
 * level-driven canvas orb animation (VoiceModePanel's `draw`/`tick`) reads
 * raw mic RMS, which this transport doesn't expose the same way — this
 * panel uses a plain CSS pulse keyed off `hearing`/`speaking` instead.
 */

// Mirrors ChatPage's VOICE_GREETING/VOICE_BUILDING/VOICE_REVISING — spoken
// here via the live session's own voice (session.update's instructions
// already primes the model to open with something like this, but a
// deterministic caption the instant the panel opens reads better than
// waiting on the first partial transcript delta to arrive).
const CONNECTING_LABEL = 'Connecting…'

function useTurnAccumulator() {
  const [caption, setCaption] = useState('')
  const textRef = useRef('')
  const append = (delta) => {
    textRef.current += delta
    setCaption(textRef.current)
  }
  const reset = () => {
    textRef.current = ''
    setCaption('')
  }
  return { caption, append, reset, textRef }
}

export function RealtimeVoicePanel({
  onClose,
  isPhone,
  messages = [],
  decisions = [],
  builtPlan = null,
  building = false,
  buildDays = null,
  // {mode, chat_id, week_number} — forwarded verbatim to
  // POST /api/realtime/session (see backend/routes/realtime.py's
  // RealtimeSessionRequest).
  sessionRequest,
  // (text) => void — a teacher utterance the server finished transcribing,
  // or a tapped clarifying-question answer. ChatPage appends+persists it
  // as an ordinary user message, same shape submit() already writes.
  onUserUtterance,
  // ({content, questions}) => void — the assistant's spoken turn, appended
  // +persisted the same way chatStream's onDone does for the legacy path.
  onAssistantMessage,
  // ({name, args, transcriptText, assistantText}) => void — a completed
  // tool call. ChatPage decides build-vs-revise (artifact?.planId) and
  // performs the actual side effect; this panel only reports what
  // happened and constructs the transcript text the builder/reviser
  // prompt needs.
  onToolResult,
}) {
  const [status, setStatus] = useState('connecting') // connecting | listening | error
  const [errorMessage, setErrorMessage] = useState(null)
  const [hearing, setHearing] = useState(false)
  const [heardText, setHeardText] = useState('')
  const [retryToken, setRetryToken] = useState(0)
  const assistantTurn = useTurnAccumulator()
  const panelRef = useRef(null)
  const closeRef = useRef(null)
  // The one piece of history a tool call needs that isn't in ChatPage's
  // `messages` yet: the utterance that triggered THIS turn. Set by onHeard
  // (or a tapped answer), read once the turn's tool call (if any) fires.
  const turnUserTextRef = useRef('')
  // Not state: read synchronously inside onCaptionDone/onToolCall, which
  // fire off the same data-channel message burst in a fixed order — a
  // state setter here would race its own read within that burst.
  const turnHadToolRef = useRef(false)

  useFocusTrap(panelRef, { active: true, trap: true, initialFocus: closeRef, onEscape: onClose })

  const { connected, muted, connect, disconnect, toggleMute, sendText } = useRealtimeVoice({
    onCaption: (delta) => {
      if (status !== 'listening') setStatus('listening')
      assistantTurn.append(delta)
    },
    onCaptionDone: () => {
      const text = assistantTurn.textRef.current.trim()
      // A tool call (handled in onToolCall below) already gets its own
      // message with this same text as `content` — only push a SECOND,
      // plain-text message when no tool fired this turn, same split
      // chatStream's onDone makes between its questions/text branches.
      if (text && !turnHadToolRef.current) {
        onAssistantMessage?.({ content: text })
      }
      turnHadToolRef.current = false
      assistantTurn.reset()
    },
    onHeard: (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      turnUserTextRef.current = trimmed
      setHeardText(trimmed)
      onUserUtterance?.(trimmed)
    },
    onSpeechStarted: () => {
      setHearing(true)
      setTimeout(() => setHearing(false), 1200)
    },
    onToolCall: ({ name, args }) => {
      turnHadToolRef.current = true
      const assistantText = assistantTurn.textRef.current.trim()
      if (name === 'ask_clarifying_questions') {
        onAssistantMessage?.({
          content: assistantText || 'A couple of quick questions to get this right:',
          questions: args.questions || [],
        })
        assistantTurn.reset()
        return
      }
      const transcriptText = [
        ...messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`),
        turnUserTextRef.current ? `USER: ${turnUserTextRef.current}` : null,
        assistantText ? `ASSISTANT: ${assistantText}` : null,
      ]
        .filter(Boolean)
        .join('\n\n')
      onToolResult?.({ name, args, transcriptText, assistantText })
      if (assistantText) onAssistantMessage?.({ content: assistantText })
      assistantTurn.reset()
    },
    onError: (err) => {
      setStatus('error')
      setErrorMessage(err?.message || 'The voice session ran into a problem.')
    },
  })

  const pendingQuestions = useMemo(() => {
    const last = messages[messages.length - 1]
    if (last?.role !== 'assistant' || !last?.questions?.length) return null
    return { message: last, questions: last.questions }
  }, [messages])

  useEffect(() => {
    let cancelled = false
    connect(sessionRequest)
      .then(() => {
        if (!cancelled) setStatus('listening')
      })
      .catch((err) => {
        if (cancelled) return
        setStatus('error')
        setErrorMessage(err?.message || "Couldn't start the voice session.")
      })
    return () => {
      cancelled = true
      disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryToken])

  const heardRecently = Boolean(heardText) && !assistantTurn.caption
  useEffect(() => {
    if (!heardText) return undefined
    const t = setTimeout(() => setHeardText(''), 5000)
    return () => clearTimeout(t)
  }, [heardText])

  const onAnswer = (text) => {
    // A tap produces no audio, so there's no onHeard event to set this —
    // set it directly so a tool call landing right off THIS turn (no
    // intervening spoken utterance) still has it for transcriptText.
    turnUserTextRef.current = text
    setHeardText(text)
    onUserUtterance?.(text)
    sendText(text)
  }

  const label =
    status === 'error'
      ? errorMessage
      : status === 'connecting'
        ? CONNECTING_LABEL
        : muted
          ? 'Mic off'
          : hearing
            ? 'Hearing you…'
            : building
              ? 'Building your week…'
              : connected
                ? 'Listening…'
                : CONNECTING_LABEL

  const statusPill = (
    <span
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-2xs font-semibold uppercase tracking-caps transition-colors ${
        status === 'error' ? 'bg-mark-tint text-mark' : muted ? 'bg-paper-sunken text-ink-muted' : 'bg-accent-tint text-accent-text'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${status === 'error' ? 'bg-mark' : muted ? 'bg-ink-faint' : 'bg-accent'} ${
          status === 'error' || muted ? '' : 'animate-pulse'
        }`}
      />
      {label}
    </span>
  )

  const orb = (
    <div className="neo-raised neo-ring relative flex aspect-square w-full max-w-[280px] shrink-0 items-center justify-center rounded-full">
      <div
        aria-hidden="true"
        className={`h-2/3 w-2/3 rounded-full bg-accent-tint transition-transform duration-300 ${
          hearing || assistantTurn.caption ? 'scale-110' : 'scale-100'
        }`}
      />
    </div>
  )

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

  const captionBlock =
    status === 'error' ? (
      <div className="flex flex-col items-center gap-3">
        <p className="text-base leading-relaxed text-mark">{errorMessage}</p>
        <button
          type="button"
          onClick={() => {
            setErrorMessage(null)
            setStatus('connecting')
            setRetryToken((n) => n + 1)
          }}
          className="neo-raised tap-target flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-accent-text transition-shadow"
        >
          <RotateCcw size={14} aria-hidden="true" />
          Try again
        </button>
      </div>
    ) : assistantTurn.caption ? (
      <p className="text-base leading-relaxed text-ink-soft">{assistantTurn.caption}</p>
    ) : heardRecently ? (
      <p className="fa-rise text-base leading-relaxed text-ink-muted">
        <span className="eyebrow mr-2 not-italic">You said</span>
        <span className="italic">“{heardText}”</span>
      </p>
    ) : null

  const onReplay = (text) => sendText(`Please say that again: "${text}"`)

  const body = (
    <>
      {statusPill}
      {orb}
      <div aria-live="polite" className="flex h-48 w-full flex-col items-center gap-3 overflow-y-auto">
        {captionBlock}
      </div>
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
            aria-label="Back to typing"
            className="neo-raised tap-target flex h-10 w-10 items-center justify-center rounded-full text-ink-soft"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-gutter pb-2">
          <div className="flex shrink-0 justify-center">{statusPill}</div>
          {pendingQuestions ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <QuestionCards questions={pendingQuestions.questions} onAnswer={onAnswer} />
            </div>
          ) : building ? (
            <BuildProgress days={buildDays} fill={false} />
          ) : builtPlan ? (
            <BuiltPlanCard builtPlan={builtPlan} fill={false} />
          ) : (
            <DecisionStack decisions={decisions} fill={false} />
          )}
        </div>
        <div className="shrink-0 space-y-3 px-gutter pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {captionBlock ? (
            <div
              aria-live="polite"
              className="neo-panel flex max-h-32 flex-col items-center gap-2 overflow-y-auto rounded-[28px] bg-paper-raised px-5 py-3 text-center"
            >
              {captionBlock}
            </div>
          ) : null}
          <div className="flex items-center justify-center gap-3">
            {muteButton}
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
      <div className="relative w-full max-w-4xl">
        <div className="grid w-full grid-cols-[280px_minmax(0,1fr)_280px] items-stretch gap-4">
          {building ? <BuildProgress days={buildDays} /> : <Transcript messages={messages} onReplay={onReplay} />}
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Voice conversation"
            className="neo-panel flex min-w-0 flex-col items-center justify-center gap-5 rounded-[28px] bg-paper-raised p-8 text-center"
          >
            {body}
          </div>
          {pendingQuestions ? (
            <QuestionCards questions={pendingQuestions.questions} onAnswer={onAnswer} />
          ) : builtPlan ? (
            <BuiltPlanCard builtPlan={builtPlan} />
          ) : (
            <DecisionStack decisions={decisions} />
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {muteButton}
        <button
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
