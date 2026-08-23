import { useEffect, useRef, useState } from 'react'
import { Check, Download, Hand, Loader2, Mic, MicOff, Pencil, Play, Radio, RotateCcw, X } from 'lucide-react'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useVoice } from '../lib/voiceContext'
import { WeekStrip } from './WeekStrip'
import { DecisionStack } from './DecisionStack'
import { SmoothHeight } from './OnboardingWizard'
import { splitDecisions } from '../lib/decisionChecklist'
import { api } from '../lib/api'

const isBareOther = (option) => option.trim().toLowerCase() === 'other'

function DynamicMicIcon({ isActive }) {
  return (
    <div className="relative flex items-center justify-center h-4 w-4">
      {isActive && (
        <>
          <span className="absolute -inset-2 rounded-full bg-[rgb(var(--accent-rgb))] opacity-20 animate-ping" style={{ animationDuration: '2s' }} />
          <span className="absolute -inset-1 rounded-full bg-[rgb(var(--accent-rgb))] opacity-30 animate-ping" style={{ animationDuration: '1.5s', animationDelay: '0.5s' }} />
        </>
      )}
      <Mic size={15} className={`relative z-10 ${isActive ? 'text-accent' : ''}`} />
    </div>
  )
}

function QuestionCards({ questions, onAnswer, muted }) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const question = questions[index]
  const finish = (nextAnswers) => {
    const answer = questions
      .map((item) => (nextAnswers[item.id] ? `${item.text} ${nextAnswers[item.id]}` : null))
      .filter(Boolean)
      .join('\n')
    onAnswer(answer || questions.map((item) => item.text).join('\n'))
  }
  const choose = (option) => {
    const next = { ...answers, [question.id]: option }
    setAnswers(next)
    if (index === questions.length - 1) finish(next)
    else setIndex((current) => current + 1)
  }
  const skip = () => {
    if (index === questions.length - 1) finish(answers)
    else setIndex((current) => current + 1)
  }

  return (
    <div className="neo-panel flex flex-col gap-3 rounded-[28px] bg-paper-raised p-4">
      <p className="eyebrow">{questions.length > 1 ? `Question ${index + 1} of ${questions.length}` : 'One quick question'}</p>
      {/* fa-context-pop, keyed by question id — the same rise-up reveal the
          composer's suggestion tray uses when its content changes, so
          advancing between questions reads as new content arriving rather
          than the panel silently swapping text underneath a static frame
          (LessonQuestions, this panel's text-mode twin, gets the same
          treatment). */}
      <p key={question.id} className="fa-context-pop text-sm font-medium leading-snug text-ink">{question.text}</p>
      <div key={`opts-${question.id}`} className="fa-context-pop flex flex-wrap gap-2">
        {(question.options || []).filter((option) => !isBareOther(option)).map((option) => (
          <button key={option} type="button" onClick={() => choose(option)} className="tap-target neo-raised rounded-full px-3 py-1.5 text-xs font-medium text-ink-soft">
            {option}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between text-2xs text-ink-faint">
        {questions.length > 1 ? <button type="button" onClick={skip} className="hover:underline">Skip</button> : <span />}
        <span className="flex items-center gap-1.5"><MicOff size={11} aria-hidden="true" />{muted ? 'Mic is off' : 'Or say your answer'}</span>
      </div>
    </div>
  )
}

function BuildProgress({ days }) {
  return (
    <div className="neo-panel flex flex-col gap-3 rounded-[28px] bg-paper-raised p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink"><Loader2 size={14} className="animate-spin" />Building your week</p>
      <WeekStrip days={days} writing loose className="w-full" />
    </div>
  )
}

function BuiltPlanCard({ builtPlan, onClose }) {
  return (
    <div className="neo-panel fa-shadow-lift flex flex-wrap items-center gap-3 rounded-[28px] bg-paper-raised p-4">
      <span className="neo-inset grid h-9 w-9 place-items-center rounded-full text-ink"><Check size={16} strokeWidth={3} /></span>
      <div className="min-w-0 flex-1"><p className="eyebrow">Built</p><p className="text-sm font-medium text-ink">{builtPlan.weekLabel || 'This week'}</p></div>
      <a href={api.planDownloadUrl(builtPlan.planId)} download className="neo-raised tap-target flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium text-ink"><Download size={12} />Download</a>
      <button type="button" onClick={onClose} className="text-xs font-medium text-ink-soft">Done</button>
    </div>
  )
}

function HeardEcho({ text, onCorrect }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(text)
  useEffect(() => { if (!editing) setDraft(text) }, [editing, text])
  if (editing) {
    return (
      <div className="flex gap-2">
        <input autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { setEditing(false); onCorrect(draft) } }} className="min-w-0 flex-1 rounded-md border border-edge bg-paper px-2 py-1 text-sm text-ink" />
        <button type="button" onClick={() => { setEditing(false); onCorrect(draft) }} className="neo-raised rounded-full px-3 py-1 text-xs font-medium text-ink">Fix it</button>
      </div>
    )
  }
  return <button type="button" onClick={() => setEditing(true)} className="flex w-full items-center gap-1.5 truncate text-left text-sm text-ink-muted"><span className="eyebrow shrink-0">You said</span><span className="truncate italic">“{text}”</span><Pencil size={11} className="shrink-0" /></button>
}

export function VoiceModePanel({
  onClose,
  onUtterance,
  chatId = null,
  weekNumber = null,
  voiceMode = 'brainstorm',
  busy,
  isSpeaking,
  caption = '',
  decisions = [],
  builtPlan = null,
  building = false,
  buildDays = null,
  questions = null,
  onAnswer,
  onReplayLast,
  onBuild,
}) {
  const voice = useVoice()
  const panelRef = useRef(null)
  const [mode, setMode] = useState('auto')
  const [heardText, setHeardText] = useState('')
  const [connectingSeconds, setConnectingSeconds] = useState(0)
  useFocusTrap(panelRef, { active: true, trap: false, initialFocus: panelRef, onEscape: onClose })

  useEffect(() => {
    setHeardText(voice.heard || '')
  }, [voice.heard])
  useEffect(() => {
    if (!heardText) return undefined
    const timeout = setTimeout(() => setHeardText(''), 5000)
    return () => clearTimeout(timeout)
  }, [heardText])

  useEffect(() => {
    if (voice.status !== 'connecting') {
      setConnectingSeconds(0)
      return undefined
    }
    const startedAt = Date.now()
    const tick = () => setConnectingSeconds(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const timer = setInterval(tick, 500)
    return () => clearInterval(timer)
  }, [voice.status])

  const retry = () => {
    voice.stopSession()
    voice.startSession({ chatId, weekNumber, mode: voiceMode })
  }
  const toggleMute = () => voice.setMuted(!voice.muted)
  const togglePtt = () => {
    const next = mode === 'auto' ? 'ptt' : 'auto'
    setMode(next)
    voice.setMuted(next === 'ptt')
  }
  const startPtt = () => { if (mode === 'ptt') voice.setMuted(false) }
  // commitTurn() BEFORE setMuted(true): the commit has to reach the
  // Realtime session while the track can still be heard as "just stopped,"
  // not after — see commitTurn's own comment in VoiceProvider for why this
  // is what actually saves the ~350ms silence-timeout wait a release would
  // otherwise still sit through.
  const stopPtt = () => {
    if (mode !== 'ptt') return
    voice.commitTurn()
    voice.setMuted(true)
  }

  const phase = voice.status === 'connecting'
    ? 'connecting'
    : voice.status === 'error'
      ? 'error'
      : voice.interrupted
        ? 'interrupted'
      : voice.muted
        ? 'off'
        : isSpeaking
          ? 'speaking'
          : busy || building
            ? 'working'
            : 'listening'
  const labels = { connecting: 'Connecting', error: 'Needs attention', interrupted: 'Listening', off: 'Mic off', speaking: 'Speaking', working: 'Thinking', listening: 'Listening' }
  const { checklist } = splitDecisions(decisions)
  const decidedCount = checklist.filter((item) => item.value != null).length
  const nextDecision = checklist.find((item) => item.value == null)
  const progressLabel = checklist.length === 0
    ? null
    : decidedCount === checklist.length
      ? 'Ready to build'
      : decidedCount === 0
        ? 'Let’s set the essentials'
        : `Next: ${nextDecision?.label || 'one more detail'}`
  const showHeard = !caption && heardText

  return (
    <div ref={panelRef} tabIndex={-1} role="region" aria-label="Voice conversation" className={`relative flex w-full flex-col gap-3 px-3 pb-3 pt-4 ${isSpeaking || busy ? 'aurora-glow' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span aria-live="polite" className={`inline-flex min-w-[8rem] items-center justify-center gap-2 rounded-full px-3 py-1 text-2xs font-semibold uppercase tracking-caps ${voice.status === 'error' ? 'bg-mark-tint text-mark' : voice.muted ? 'bg-paper-sunken text-ink-soft' : 'bg-paper text-ink'}`}><span className={`h-2 w-2 rounded-full ${voice.status === 'error' ? 'bg-mark' : voice.interrupted ? 'bg-accent' : voice.muted ? 'bg-ink-faint' : 'bg-accent'}`} />{labels[phase]}</span>
          {!questions?.length && !building && !builtPlan && progressLabel ? <span className="text-2xs font-semibold uppercase tracking-caps text-ink-faint">{progressLabel}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          {onReplayLast ? <button type="button" onClick={onReplayLast} aria-label="Replay the last reply" className="tap-target flex h-9 w-9 items-center justify-center rounded-full text-ink-faint hover:bg-paper-sunken"><Play size={14} fill="currentColor" /></button> : null}
          <button type="button" onClick={togglePtt} aria-pressed={mode === 'ptt'} aria-label={mode === 'auto' ? 'Switch to push-to-talk' : 'Switch to hands-free listening'} className={`tap-target flex items-center gap-2 rounded-full px-3 py-2 text-2xs font-semibold uppercase tracking-caps ${mode === 'ptt' ? 'bg-paper-sunken text-ink' : 'text-ink-faint hover:bg-paper-sunken'}`}>{mode === 'auto' ? <><Radio size={14} />Hands-free</> : <><Hand size={14} />Push to talk</>}</button>
          {mode === 'ptt' ? <button type="button" onPointerDown={startPtt} onPointerUp={stopPtt} onPointerLeave={stopPtt} onPointerCancel={stopPtt} aria-label="Hold to talk" className="fa-press tap-target neo-raised flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-ink-soft"><Hand size={15} />Hold to talk</button> : <button type="button" onClick={toggleMute} aria-pressed={voice.muted} aria-label={voice.muted ? 'Turn the microphone back on' : 'Turn the microphone off'} className={`fa-press tap-target neo-raised flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ${!voice.muted && phase === 'listening' ? 'voice-mic-active ring-1 ring-accent/30' : ''} ${voice.muted ? 'bg-mark-tint text-mark' : 'text-ink-soft'}`}>{voice.muted ? <MicOff size={15} /> : <DynamicMicIcon isActive={!voice.muted && (phase === 'listening' || phase === 'speaking')} />}{voice.muted ? 'Microphone off' : 'Mute'}</button>}
          <button type="button" onClick={onClose} aria-label="Close voice conversation" className="tap-target flex h-9 w-9 items-center justify-center rounded-full text-ink-faint hover:bg-paper-sunken"><X size={16} /></button>
        </div>
      </div>

      <div className={`caption-line shrink-0${caption || showHeard || isSpeaking ? ' is-visible' : ''}${voice.interrupted ? ' fa-settle' : ''}`}>
        <div className="caption-line-inner">
          {caption ? <p className="text-sm leading-relaxed text-ink-soft">{caption}</p> : showHeard ? <HeardEcho text={heardText} onCorrect={(fixed) => { const next = fixed.trim(); if (next) onUtterance(`Sorry, I actually said: "${next}"`); setHeardText('') }} /> : voice.interrupted ? <p className="text-sm font-medium text-accent-text">Stopped — listening to you.</p> : isSpeaking ? <p className="text-sm text-ink-faint">Talk any time to cut in.</p> : null}
        </div>
      </div>

      {voice.status === 'connecting' ? <div role="status" className="flex items-center justify-between gap-3 rounded-2xl bg-paper-sunken px-3 py-2 text-xs text-ink-soft"><span>{connectingSeconds < 4 ? 'Opening your microphone…' : 'Still connecting — Chrome may be waiting for permission.'}</span><button type="button" onClick={onClose} className="font-semibold text-ink hover:underline">Cancel</button></div> : null}
      {voice.status === 'error' ? <div role="status" className="flex flex-wrap items-center gap-2 rounded-2xl bg-mark-tint px-3 py-2 text-xs text-mark"><span className="min-w-0 flex-1">{voice.errorMessage || 'Microphone access failed.'}</span><button type="button" onClick={retry} className="neo-raised inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-2xs font-medium text-ink"><RotateCcw size={11} />Try again</button><button type="button" onClick={onClose} className="px-1 text-2xs font-semibold text-mark hover:underline">Close</button></div> : null}

      <SmoothHeight>
        {questions?.length ? <QuestionCards questions={questions} onAnswer={onAnswer} muted={voice.muted} /> : building ? <BuildProgress days={buildDays} /> : builtPlan ? <BuiltPlanCard builtPlan={builtPlan} onClose={onClose} /> : <div className="flex flex-col gap-3">
          {decisions.length === 0 ? <p className="px-1 text-sm text-ink-muted">Tell me the week, anchor text, and skill focus — I’ll check these off as we go.</p> : null}
          <DecisionStack decisions={decisions} fill={false} onRevise={(label, value) => onUtterance(`Change ${label.toLowerCase()} to ${value}.`)} />
          {decidedCount === checklist.length && checklist.length > 0 && onBuild ? <button type="button" onClick={onBuild} className="fa-press fa-rise mt-1 flex w-full items-center justify-center gap-2 rounded-xl bg-paper-raised px-4 py-3 text-sm font-semibold text-ink">✨ Build Lesson Plan</button> : null}
        </div>}
      </SmoothHeight>
    </div>
  )
}
