import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'
import * as metrics from '../lib/voiceMetrics'
import * as perf from '../lib/performanceMetrics'

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
  'upstream_timeout',
  'upstream_connection_error',
  'rate_limited',
  'malformed_tool_call',
  'empty_reply',
])
const MAX_AUTO_RETRIES = 1
const RETRY_DELAY_MS = 600

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

export function useChatStream({ onDone, onError, onGeneratePlan, onSentence, onRetry, onStatus } = {}) {
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
  const onSentenceRef = useRef(onSentence)
  const onRetryRef = useRef(onRetry)
  const onStatusRef = useRef(onStatus)
  onDoneRef.current = onDone
  onErrorRef.current = onError
  onGeneratePlanRef.current = onGeneratePlan
  onSentenceRef.current = onSentence
  onRetryRef.current = onRetry
  onStatusRef.current = onStatus

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
  const attempt = useCallback(async (messages, { chatId, classId, mode, voice, weekNumber, controller, requestId }) => {
    let accumulated = ''
    cancelQueuedText()
    setText('')

    const res = await fetch(api.chatStreamUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        mode,
        chat_id: chatId ?? null,
        class_id: classId ?? null,
        voice: Boolean(voice),
        week_number: weekNumber ?? null,
        request_id: requestId,
      }),
      signal: controller.signal,
      credentials: 'include',
    })

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
    let questions = null
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
      const { value, done } = await reader.read()
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
            }
            setStatus(nextStatus)
            perf.mark(`chat-stream:status:${nextStatus.code}`)
            onStatusRef.current?.(nextStatus)
          }

          if (event.tool_call === 'generate_lesson_plan') {
            toolCalled = true
            onGeneratePlanRef.current?.(accumulated)
          }

          // The clarifying-questions alternative — see backend/llm.py's
          // ask_clarifying_questions tool. Its arguments (the questions
          // themselves) are the entire payload, so unlike generate_lesson_plan
          // there's no separate call afterward to fetch anything from; the
          // event already carries the finished array.
          if (event.tool_call === 'ask_clarifying_questions') {
            questions = event.questions || []
          }

          // Its own arguments are the entire payload too, same reasoning as
          // ask_clarifying_questions just above.
          if (event.tool_call === 'generate_quiz') {
            quizRequested = {
              questionTypes: event.question_types || [],
              numQuestions: event.num_questions || 10,
              revisesCurrent: !!event.revises_current,
            }
          }

          // The targeted, one-field alternative to generate_lesson_plan —
          // see backend/llm.py's update_lesson_day tool. Same reasoning as
          // generate_quiz above: its own arguments are the entire payload.
          if (event.tool_call === 'update_lesson_day') {
            dayRevisionRequested = {
              day: event.day,
              field: event.field,
              feedback: event.feedback,
            }
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

    if (!finished && !toolCalled) {
      throw new ApiError('The connection closed unexpectedly.', {
        code: 'stream_truncated',
        hint: 'Nothing was saved. Try again.',
      })
    }

    /* Defensive recovery, not a fix for the real problem: every so often the
       model writes ask_clarifying_questions' own arguments out as literal
       streamed text instead of actually invoking the tool — the SSE stream
       never carries a `tool_call: 'ask_clarifying_questions'` event at all,
       so `questions` stays null and `accumulated` ends up holding a raw
       JSON blob like the very thing this tool's arguments schema describes.
       Left alone, that JSON renders verbatim in the chat — worse than any
       styling this hook's caller could apply, since there's no UI for "raw
       tool-call JSON." Recognizing and parsing it here at least gets the
       real, tappable question card on screen instead; the actual fix is
       getting the model to call the tool reliably (generate.py's system
       prompt), which no amount of client-side recovery can guarantee. */
    if (!questions && !toolCalled && !quizRequested && !dayRevisionRequested) {
      const trimmed = accumulated.trim()
      if (trimmed.startsWith('{') && trimmed.includes('"questions"')) {
        try {
          const parsed = JSON.parse(trimmed)
          if (Array.isArray(parsed.questions) && parsed.questions.length) {
            questions = sanitizeClarifyingQuestions(parsed.questions)
            accumulated = ''
          }
        } catch {
          // Not actually parseable JSON — leave it as plain text, same as
          // every other reply; nothing here makes that case any worse.
        }
      }
    }

    // Whatever tail never earned a sentence boundary of its own — a reply
    // that ends without punctuation, or one short enough to have none at all.
    emitSentences(true)
    // `spokeStream` tells the caller this reply has ALREADY been spoken,
    // piece by piece, so its own end-of-turn speak() would be a duplicate.
    return {
      text: accumulated,
      toolCalled,
      questions,
      quizRequested,
      dayRevisionRequested,
      spokeStream: emittedTo > 0,
    }
    // All three are useCallback'd with empty deps (they only touch refs), so
    // `attempt` stays referentially stable exactly as it was before.
  }, [cancelQueuedText, queueText, flushText])

  const start = useCallback(
    async (messages, { chatId, classId, mode = 'standard', voice = false, weekNumber } = {}) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const requestId = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      activeRequestRef.current = requestId
      window.clearTimeout(slowTimerRef.current)

      setIsStreaming(true)
      setStatus({ code: 'connecting', label: 'Connecting…', requestId })
      perf.mark('chat-stream:status:connecting')
      onStatusRef.current?.({ code: 'connecting', label: 'Connecting…', requestId })
      slowTimerRef.current = window.setTimeout(() => {
        if (activeRequestRef.current !== requestId) return
        const slowStatus = { code: 'still_working', label: 'Still working…', requestId }
        setStatus(slowStatus)
        onStatusRef.current?.(slowStatus)
      }, 7500)
      perf.mark('chat-stream:start')

      try {
        let lastErr = null
        for (let tryNum = 0; tryNum <= MAX_AUTO_RETRIES; tryNum++) {
          if (tryNum > 0) await sleep(RETRY_DELAY_MS)
          try {
            const result = await attempt(messages, { chatId, classId, mode, voice, weekNumber, controller, requestId })
            onDoneRef.current?.(result)
            setStatus({ code: 'complete', label: 'Ready', requestId })
            return result
          } catch (err) {
            if (err.name === 'AbortError') return null
            lastErr = err
            const retryable = RETRYABLE_CODES.has(err.code) || err.extra?.retryable
            if (!retryable || tryNum === MAX_AUTO_RETRIES) break
            // A voice stream may already have handed its first sentence to
            // Realtime before the network failed. Clear that partial attempt
            // before retrying the model, otherwise the retry speaks the same
            // opening sentence twice.
            onRetryRef.current?.()
            const retryStatus = { code: 'retrying', label: `Retrying… (${tryNum + 1}/${MAX_AUTO_RETRIES})`, requestId }
            setStatus(retryStatus)
            onStatusRef.current?.(retryStatus)
          }
        }
        onErrorRef.current?.(lastErr)
        setStatus({ code: 'error', label: lastErr?.message || 'Something went wrong', requestId })
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
