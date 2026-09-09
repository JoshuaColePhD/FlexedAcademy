import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'
import * as metrics from '../lib/voiceMetrics'
import * as perf from '../lib/performanceMetrics'
import { recoverDumpedToolsFromText } from '../lib/chatToolRecovery'

const SSE_PREFIX = 'data:'

// Backend-flagged retryable codes (upstream timeout/connection/rate-limit),
// plus stream_truncated — a dropped connection with no error frame at all,
// which is exactly the kind of blip a teacher shouldn't have to notice and
// manually retry. model_refusal, no_api_key, entitlement errors etc are never
// in this set: retrying those wastes a round trip on something that can't
// succeed differently.
//
// malformed_tool_call and empty_reply (backend/llm.py's stream_chat) are a
// different kind of failure from those upstream ones, but land in the same
// bucket for the same reason: both are the model botching ONE sample (bad
// JSON on a tool call, or finishing with nothing at all), not a structural
// problem with the request, so a fresh sample often just works.
const RETRYABLE_CODES = new Set([
  'stream_truncated',
  'stream_connection_error',
  'upstream_timeout',
  'upstream_connection_error',
  'rate_limited',
  'malformed_tool_call',
  'empty_reply',
])
const MAX_AUTO_RETRIES = 3
const RETRY_DELAY_MS = 800
// Idle silence, not total turn length. Keepalives and tokens reset this, so a
// slow but live reply is not aborted at 25s the way a hung connection is.
const ATTEMPT_TIMEOUT_MS = 25000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The backend removes this at the normal tool boundary. Keep the same small
// guard here for the defensive path below, where a model occasionally writes
// the tool JSON as literal text and the browser parses it itself.
function isDayShapeQuestion(question) {
  const text = `${question?.id || ''} ${question?.text || ''} ${(question?.options || []).join(' ')}`
  if (/(weekly\s+shape|week(?:ly)?\s+(?:length|duration|format)|what\s+(?:kind|type)\s+of\s+week|how\s+long\s+(?:should|must)\s+the\s+(?:week|plan)|how\s+many\s+(?:instructional|teaching|school|lesson)?\s*days?|number\s+of\s+(?:instructional|teaching|school|lesson)?\s*days?)/i.test(text)) return true
  const shapeOptions = (question?.options || []).filter((option) => /\b(?:full\s+instructional\s+days?|lessons?\s+plus|modified\s+week|shorter\s+week)\b/i.test(option)).length
  return shapeOptions >= 2 || (/\bweek\b/i.test(text) && shapeOptions >= 1)
}

function sanitizeClarifyingQuestions(questions) {
  const usable = (questions || []).filter((question) => question && !isDayShapeQuestion(question))
  return usable.length ? usable : [{
    id: 'lesson_focus',
    text: 'What should this week focus on?',
    options: ['A specific text or chapter', 'A skill or standard', 'A unit topic', 'A project or assessment'],
  }]
}

/* Index just past the last point in `s` that a sentence demonstrably ended.
 *
 * "Demonstrably" is the whole job: the text arrives a few characters at a
 * time, so a trailing "." might be the end of a sentence or the middle of
 * "3.5" or "Sept." with more still coming. Requiring the punctuation to be
 * FOLLOWED by whitespace (after skipping any closing quote/bracket) is what
 * makes a cut safe to speak — an unterminated tail just waits for the next
 * chunk. Returns -1 when nothing is safely cuttable yet.
 */
function sentenceCut(s) {
  let idx = -1
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\n') {
      idx = i + 1
      continue
    }
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue
    let j = i + 1
    while (j < s.length && `"')]”’`.includes(s[j])) j++
    // Still the last character we've received — it may yet grow into a
    // decimal or an abbreviation, so it isn't a boundary we can trust.
    if (j >= s.length) continue
    if (/\s/.test(s[j])) idx = j
  }
  return idx
}

/* How far into a turn's FIRST utterance we'll accept a clause boundary — a
   comma or a dash — as a place to cut, when no sentence has ended yet.
   Deliberately small: this exists only to get the opening acknowledgement out
   fast, and cutting mid-sentence anywhere else would hand the TTS a fragment
   with no prosodic shape. */
const OPENER_MAX_CHARS = 32

/* The opening acknowledgement, cut as early as it is safe to.
 *
 * Voice mode's system prompt asks the model to begin every spoken turn with a
 * two-or-three-word acknowledgement punctuated as its own sentence ("Got it."),
 * because that fragment is what the teacher hears within a few hundred
 * milliseconds instead of sitting in silence — and a silence past roughly 700ms
 * is heard as reluctance rather than as thinking. When the model complies,
 * sentenceCut above already finds it and nothing here is needed.
 *
 * This is the fallback for when it drifts and opens with a comma instead
 * ("Okay, so for week seven…"). Without it, a drifted turn waits for the whole
 * first sentence and the acknowledgement stops buying anything. Returns -1 when
 * there's nothing short and safe to cut.
 */
function openerCut(s) {
  const limit = Math.min(s.length, OPENER_MAX_CHARS)
  for (let i = 0; i < limit; i++) {
    if (s[i] !== ',' && s[i] !== '—' && s[i] !== '–') continue
    // Same "must be followed by something" rule as sentenceCut: a trailing
    // comma may still be mid-number, and we can't speak what hasn't arrived.
    if (i + 1 >= s.length) continue
    if (!/\s/.test(s[i + 1])) continue
    // At least two words in front of it, so "Hi, " qualifies but a stray
    // leading comma doesn't.
    if (s.slice(0, i).trim().split(/\s+/).length < 1) continue
    return i + 1
  }
  return -1
}

function quizRequestedFromEvent(event) {
  return {
    questionTypes: event.question_types || [],
    numQuestions: event.num_questions || 5,
    passageMode: event.passage_mode || 'none',
    passageTitle: event.passage_title || '',
    passageText: event.passage_text || '',
    revisesCurrent: !!event.revises_current,
    sourcePlanId: event.source_plan_id,
    targetQuizId: event.target_quiz_id,
    instruction: event.instruction,
    questionIndices: (event.question_numbers || []).map((n) => n - 1),
  }
}

export function useChatStream({ onDone, onError, onGeneratePlan, onAction, onSentence, onRetry, onStatus, onStart } = {}) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [text, setText] = useState('')
  const [status, setStatus] = useState(null)
  const abortRef = useRef(null)
  const activeRequestRef = useRef(null)
  const slowTimerRef = useRef(null)

  /* Chunk-to-render coalescing.
   *
   * setText used to run once per SSE chunk — i.e. per token. Each of those
   * re-rendered ChatPage (a 3,600-line component), and ChatPage's own effect
   * then mirrored the new text into `messages`, re-rendering it a SECOND
   * time. Two full renders per token, and the model emits them far faster
   * than the browser can paint, so most of that work was for frames nobody
   * ever saw.
   *
   * rAF collapses a burst of chunks into at most one state update per frame:
   * the text still arrives token-by-token, it just stops asking React to
   * render faster than the display refreshes. flushText() forces the pending
   * value out at the end of a stream so the last few tokens can't be left
   * sitting in a frame that never comes (the stream ends, no more chunks
   * arrive to schedule one). */
  const pendingTextRef = useRef(null)
  const rafRef = useRef(null)
  const flushText = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (pendingTextRef.current != null) {
      setText(pendingTextRef.current)
      pendingTextRef.current = null
    }
  }, [])
  const queueText = useCallback((value) => {
    pendingTextRef.current = value
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (pendingTextRef.current == null) return
      setText(pendingTextRef.current)
      pendingTextRef.current = null
    })
  }, [])
  // A stream aborted mid-flight (stop(), or unmount) must not land a queued
  // frame afterwards and resurrect text the caller just cleared.
  const cancelQueuedText = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    pendingTextRef.current = null
  }, [])
  useEffect(() => () => {
    abortRef.current?.abort()
    abortRef.current = null
    activeRequestRef.current = null
    window.clearTimeout(slowTimerRef.current)
    cancelQueuedText()
  }, [cancelQueuedText])

  const onDoneRef = useRef(onDone)
  const onErrorRef = useRef(onError)
  const onGeneratePlanRef = useRef(onGeneratePlan)
  const onActionRef = useRef(onAction)
  const onSentenceRef = useRef(onSentence)
  const onRetryRef = useRef(onRetry)
  const onStatusRef = useRef(onStatus)
  const onStartRef = useRef(onStart)
  onDoneRef.current = onDone
  onErrorRef.current = onError
  onGeneratePlanRef.current = onGeneratePlan
  onActionRef.current = onAction
  onSentenceRef.current = onSentence
  onRetryRef.current = onRetry
  onStatusRef.current = onStatus
  onStartRef.current = onStart

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    activeRequestRef.current = null
    window.clearTimeout(slowTimerRef.current)
    setIsStreaming(false)
    setStatus({ code: 'cancelled', label: 'Stopped' })
    cancelQueuedText()
    setText('')
  }, [cancelQueuedText])

  const reset = useCallback(() => {
    cancelQueuedText()
    setText('')
  }, [cancelQueuedText])

  // One attempt: opens the SSE connection, accumulates chunks into `text` as
  // they arrive, and either returns the finished result or throws. Retrying
  // lives in `start`, not here, so a retry can't accidentally fire onDone
  // twice for the same logical request.
  const attempt = useCallback(async (messages, { chatId, classId, mode, voice, weekNumber, activePlanId, activeQuizId, referenceContext, hasQuiz, controller, requestId, attempt, onProgress, emitAction }) => {
    let accumulated = ''
    cancelQueuedText()
    setText('')

    let res
    try {
      res = await fetch(api.chatStreamUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          reference_context: referenceContext || '',
          mode,
          chat_id: chatId ?? null,
          class_id: classId ?? null,
          active_plan_id: activePlanId ?? null,
          active_quiz_id: activeQuizId ?? null,
          voice: Boolean(voice),
          week_number: weekNumber ?? null,
          has_quiz: Boolean(hasQuiz),
          request_id: requestId,
          attempt,
        }),
        signal: controller.signal,
        credentials: 'include',
      })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      // Fetch rejects with a browser-specific TypeError when a proxy, wifi
      // connection, or server disappears before the SSE response exists. A
      // raw TypeError has no stable code, so use the same retryable envelope
      // as a mid-stream disconnect. Without this, the teacher saw a failed
      // turn even though the existing one-retry policy could have recovered
      // it safely.
      throw new ApiError('The connection dropped before the reply started.', {
        code: 'stream_connection_error',
        extra: { retryable: true },
      })
    }

    if (!res.ok || !res.body) {
      let payload = null
      try {
        payload = await res.json()
      } catch {}
      throw apiErrorFromBody(payload, res.status)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let finished = null
    let toolCalled = false
    let planAction = null
    let questions = null
    let researchSources = null
    // The generate_quiz alternative — see backend/llm.py's tool declaration.
    // A SEPARATE field from `toolCalled`/`questions`, not folded into either:
    // toolCalled means "go build the plan," and a caller checking only that
    // flag (ChatPage's submit does, right after chatStream.start resolves)
    // would otherwise try to build a plan for a quiz request instead of
    // building the quiz.
    let quizRequested = null
    // The update_lesson_day alternative — same separate-field reasoning as
    // quizRequested just above: a caller checking only `toolCalled` would
    // otherwise try to rebuild the whole week for what was meant to be a
    // one-field, surgical change.
    let dayRevisionRequested = null

    /* How much of `accumulated` has already been handed to onSentence. The
       caller (voice mode) starts synthesizing each sentence the moment it
       lands, so speech begins while the model is still writing — see
       VoiceProvider's queue. Nothing here changes for the text chat, which
       passes no onSentence at all. */
    let emittedTo = 0
    /* True once the opener has been cut and handed off. voiceSpeechQueue is
       strictly serial — it will not even SEND the next response.create until
       the Realtime API reports the previous one `response.done` (see its own
       comment on why: the Realtime API models one response at a time per
       conversation, so overlapping calls isn't something the client gets to
       choose). Every additional mid-stream cut past the opener was therefore
       a full extra model-response round trip, with dead air between each
       one — a five-sentence reply cost five serialized turnarounds instead
       of one. Cutting only ONCE here (the opener, for the "the teacher hears
       something within a third of a second" win) and letting everything
       else go out as a single flush at the end turns that into exactly two
       response.create calls no matter how long the reply runs. */
    const emitSentences = (final) => {
      if (!onSentenceRef.current) return
      const pending = accumulated.slice(emittedTo)
      if (!pending.trim()) {
        if (final) emittedTo = accumulated.length
        return
      }
      if (final) {
        emittedTo = accumulated.length
        const rest = pending.trim()
        if (rest) onSentenceRef.current(rest)
        return
      }
      if (emittedTo > 0) return // opener already sent; the rest waits for the final flush
      let cut = sentenceCut(pending)
      /* Nothing has ended a sentence yet, and this is still the turn's very
         first utterance — accept a clause boundary instead, so the opening
         acknowledgement goes out now rather than waiting for the whole first
         sentence. A mid-sentence fragment anywhere else is synthesized with
         no prosodic shape and sounds like it, which is why this only ever
         fires for the opener (emittedTo === 0, checked above). */
      if (cut <= 0) cut = openerCut(pending)
      if (cut <= 0) return
      const chunk = pending.slice(0, cut).trim()
      emittedTo += cut
      if (chunk) onSentenceRef.current(chunk)
    }

    for (;;) {
      let next
      try {
        next = await reader.read()
      } catch (err) {
        if (err.name === 'AbortError') throw err
        // A connection can disappear after accepted/context events but before
        // the model finishes. Treat that exactly like the pre-response case:
        // the caller can retry the same logical turn and the UI can keep its
        // request id while replacing the incomplete stream.
        throw new ApiError('The connection dropped while the reply was loading.', {
          code: 'stream_connection_error',
          extra: { retryable: true },
        })
      }
      onProgress?.()
      const { value, done } = next
      if (value) {
        buffer += decoder.decode(value, { stream: !done })

        const records = buffer.split('\n\n')
        buffer = records.pop() ?? ''

        for (const record of records) {
          const line = record.split('\n').find((l) => l.startsWith(SSE_PREFIX))
          if (!line) continue

          let event
          try {
            event = JSON.parse(line.slice(SSE_PREFIX.length).trim())
          } catch {
            continue
          }

          // Fetch aborts are best-effort. Ignore a frame that was already
          // queued by the browser after a newer send took ownership.
          if (activeRequestRef.current !== requestId) continue
          if (event.request_id && event.request_id !== requestId) continue
          if (event.attempt != null && event.attempt !== attempt) continue

          if (event.error) {
            throw new ApiError(event.error.message || 'Generation failed.', {
              code: event.error.code || 'stream_error',
              hint: event.error.hint,
              extra: event.error,
            })
          }

          if (event.status || event.status_code) {
            const nextStatus = {
              code: event.status_code || event.status,
              label: event.label || event.message || event.status_label || event.status,
              requestId: event.request_id || requestId,
              attempt: event.attempt ?? 0,
            }
            setStatus(nextStatus)
            perf.mark(`chat-stream:status:${nextStatus.code}`)
            onStatusRef.current?.(nextStatus)
          }

          if (event.tool_call === 'generate_lesson_plan') {
            toolCalled = true
            planAction = event.action ? event : null
            emitAction?.({
              requestId,
              text: accumulated,
              toolCalled,
              planAction,
              quizRequested,
              dayRevisionRequested,
            })
          }

          // The clarifying-questions alternative — see backend/llm.py's
          // ask_clarifying_questions tool. Its arguments (the questions
          // themselves) are the entire payload, so unlike generate_lesson_plan
          // there's no separate call afterward to fetch anything from; the
          // event already carries the finished array.
          if (event.tool_call === 'ask_clarifying_questions') {
            toolCalled = true
            questions = event.questions || []
          }

          if (event.tool_call) {
            onStatusRef.current?.({
              code: 'tool_call',
              label: event.tool_call === 'generate_quiz' ? 'Quiz action selected' : 'Planning action selected',
              requestId,
              attempt: event.attempt ?? 0,
              tool: event.tool_call,
            })
          }

          if (event.research_sources) {
            researchSources = Array.isArray(event.research_sources) ? event.research_sources : []
          }

          // Its own arguments are the entire payload too, same reasoning as
          // ask_clarifying_questions just above.
          if (event.tool_call === 'generate_quiz') {
            toolCalled = true
            quizRequested = quizRequestedFromEvent(event)
            emitAction?.({
              requestId,
              text: accumulated,
              toolCalled,
              planAction,
              quizRequested,
              dayRevisionRequested,
            })
          }

          // The targeted, one-field alternative to generate_lesson_plan —
          // see backend/llm.py's update_lesson_day tool. Same reasoning as
          // generate_quiz above: its own arguments are the entire payload.
          if (event.tool_call === 'update_lesson_day') {
            toolCalled = true
            dayRevisionRequested = {
              targetPlanId: event.target_plan_id,
              day: event.day,
              field: event.field,
              feedback: event.feedback,
            }
            emitAction?.({
              requestId,
              text: accumulated,
              toolCalled,
              planAction,
              quizRequested,
              dayRevisionRequested,
            })
          }

          if (event.chunk) {
            // Time-to-first-token, the middle third of the latency budget.
            // No-op outside voice mode (the metrics module only records while a
            // turn is open, and only VoiceModePanel opens one).
            if (!accumulated) {
              metrics.firstToken()
              perf.mark('chat-stream:first-token')
              perf.measure('chat-stream:time-to-first-token', 'chat-stream:start', 'chat-stream:first-token')
            }
            accumulated += event.chunk
            queueText(accumulated)
            emitSentences(false)
          }

          if (event.done) {
            finished = event
          }
        }
      }
      if (done) break
    }

    /* The stream is over, so no further chunk will arrive to schedule the
       frame that would have painted the tail. Force the last queued value out
       (see queueText) — without this the final few tokens of every reply
       stayed pending forever. */
    flushText()
    perf.mark('chat-stream:end')
    perf.measure('chat-stream:duration', 'chat-stream:start', 'chat-stream:end')

    if (!finished) {
      if (quizRequested || dayRevisionRequested || planAction) {
        // The artifact action already arrived; retrying chat would only delay
        // a build that onAction has already started.
        emitAction?.({
          requestId,
          text: accumulated,
          toolCalled,
          planAction,
          quizRequested,
          dayRevisionRequested,
        })
      } else {
        throw new ApiError('The connection closed unexpectedly.', {
          code: 'stream_truncated',
          hint: 'Nothing was saved. Try again.',
        })
      }
    }

    const recovered = recoverDumpedToolsFromText(accumulated, {
      questions,
      toolCalled,
      quizRequested,
      dayRevisionRequested,
    })
    questions = recovered.questions
    accumulated = recovered.text
    if (recovered.quizRequested) {
      toolCalled = true
      quizRequested = recovered.quizRequested
    }
    if (recovered.dayRevisionRequested) {
      toolCalled = true
      dayRevisionRequested = recovered.dayRevisionRequested
    }
    if (questions) questions = voice ? sanitizeClarifyingQuestions(questions) : sanitizeClarifyingQuestions(questions).slice(0, 1)
    if (!questions && (quizRequested || dayRevisionRequested || planAction)) {
      emitAction?.({
        requestId,
        text: accumulated,
        toolCalled,
        planAction,
        quizRequested,
        dayRevisionRequested,
      })
    }

    // Whatever tail never earned a sentence boundary of its own — a reply
    // that ends without punctuation, or one short enough to have none at all.
    emitSentences(true)
    if (activeRequestRef.current !== requestId || controller.signal.aborted) return null
    if (toolCalled) onGeneratePlanRef.current?.(accumulated, requestId)
    // `spokeStream` tells the caller this reply has ALREADY been spoken,
    // piece by piece, so its own end-of-turn speak() would be a duplicate.
    return {
      text: accumulated,
      requestId,
      toolCalled,
      planAction,
      questions,
      quizRequested,
      dayRevisionRequested,
      researchSources,
      spokeStream: emittedTo > 0,
    }
    // All three are useCallback'd with empty deps (they only touch refs), so
    // `attempt` stays referentially stable exactly as it was before.
  }, [cancelQueuedText, queueText, flushText])

  const start = useCallback(
    async (messages, { chatId, classId, mode = 'standard', voice = false, weekNumber, activePlanId, activeQuizId, referenceContext = '', hasQuiz = false, requestId: requestedRequestId } = {}) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const requestId = requestedRequestId || (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
      activeRequestRef.current = requestId
      let actionEmitted = false
      const emitAction = (payload) => {
        if (actionEmitted || !payload) return
        actionEmitted = true
        onActionRef.current?.(payload)
      }
      onStartRef.current?.({ requestId, attempt: 0 })
      window.clearTimeout(slowTimerRef.current)

      setIsStreaming(true)
      setStatus({ code: 'connecting', label: 'Connecting…', requestId })
      perf.mark('chat-stream:status:connecting')
      onStatusRef.current?.({ code: 'connecting', label: 'Connecting…', requestId })
      slowTimerRef.current = window.setTimeout(() => {
        if (activeRequestRef.current !== requestId) return
        const slowStatus = { code: 'still_working', label: 'Still working…', requestId, attempt: 0 }
        setStatus(slowStatus)
        onStatusRef.current?.(slowStatus)
      }, 7500)
      perf.mark('chat-stream:start')

      try {
        let lastErr = null
        for (let tryNum = 0; tryNum <= MAX_AUTO_RETRIES; tryNum++) {
          if (controller.signal.aborted) return null
          if (tryNum > 0) await sleep(RETRY_DELAY_MS * tryNum)
          if (controller.signal.aborted) return null
          const attemptController = new AbortController()
          const onParentAbort = () => attemptController.abort()
          controller.signal.addEventListener('abort', onParentAbort)
          let timeoutId
          const bumpIdleTimeout = () => {
            window.clearTimeout(timeoutId)
            timeoutId = window.setTimeout(() => attemptController.abort(), ATTEMPT_TIMEOUT_MS)
          }
          bumpIdleTimeout()
          try {
            const result = await attempt(messages, {
              chatId,
              classId,
              mode,
              voice,
              weekNumber,
              activePlanId,
              activeQuizId,
              referenceContext,
              hasQuiz,
              controller: attemptController,
              requestId,
              attempt: tryNum,
              onProgress: bumpIdleTimeout,
              emitAction,
            })
            if (!result || activeRequestRef.current !== requestId || controller.signal.aborted) return null
            onDoneRef.current?.(result)
            setStatus({ code: 'complete', label: 'Ready', requestId })
            return result
          } catch (err) {
            if (controller.signal.aborted || activeRequestRef.current !== requestId) return null
            lastErr = err.name === 'AbortError'
              ? new ApiError('The connection dropped before the reply started.', {
                code: 'stream_connection_error',
                extra: { retryable: true },
              })
              : err
            const retryable = RETRYABLE_CODES.has(lastErr.code) || lastErr.extra?.retryable
            const maxTries = (lastErr.code === 'malformed_tool_call' || lastErr.code === 'empty_reply')
              ? 1
              : MAX_AUTO_RETRIES
            if (!retryable || tryNum >= maxTries) break
            onRetryRef.current?.()
            const retryStatus = { code: 'retrying', label: 'Still working…', requestId, attempt: tryNum }
            setStatus(retryStatus)
            onStatusRef.current?.(retryStatus)
          } finally {
            window.clearTimeout(timeoutId)
            controller.signal.removeEventListener('abort', onParentAbort)
            if (!attemptController.signal.aborted) attemptController.abort()
          }
        }
        onErrorRef.current?.(lastErr)
        setStatus({ code: 'error', label: 'Could not finish the reply', requestId })
        throw lastErr
      } finally {
        if (activeRequestRef.current === requestId) {
          activeRequestRef.current = null
          window.clearTimeout(slowTimerRef.current)
          if (abortRef.current === controller) abortRef.current = null
          setIsStreaming(false)
        }
      }
    },
    [attempt]
  )

  return { start, stop, reset, isStreaming, text, status }
}
