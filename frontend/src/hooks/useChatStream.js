import { useCallback, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'
import * as metrics from '../lib/voiceMetrics'

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

export function useChatStream({ onDone, onError, onGeneratePlan, onSentence } = {}) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [text, setText] = useState('')
  const abortRef = useRef(null)

  const onDoneRef = useRef(onDone)
  const onErrorRef = useRef(onError)
  const onGeneratePlanRef = useRef(onGeneratePlan)
  const onSentenceRef = useRef(onSentence)
  onDoneRef.current = onDone
  onErrorRef.current = onError
  onGeneratePlanRef.current = onGeneratePlan
  onSentenceRef.current = onSentence

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
    setText('')
  }, [])

  const reset = useCallback(() => {
    setText('')
  }, [])

  // One attempt: opens the SSE connection, accumulates chunks into `text` as
  // they arrive, and either returns the finished result or throws. Retrying
  // lives in `start`, not here, so a retry can't accidentally fire onDone
  // twice for the same logical request.
  const attempt = useCallback(async (messages, { chatId, mode, voice, weekNumber, controller }) => {
    let accumulated = ''
    setText('')

    const res = await fetch(api.chatStreamUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        mode,
        chat_id: chatId ?? null,
        voice: Boolean(voice),
        week_number: weekNumber ?? null,
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

    /* How much of `accumulated` has already been handed to onSentence. The
       caller (voice mode) starts synthesizing each sentence the moment it
       lands, so speech begins while the model is still writing — see
       VoiceProvider's queue. Nothing here changes for the text chat, which
       passes no onSentence at all. */
    let emittedTo = 0
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
      let cut = sentenceCut(pending)
      /* Nothing has ended a sentence yet, and this is still the turn's very
         first utterance — accept a clause boundary instead, so the opening
         acknowledgement goes out now rather than waiting for the whole first
         sentence. Only ever on the first emission (emittedTo === 0): every
         later cut wants a real sentence, because a mid-sentence fragment is
         synthesized with no prosodic shape and sounds like it. */
      if (cut <= 0 && emittedTo === 0) cut = openerCut(pending)
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

          if (event.error) {
            throw new ApiError(event.error.message || 'Generation failed.', {
              code: event.error.code || 'stream_error',
              hint: event.error.hint,
              extra: event.error,
            })
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

          if (event.chunk) {
            // Time-to-first-token, the middle third of the latency budget.
            // No-op outside voice mode (the metrics module only records while a
            // turn is open, and only VoiceModePanel opens one).
            if (!accumulated) metrics.firstToken()
            accumulated += event.chunk
            setText(accumulated)
            emitSentences(false)
          }

          if (event.done) {
            finished = event
          }
        }
      }
      if (done) break
    }

    if (!finished && !toolCalled) {
      throw new ApiError('The connection closed unexpectedly.', {
        code: 'stream_truncated',
        hint: 'Nothing was saved. Try again.',
      })
    }

    // Whatever tail never earned a sentence boundary of its own — a reply
    // that ends without punctuation, or one short enough to have none at all.
    emitSentences(true)
    // `spokeStream` tells the caller this reply has ALREADY been spoken,
    // piece by piece, so its own end-of-turn speak() would be a duplicate.
    return { text: accumulated, toolCalled, questions, quizRequested, spokeStream: emittedTo > 0 }
  }, [])

  const start = useCallback(
    async (messages, { chatId, mode = 'standard', voice = false, weekNumber } = {}) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)

      try {
        let lastErr = null
        for (let tryNum = 0; tryNum <= MAX_AUTO_RETRIES; tryNum++) {
          if (tryNum > 0) await sleep(RETRY_DELAY_MS)
          try {
            const result = await attempt(messages, { chatId, mode, voice, weekNumber, controller })
            onDoneRef.current?.(result)
            return result
          } catch (err) {
            if (err.name === 'AbortError') return null
            lastErr = err
            const retryable = RETRYABLE_CODES.has(err.code) || err.extra?.retryable
            if (!retryable || tryNum === MAX_AUTO_RETRIES) break
          }
        }
        onErrorRef.current?.(lastErr)
        throw lastErr
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        setIsStreaming(false)
      }
    },
    [attempt]
  )

  return { start, stop, reset, isStreaming, text }
}
