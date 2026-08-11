import { useCallback, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'

const SSE_PREFIX = 'data:'

// Backend-flagged retryable codes (upstream timeout/connection/rate-limit),
// plus stream_truncated — a dropped connection with no error frame at all,
// which is exactly the kind of blip a teacher shouldn't have to notice and
// manually retry. model_refusal, no_api_key, entitlement errors etc are never
// in this set: retrying those wastes a round trip on something that can't
// succeed differently.
const RETRYABLE_CODES = new Set(['stream_truncated', 'upstream_timeout', 'upstream_connection_error', 'rate_limited'])
const MAX_AUTO_RETRIES = 1
const RETRY_DELAY_MS = 600

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function useChatStream({ onDone, onError, onGeneratePlan } = {}) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [text, setText] = useState('')
  const abortRef = useRef(null)

  const onDoneRef = useRef(onDone)
  const onErrorRef = useRef(onError)
  const onGeneratePlanRef = useRef(onGeneratePlan)
  onDoneRef.current = onDone
  onErrorRef.current = onError
  onGeneratePlanRef.current = onGeneratePlan

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

    return { text: accumulated, toolCalled, questions }
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
