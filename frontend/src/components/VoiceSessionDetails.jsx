import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUpRight, BookOpen, Check, Download, Hand, Loader2, MessageCircle, Play, Radio } from 'lucide-react'
import { useVoice } from '../lib/voiceContext'
import { splitDecisions } from '../lib/decisionChecklist'
import { DocxDownloadButton } from './DocxDownloadButton'
import '../styles/voice-session-details.css'

function SessionQuestion({ questions, onAnswer, disabled }) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState({})
  const [answered, setAnswered] = useState(false)
  const question = questions[index]
  if (!question) return null
  const choose = async (option) => {
    const next = { ...answers, [index]: option }
    setAnswers(next)
    if (index < questions.length - 1) setIndex(index + 1)
    else if (await onAnswer(questions.map((item, i) => `${item.text} ${next[i] || ''}`).join('\n'))) setAnswered(true)
  }
  return <section className="voice-details-question" aria-label="A question about your lesson">
    <p className="voice-details-eyebrow">{questions.length > 1 ? `Question ${index + 1} of ${questions.length}` : 'One thing to decide'}</p>
    <p className="voice-details-question-text">{question.text}</p>
    {answered ? <p className="voice-details-answer-sent" role="status"><Check size={13} aria-hidden="true" />Answer sent</p> : <>
      <div className="voice-details-choices">{(question.options || []).filter((option) => typeof option === 'string' && option.trim() && option.trim().toLowerCase() !== 'other').map((option) => <button type="button" key={option} disabled={disabled} onClick={() => { void choose(option) }}>{option}</button>)}</div>
      <small>Choose an option, or answer in your own words as we talk.</small>
    </>}
  </section>
}

/** Supporting details only; the composer owns the microphone and voice session. */
export function VoiceSessionDetails({
  transcript = [], caption = '', decisions = [], builtPlan = null, planOpen = false,
  lessonStatus = null, building = false, buildDays = null, questions = null,
  onAnswer, onUtterance, onOpenPlan, onRetryPending, onReplayLast, onBuild,
  conversationBusy = false, busy = false,
}) {
  const voice = useVoice()
  const scrollRef = useRef(null)
  const scrollInitialized = useRef(false)
  const followTranscript = useRef(false)
  const sendingRef = useRef(false)
  const [following, setFollowing] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const isPreview = Boolean(voice.preview || voice.isPreview)
  const live = voice.status === 'live'
  const canSend = !conversationBusy && !sending && (!isPreview || (live && !voice.muted))
  const turns = transcript.filter((turn) => ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string' && turn.content.trim()).slice(-20)
  const lastTurn = turns.at(-1)
  // A revision can produce a brief acknowledgement and then a save receipt.
  // Keep the teacher's request with both replies instead of hiding it early.
  const exchangeStart = Math.max(0, turns.findLastIndex((turn) => turn.role === 'user'))
  const earlierTurns = turns.slice(0, exchangeStart)
  const currentTurns = turns.slice(exchangeStart)
  const heard = voice.heard && !turns.some((turn) => turn.role === 'user' && turn.content.trim() === voice.heard.trim()) ? voice.heard : ''
  const spokenCaption = caption && !turns.some((turn) => turn.role === 'assistant' && turn.content.includes(caption.trim())) ? caption : ''
  const { checklist, extra } = splitDecisions(decisions)
  const decided = [...checklist, ...extra].filter((item) => item.value != null && String(item.value).trim())
  const planState = lessonStatus?.state || (building ? 'building' : builtPlan ? 'ready' : 'idle')
  const planWorking = ['building', 'revising'].includes(planState)
  const dayCount = Array.isArray(buildDays) ? buildDays.filter(Boolean).length : 0
  const pendingChanges = Number(lessonStatus?.pendingChanges) || 0
  const planTitle = lessonStatus?.label || ({ building: 'Building your first draft', revising: 'Updating your lesson', ready: 'Your lesson is ready', error: 'Your lesson needs attention' }[planState] || 'A lesson starts with an idea')
  const planDetail = lessonStatus?.detail || (planWorking ? 'Keep talking while the draft takes shape.' : builtPlan ? 'Review it, or talk through what you would change.' : 'Bring a learning goal, a text, or a challenge from your classroom.')
  const prompts = builtPlan ? [
    ['Make it more active', 'How could we make this lesson more active while keeping the learning goal?'],
    ['Support more learners', 'What support would help students who need more time with this lesson?'],
    ['Check understanding', 'How can I check that students understand before we move on?'],
  ] : [
    ['Talk through my week', 'Help me think through the learning goal and shape a practical week of lessons.'],
    ['Explore an idea', 'Help me brainstorm an engaging activity and think through why it would work.'],
    ['Plan for my students', 'Help me adapt the lesson to my students. Ask me what you need to know.'],
  ]

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    if (!scrollInitialized.current) {
      // Opening an existing session should start with its decisions and
      // questions, rather than jumping past them to a long conversation.
      scrollInitialized.current = true
      followTranscript.current = node.scrollHeight - node.clientHeight < 40
      setFollowing(followTranscript.current)
    } else if (followTranscript.current) node.scrollTop = node.scrollHeight
  }, [lastTurn?.id, lastTurn?.content, heard, spokenCaption])

  const pauseFollow = () => {
    followTranscript.current = false
    setFollowing(false)
  }

  const send = async (text, answer = false) => {
    const value = text.trim()
    if (!value || !canSend || sendingRef.current) return false
    sendingRef.current = true
    setSending(true)
    setSendError('')
    try {
      // Preview already emits the completed-utterance event. Do not also
      // call ChatPage's submit callback for the same suggestion or answer.
      const callback = answer ? onAnswer || onUtterance : onUtterance
      if (!isPreview && !callback) return false
      const result = isPreview ? voice.simulateUtterance?.(value) : callback(value)
      if (result === false || (isPreview && !voice.simulateUtterance)) {
        setSendError('Start voice preview in the composer to try this idea.')
        return false
      }
      await result
      return true
    } catch {
      setSendError('That idea could not be sent. Please try it again.')
      return false
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  const showLatest = () => {
    followTranscript.current = true
    setFollowing(true)
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }

  return <aside className="voice-details" aria-label="Voice session details">
    <header className="voice-details-header">
      <h2>Conversation</h2>
      {isPreview ? <p className="voice-details-preview">Preview · type below to simulate speech. Microphone off.</p> : null}
    </header>
    <div ref={scrollRef} className="voice-details-scroll" role="region" aria-label="Lesson details and conversation" tabIndex={0} onScroll={(event) => {
      const node = event.currentTarget
      const follows = node.scrollHeight - node.scrollTop - node.clientHeight < 40
      followTranscript.current = follows
      setFollowing(follows)
    }}>
      <div className="voice-details-planning" onFocusCapture={pauseFollow} onPointerDownCapture={pauseFollow}>
      {(!planOpen || planWorking || planState === 'error' || onRetryPending) ? <section className={`voice-details-lesson is-${planState}`} aria-label="Lesson progress">
        <div className="voice-details-lesson-heading"><span className="voice-details-lesson-icon" aria-hidden="true">{planWorking ? <Loader2 size={16} className="voice-details-spinner" /> : planState === 'ready' ? <Check size={16} /> : <BookOpen size={16} />}</span><strong role="status">{planTitle}</strong></div>
        {!builtPlan || planState === 'error' ? <p>{planDetail}</p> : null}
        {pendingChanges > 0 ? <p className="voice-details-pending">{pendingChanges} {pendingChanges === 1 ? 'change waiting' : 'changes waiting'} for this draft</p> : planWorking && dayCount > 0 ? <p className="voice-details-progress">{dayCount} {dayCount === 1 ? 'day' : 'days'} taking shape</p> : null}
        <div className="voice-details-lesson-actions">
          {!planOpen && onOpenPlan && (builtPlan || planWorking) ? <button type="button" className="voice-details-button" onClick={onOpenPlan}>View lesson<ArrowUpRight size={14} aria-hidden="true" /></button> : null}
          {!planOpen && builtPlan?.planId && !planWorking ? <DocxDownloadButton planId={builtPlan.planId} className="voice-details-button is-subtle" aria-label="Download lesson as DOCX"><Download size={14} aria-hidden="true" />Download</DocxDownloadButton> : null}
          {onRetryPending ? <button type="button" className="voice-details-button voice-details-retry" onClick={onRetryPending} disabled={planWorking || conversationBusy || busy}>Retry pending changes</button> : null}
        </div>
      </section> : null}

      {decided.length ? <details className="voice-details-decisions" open><summary><span>Decisions</span></summary><dl>{decided.map((item) => <div key={item.key}><dt>{item.label}</dt><dd>{String(item.value)}</dd></div>)}</dl></details> : null}
      {questions?.length ? <SessionQuestion key={questions.map((item) => item.id || item.text).join('|')} questions={questions} onAnswer={(text) => send(text, true)} disabled={!canSend} /> : !turns.length ? <section className="voice-details-suggestions" aria-label="Ideas to talk through"><h3>Start with an idea</h3><div className="voice-details-choices">{prompts.map(([label, prompt]) => <button type="button" key={label} disabled={!canSend} onClick={() => { void send(prompt) }}>{label}</button>)}</div></section> : null}
      {sendError ? <p className="voice-details-error" role="alert">{sendError}</p> : null}
      {checklist.every((item) => item.value != null) && !builtPlan && onBuild ? <button type="button" className="voice-details-build" disabled={busy || conversationBusy || building || planWorking} onClick={onBuild}>Build this lesson plan<BookOpen size={15} aria-hidden="true" /></button> : null}
      </div>

      <section className="voice-details-conversation" aria-labelledby="voice-details-conversation-title">
        <div className="voice-details-section-heading"><h3 id="voice-details-conversation-title" className="visually-hidden">Current exchange</h3>{onReplayLast ? <button type="button" className="voice-details-replay" onClick={onReplayLast} disabled={!live} aria-label="Replay the last reply"><Play size={12} aria-hidden="true" />Replay</button> : null}</div>
        <div className="voice-details-transcript" role="log" aria-label="Recent teaching conversation" aria-live="polite" aria-relevant="additions">
          {earlierTurns.length ? <details className="voice-details-history" onToggle={pauseFollow}><summary>Earlier conversation</summary>{earlierTurns.map((turn, index) => <div key={turn.id || `earlier-${index}`} className={`voice-details-turn is-${turn.role}`}><span>{turn.role === 'user' ? 'You' : 'FlexEd'}</span><p>{turn.content}</p></div>)}</details> : null}
          {currentTurns.map((turn, index) => <div key={turn.id || `${turn.role}-${index}`} className={`voice-details-turn is-${turn.role}`}><span>{turn.role === 'user' ? 'You' : 'FlexEd'}</span><p>{turn.content}</p></div>)}
          {heard ? <div className="voice-details-turn is-user"><span>You said</span><p>{heard}</p></div> : null}
          {spokenCaption ? <div className="voice-details-turn is-assistant is-caption"><span>{voice.speaking ? 'Speaking' : 'FlexEd'}</span><p>{spokenCaption}</p></div> : null}
          {!turns.length && !heard && !spokenCaption ? <div className="voice-details-empty"><MessageCircle size={20} aria-hidden="true" /><p>Your ideas belong here.<small>Talk through what students need. The key moments of your conversation will appear here.</small></p></div> : null}
        </div>
      </section>
      {!isPreview ? <details className="voice-details-settings"><summary>Voice settings</summary><button type="button" className="voice-details-button" onClick={() => voice.setInputMode?.(voice.inputMode === 'ptt' ? 'auto' : 'ptt')} aria-pressed={voice.inputMode === 'ptt'} aria-label={voice.inputMode === 'ptt' ? 'Switch to hands-free listening' : 'Switch to push-to-talk'}>{voice.inputMode === 'ptt' ? <Hand size={14} /> : <Radio size={14} />}{voice.inputMode === 'ptt' ? 'Push to talk' : 'Hands-free'}</button></details> : null}
    </div>
    {!following && (turns.length > 0 || heard || spokenCaption) ? <div className="voice-details-follow"><button type="button" className="voice-details-latest" onClick={showLatest}><ArrowDown size={12} aria-hidden="true" />Latest message</button></div> : null}
  </aside>
}
