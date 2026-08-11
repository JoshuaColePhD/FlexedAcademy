import { useCallback, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'

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
  const attempt = useCallback(async (messages, { chatId, mode, voice, controller }) => {
    let accumulated = ''
    setText('')

    const res = await fetch(api.chatStreamUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, mode, chat_id: chatId ?? null, voice: Boolean(voice) }),
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
      const cut = sentenceCut(pending)
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

          if (event.chunk) {
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
    return { text: accumulated, toolCalled, questions, spokeStream: emittedTo > 0 }
  }, [])

  const start = useCallback(
    async (messages, { chatId, mode = 'standard', voice = false } = {}) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)

      try {
        let lastErr = null
        for (let tryNum = 0; tryNum <= MAX_AUTO_RETRIES; tryNum++) {
          if (tryNum > 0) await sleep(RETRY_DELAY_MS)
          try {
            const result = await attempt(messages, { chatId, mode, voice, controller })
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
