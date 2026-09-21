import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Hand, Loader2, Mic, MicOff, PhoneOff, Play, RotateCcw } from 'lucide-react'
import { useVoice } from '../lib/voiceContext'
import { VoiceSignal } from './VoiceSignal'
import '../styles/voice-consultation.css'

/** The voice stage shares the composer's surface; lesson details live beside it. */
export function VoiceModePanel({
  onClose,
  onStart,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  isSpeaking = false,
  conversationBusy = false,
  chatId = null,
  weekNumber = null,
  voiceMode = 'brainstorm',
}) {
  const voice = useVoice()
  const { onSpeechStart, onInputSettled, commitTurn, setMuted, muted } = voice
  const [localCollapsed, setLocalCollapsed] = useState(false)
  const [hearing, setHearing] = useState(false)
  const [connectionSlow, setConnectionSlow] = useState(false)
  const pressing = useRef(false)
  const collapsed = controlledCollapsed ?? localCollapsed
  const live = voice.status === 'live'
  const connecting = voice.status === 'connecting'
  const isPreview = Boolean(voice.preview || voice.isPreview)
  const pushToTalk = voice.inputMode === 'ptt'
  const speaking = Boolean(isSpeaking || voice.speaking)
  const phase = voice.status === 'error' ? 'error'
    : connecting ? 'connecting'
      : !live ? 'idle'
        : speaking ? 'speaking'
          : hearing && !voice.muted ? 'hearing'
            : voice.muted ? 'muted'
              : conversationBusy ? 'thinking' : 'listening'
  const phaseLabel = {
    idle: 'Ready when you are', connecting: 'Connecting', error: 'Connection interrupted',
    speaking: 'Speaking', hearing: 'You’re speaking', muted: pushToTalk ? 'Hold to speak' : 'Microphone off',
    thinking: 'Considering your idea', listening: 'Listening',
  }[phase]

  useEffect(() => {
    setConnectionSlow(false)
    if (!connecting) return undefined
    const timer = window.setTimeout(() => setConnectionSlow(true), 5000)
    return () => window.clearTimeout(timer)
  }, [connecting])

  useEffect(() => {
    if (!live || muted) {
      setHearing(false)
      return undefined
    }
    const offStart = onSpeechStart?.(() => setHearing(true))
    const offSettled = onInputSettled?.(() => setHearing(false))
    return () => { offStart?.(); offSettled?.() }
  }, [live, muted, onSpeechStart, onInputSettled])

  useEffect(() => () => {
    if (!pressing.current) return
    pressing.current = false
    try { commitTurn() } finally { setMuted(true) }
  }, [commitTurn, setMuted])

  useEffect(() => {
    // A parent can minimize the stage without firing a blur/pointer event.
    // Visibility mute and connection loss must also release the held turn.
    if ((!collapsed && live && !muted) || !pressing.current) return
    pressing.current = false
    try { commitTurn() } finally { setMuted(true) }
  }, [collapsed, live, muted, commitTurn, setMuted])

  const stopPress = () => {
    if (!pressing.current) return
    pressing.current = false
    try { voice.commitTurn() } finally { voice.setMuted(true) }
  }
  const startPress = () => {
    if (!live || pressing.current || voice.beginTurn?.() === false) return false
    pressing.current = true
    setHearing(true)
    voice.setMuted(false)
    return true
  }
  const toggleCollapsed = () => {
    stopPress()
    if (controlledCollapsed === undefined) setLocalCollapsed(!collapsed)
    onCollapsedChange?.(!collapsed)
  }
  const start = () => {
    voice.stopSession()
    voice.setInputMode?.('auto')
    const result = onStart ? onStart() : voice.startSession({ chatId, weekNumber, mode: voiceMode })
    Promise.resolve(result).catch(() => {}) // The provider exposes a retryable error state.
  }
  const end = () => { pressing.current = false; voice.stopSession(); onClose?.() }
  const muteControl = live ? (
    <button
      type="button"
      className="voice-stage-control"
      aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
      aria-pressed={voice.muted}
      onClick={() => {
        stopPress()
        // Leaving a held turn enters hands-free mode so Unmute has one clear meaning.
        if (pushToTalk) voice.setInputMode?.('auto')
        else voice.setMuted(!voice.muted)
      }}
    >
      {voice.muted ? <MicOff size={16} /> : <Mic size={16} />}
      {!collapsed ? <span>{voice.muted ? 'Unmute' : 'Mute'}</span> : null}
    </button>
  ) : (
    <button type="button" className="voice-stage-control" disabled={connecting} onClick={start} aria-label={isPreview ? 'Start voice preview' : 'Start voice conversation'}>
      {connecting ? <Loader2 size={16} className="animate-spin" /> : <Mic size={16} />}
      {!collapsed ? <span>{connecting ? 'Connecting' : 'Start'}</span> : null}
    </button>
  )

  return (
    <section className={`voice-consultation is-${phase}${collapsed ? ' is-collapsed' : ''}`} aria-labelledby="voice-consultation-title" data-voice-phase={phase}>
      <h2 id="voice-consultation-title" className="visually-hidden">Teaching conversation</h2>
      <header className="voice-stage-header">
        <div className="voice-stage-signal">
          {!collapsed ? <VoiceSignal speaking={speaking} /> : null}
          <span className="voice-stage-phase" role="status">{isPreview ? 'Preview · ' : ''}{phaseLabel}</span>
        </div>
        <div className="voice-stage-header-actions">
          {muteControl}
          <button type="button" className="voice-stage-end" onClick={end} aria-label="End voice conversation"><PhoneOff size={15} /><span>End</span></button>
          <button type="button" className="voice-stage-icon" onClick={toggleCollapsed} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand teaching conversation' : 'Minimize teaching conversation'}>
            {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </header>
      {!collapsed && pushToTalk && live && !isPreview ? (
          <div className="voice-stage-controls">
              <button
                type="button"
                className={`voice-stage-control${!voice.muted ? ' is-held' : ''}`}
                aria-label="Hold to talk"
                onPointerDown={(event) => {
                  if (event.button === 0 && startPress()) event.currentTarget.setPointerCapture?.(event.pointerId)
                }}
                onPointerUp={stopPress}
                onPointerCancel={stopPress}
                onLostPointerCapture={stopPress}
                onKeyDown={(event) => {
                  if ([' ', 'Enter'].includes(event.key)) {
                    event.preventDefault()
                    if (!event.repeat) startPress()
                  }
                }}
                onKeyUp={(event) => {
                  if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); stopPress() }
                }}
                onBlur={stopPress}
              ><Hand size={16} /><span>Hold to talk</span></button>
          </div>
      ) : null}
      {voice.status === 'error' ? (
        <div className="voice-stage-recovery is-error" role="alert"><p>{voice.errorMessage || 'Voice couldn’t connect. You can still type below.'}</p><button type="button" onClick={start}><RotateCcw size={13} />Try again</button></div>
      ) : voice.audioBlocked ? (
        <div className="voice-stage-recovery" role="status"><p>Tap to hear the reply.</p><button type="button" onClick={voice.resumeAudio}><Play size={13} />Enable audio</button></div>
      ) : connecting && connectionSlow ? (
        <p className="voice-stage-recovery" role="status">Check your browser’s microphone permission.</p>
      ) : null}
    </section>
  )
}
