import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStream } from './useChatStream'
import { chatMessageText } from '../lib/chatActions'

const makeId = () => crypto.randomUUID()
const requestsArtifact = (result) => Boolean(result?.planAction || result?.dayRevisionRequested || result?.quizRequested)

// Conversation and document work have independent streams. Only the ordinary
// ChatPage submit path can mutate a plan; consultation tools record requests
// which are reconsidered against the saved draft after the current job ends.
export function useVoiceConsultation(options) {
  const latest = useRef(options)
  latest.current = options
  const [pendingChanges, setPendingChanges] = useState([])
  const [waitingTurns, setWaitingTurns] = useState([])
  const [pendingPaused, setPendingPaused] = useState(false)
  const [awaitingUtterance, setAwaitingUtterance] = useState(false)
  const [replayPhase, setReplayPhase] = useState(null)
  const [retryRequested, setRetryRequested] = useState(false)
  const pendingRef = useRef([])
  const replayRef = useRef(null)
  const conversationAdditions = useRef([])
  const activeTurn = useRef(null)
  const dispatching = useRef(false)
  const epoch = useRef(0)
  const updatePending = useCallback((updater) => {
    const next = updater(pendingRef.current)
    pendingRef.current = next
    setPendingChanges(next)
  }, [])
  const appendConversationMessage = useCallback((message) => {
    // Speech-start and its final transcript can arrive in one browser task,
    // before ChatPage has rendered the messages we just appended.
    const ctx = latest.current
    conversationAdditions.current = conversationAdditions.current.filter((item) => !ctx.messages.some((saved) => saved.id === item.id))
    conversationAdditions.current.push(message)
    ctx.appendMessage(message)
  }, [])
  const queueTurn = useCallback((turn, result) => {
    if (turn.queued) return
    turn.queued = true
    const day = result?.dayRevisionRequested
    const instruction = day
      ? `${day.feedback} Apply only to ${day.day}, ${day.field}.`
      : result?.planAction?.instruction || result?.quizRequested?.instruction || ''
    updatePending((current) => [...current, { id: turn.id, text: turn.text, instruction }])
  }, [updatePending])

  const consultation = useChatStream({
    onSentence: (text) => {
      const turn = activeTurn.current
      if (!turn || !latest.current.open) return
      turn.spoken.push(text)
      latest.current.voice.speak(text)
    },
    onAction: (result) => {
      const turn = activeTurn.current
      if (turn && requestsArtifact(result)) queueTurn(turn, result)
    },
  })

  const stop = consultation.stop
  const preserveInterruptedTurn = useCallback(() => {
    const turn = activeTurn.current
    if (!turn) return
    activeTurn.current = null
    queueTurn(turn)
    const spoken = turn.spoken.join(' ').trim()
    if (spoken) {
      const content = `${spoken}\n\n[Interrupted]`
      const ctx = latest.current
      appendConversationMessage({ id: makeId(), role: 'assistant', content, spokenLive: true, interrupted: true })
      if (turn.chatId) void ctx.persistMessage(turn.chatId, { role: 'assistant', content })
    }
  }, [queueTurn, appendConversationMessage])
  const reset = useCallback(() => {
    epoch.current += 1
    stop()
    activeTurn.current = null
    dispatching.current = false
    updatePending(() => [])
    replayRef.current = null
    conversationAdditions.current = []
    setReplayPhase(null)
    setRetryRequested(false)
    setWaitingTurns([])
    setPendingPaused(false)
    setAwaitingUtterance(false)
  }, [stop, updatePending])

  const handleUtterance = useCallback(async (value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    const ctx = latest.current
    if (!text || !ctx.open) return
    setAwaitingUtterance(false)
    ctx.voice.cancelSpeech()
    // A chat must exist before a second spoken turn can be persisted. Keep
    // every utterance, in order, across that short initial creation window.
    if (ctx.preparing || (dispatching.current && !ctx.artifactBusy)) {
      setWaitingTurns((current) => [...current, text])
      return
    }
    if (!ctx.artifactBusy && !activeTurn.current && !pendingRef.current.length && !replayRef.current) {
      ctx.stopReply()
      dispatching.current = true
      const submitEpoch = epoch.current
      try { await ctx.submit(text, { voiceTurn: true, attachmentsOverride: [] }) }
      catch { /* The ordinary chat stream renders its own retryable error. */ }
      finally {
        if (epoch.current === submitEpoch) {
          dispatching.current = false
          setWaitingTurns((current) => [...current])
        }
      }
      return
    }

    // Direct preview/PTT callers may not have emitted speech_started first.
    // Preserve the prior classified request and any speech before replacing it.
    preserveInterruptedTurn()
    stop()
    const turn = { id: makeId(), text, queued: false, spoken: [], chatId: ctx.chatId }
    activeTurn.current = turn
    const currentEpoch = epoch.current
    const userMessage = { id: turn.id, role: 'user', content: text, source: 'voice' }
    const history = [...ctx.messages, ...conversationAdditions.current.filter((item) => !ctx.messages.some((saved) => saved.id === item.id))]
    appendConversationMessage(userMessage)
    const saveTo = ctx.chatId
    if (saveTo) void ctx.persistMessage(saveTo, { role: 'user', content: text, source: 'voice', client_id: turn.id })
    const result = await consultation.start([
      ...history.map((message) => ({ role: message.role, content: chatMessageText(message) })),
      { role: 'user', content: text },
    ], {
      chatId: saveTo, classId: ctx.classId, weekNumber: ctx.weekNumber,
      activePlanId: ctx.planId, voice: true, mode: 'brainstorm',
      planWorkPending: Boolean(ctx.artifactBusy || replayRef.current), planOpen: Boolean(ctx.planId),
    }).catch(() => null)
    if (epoch.current !== currentEpoch || activeTurn.current !== turn) return
    activeTurn.current = null
    if (!result) {
      // A failed consultation has not classified the request. Preserve it for
      // the normal grounded flow instead of silently losing a spoken change.
      queueTurn(turn)
      const content = 'I’ve kept that request in the conversation. I’ll revisit it when this draft is ready.'
      appendConversationMessage({ id: makeId(), role: 'assistant', content })
      if (saveTo) void ctx.persistMessage(saveTo, { role: 'assistant', content })
      return
    }
    const questions = (result.questions || []).map((question) => question.text).filter((question) => !result.text?.includes(question)).join(' ')
    const content = [result.text?.trim(), questions].filter(Boolean).join(' ')
      || (turn.queued ? 'I’ve noted that change. I’ll apply it after this draft is saved.' : 'What else should we consider for your students?')
    appendConversationMessage({ id: makeId(), role: 'assistant', content, spokenLive: true })
    if (saveTo) void ctx.persistMessage(saveTo, { role: 'assistant', content })
    if (latest.current.open) {
      if (!result.spokeStream) ctx.voice.speak(content)
      else if (questions) ctx.voice.speak(questions)
    }
  }, [consultation, stop, preserveInterruptedTurn, queueTurn, appendConversationMessage])

  const interrupt = useCallback(() => {
    const ctx = latest.current
    if (!ctx.open) return
    setAwaitingUtterance(true)
    if (!ctx.preparing) ctx.stopReply()
    preserveInterruptedTurn()
    stop()
  }, [stop, preserveInterruptedTurn])
  const handleInputSettled = useCallback(() => setAwaitingUtterance(false), [])

  const settleReplay = useCallback((ok) => {
    const replay = replayRef.current
    if (!replay) return
    replayRef.current = null
    setReplayPhase(null)
    if (ok) updatePending((current) => current.filter((item) => !replay.ids.has(item.id)))
    else setPendingPaused(true)
  }, [updatePending])

  // submit resolves when the conversational tool is selected. Its artifact
  // runs afterward, so retain these requests until the page reports that save.
  useEffect(() => {
    const replay = replayRef.current
    if (!replay || replayPhase !== 'waiting-save') return
    const outcome = options.planWorkResult
    if (outcome?.id && outcome.id !== replay.baselineId) settleReplay(outcome.ok === true)
  }, [options.planWorkResult, replayPhase, settleReplay])

  useEffect(() => {
    const ctx = latest.current
    if (ctx.open || ctx.preparing || !ctx.chatId || !waitingTurns.length) return
    // Ending voice during chat creation must not discard already completed
    // utterances. Keep them in the transcript and offer an explicit retry.
    setWaitingTurns([])
    setPendingPaused(true)
    for (const text of waitingTurns) {
      const turn = { id: makeId(), text, queued: false }
      appendConversationMessage({ id: turn.id, role: 'user', content: text, source: 'voice' })
      void ctx.persistMessage(ctx.chatId, { role: 'user', content: text, source: 'voice', client_id: turn.id })
      queueTurn(turn)
    }
  }, [options.open, options.preparing, options.chatId, options.persistMessage, waitingTurns, appendConversationMessage, queueTurn])

  // Requests made during the build are applied in one ordered pass, against
  // the newly saved plan. This preserves later corrections and avoids stale
  // parallel writes. A failed build leaves requests visible for a retry.
  useEffect(() => {
    if (awaitingUtterance || consultation.isStreaming || activeTurn.current || dispatching.current || options.preparing) return
    if (!options.open && waitingTurns.length) return
    if (waitingTurns.length && options.open) {
      setWaitingTurns([])
      void handleUtterance(waitingTurns.join('\n'))
      return
    }
    if (options.busy || options.artifactBusy || replayRef.current) return
    if (pendingPaused || !pendingChanges.length || !options.planId || (options.saveState === 'error' && !retryRequested)) return
    const requests = pendingChanges.map((item, index) => `${index + 1}. ${item.text}${item.instruction ? `\nRequested change: ${item.instruction}` : ''}`).join('\n')
    replayRef.current = { ids: new Set(pendingChanges.map((item) => item.id)), baselineId: options.planWorkResult?.id }
    setReplayPhase('submitting')
    setRetryRequested(false)
    dispatching.current = true
    const replayEpoch = epoch.current
    void options.submit(
      `The draft has finished saving. Resolve these follow-up requests from our consultation against the current saved lesson. Apply requested edits, preserve unchanged days, and honor later corrections. If a request is only a question, answer it without editing.\n${requests}`,
      { voiceTurn: true, backgroundFollowUp: true, attachmentsOverride: [] },
    ).then((result) => {
      if (epoch.current !== replayEpoch) return
      if (!result) { settleReplay(false); return }
      if (requestsArtifact(result)) setReplayPhase('waiting-save')
      else settleReplay(true)
    }).catch(() => {
      if (epoch.current === replayEpoch) settleReplay(false)
    }).finally(() => {
      if (epoch.current !== replayEpoch) return
      dispatching.current = false
      setWaitingTurns((current) => [...current])
    })
  }, [options, consultation.isStreaming, waitingTurns, pendingChanges, pendingPaused, awaitingUtterance, retryRequested, handleUtterance, settleReplay])

  useEffect(() => {
    if (!options.open) stop()
    if (!options.open || ['idle', 'error'].includes(options.voice.status)) setAwaitingUtterance(false)
  }, [options.open, options.voice.status, stop])

  return {
    handleUtterance, handleInputSettled, interrupt, reset, pendingChanges,
    pendingPaused, retryPending: () => { setPendingPaused(false); setRetryRequested(true) },
    isStreaming: consultation.isStreaming,
    text: consultation.isStreaming ? consultation.text : '',
  }
}
