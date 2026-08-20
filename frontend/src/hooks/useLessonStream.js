import { useCallback, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'
import { parsePartialJson, usablePlan } from '../lib/partialJson'

/* All the streaming logic, in one place.

   Three bugs from the old inline version are fixed here:

   1. The old `catch (e) {}` wrapped the whole per-line block, so it swallowed
      the server's `data.error`, the intentional preview parse, AND the final
      JSON.parse. Worse than hiding errors: because the backend only stripped
      markdown fences after streaming finished, a SUCCESSFUL generation whose
      text arrived fenced also died there — leaving "Generating lesson plan…"
      forever with no spinner. Here only the preview parse is tolerant; a
      terminal `error` event rejects, and a bad final payload rejects.

   2. No buffer across reads, so a `data:` line split across two network chunks
      was dropped and the accumulated JSON silently corrupted. Now a buffer is
      carried between reads and split on the SSE record separator.

   3. `line.replace('data: ', '')` replaced the first occurrence anywhere in the
      line, not the prefix — and the payload is raw model text, which can contain
      "data: ". Now it's a checked prefix slice.

   Plus a real AbortController, so Stop actually stops and navigating away
   doesn't leave a request running.

   Two further fixes, 2026-08-04:

   4. `grounding` is now held in a ref as well as state, and merged into the value
      start() resolves with. ChatPage reads `stream.grounding` from the closure it
      captured BEFORE the grounding event arrived, and the `done` event doesn't
      carry it — so the saved artifact got null and the grounding strip vanished
      the moment a plan finished. That strip is the app's whole differentiator, so
      it was disappearing exactly when the teacher would look at it.

   5. onDone/onError live in refs, so `start` — and therefore the whole returned
      object, and every callback in ChatPage built from it — stops being rebuilt on
      every render. ChatPage passes an inline arrow for onError. */

const SSE_PREFIX = 'data:'

// See useChatStream's identical constant for the reasoning: only retry codes
// the backend or the reader itself flags as transient, and only a bounded
// number of times, so a request that can never succeed doesn't loop forever.
const RETRYABLE_CODES = new Set(['stream_truncated', 'upstream_timeout', 'upstream_connection_error', 'rate_limited'])
const MAX_AUTO_RETRIES = 1
const RETRY_DELAY_MS = 600

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function useLessonStream({ onDone, onError } = {}) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState(null)
  const [grounding, setGrounding] = useState(null)
  const abortRef = useRef(null)
  // Mirrors the grounding state so the resolved value can carry it — state set
  // mid-stream is not visible to the closure that started the stream.
  const groundingRef = useRef(null)

  // Latest callbacks without making them dependencies of `start`.
  const onDoneRef = useRef(onDone)
  const onErrorRef = useRef(onError)
  onDoneRef.current = onDone
  onErrorRef.current = onError

  /* Stopping CLEARS the half-written week.
   *
   * It used to abort and leave `text`, `preview` and `grounding` standing, and
   * `reset` existed with no callers at all. So after Stop the rail went on
   * showing the abandoned plan as though it were finished — with no planId, so
   * nothing to download — and because `preview` sits outside the state the
   * chat loader clears, it followed you into the NEXT chat: press Stop, click
   * New plan, and the greeting appeared with the dead week docked beside it.
   *
   * Order matters: abort first, then clear, so the reader's `finally` cannot
   * race a stale value back in. */
  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
    setText('')
    setPreview(null)
    setGrounding(null)
    groundingRef.current = null
  }, [])

  const reset = useCallback(() => {
    setText('')
    setPreview(null)
    setGrounding(null)
    groundingRef.current = null
  }, [])

  // One attempt: opens the SSE connection and either returns the finished
  // result or throws. Retrying lives in `start`, not here — see useChatStream
  // for why that split matters (onDone must fire at most once per call).
  const attempt = useCallback(async (query, { chatId, weekNumber, classId, controller }) => {
    setText('')
    setPreview(null)
    setGrounding(null)
    groundingRef.current = null

    let accumulated = ''

    const res = await fetch(api.streamUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        chat_id: chatId ?? null,
        week_number: weekNumber ?? null,
        // The page's own class (ChatPage's classId route param), not just
        // the chat's stored one — an older chat can have no class_id of its
        // own, and the backend now refuses to guess one. See generate.py's
        // GenerateRequest.class_id for the write-side half of this fix.
        class_id: classId ?? null,
      }),
      signal: controller.signal,
      credentials: 'include',
    })

    if (!res.ok || !res.body) {
      let payload = null
      try {
        payload = await res.json()
      } catch {
        /* non-JSON error body */
      }
      // Was a second hand-rolled copy of api.js's envelope parsing; one
      // function should decide how a backend error becomes an ApiError.
      throw apiErrorFromBody(payload, res.status)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let finished = null

    // Read until the stream ends, keeping any trailing partial record.
    for (;;) {
      const { value, done } = await reader.read()
      if (value) {
        buffer += decoder.decode(value, { stream: !done })

        const records = buffer.split('\n\n')
        buffer = records.pop() ?? '' // incomplete record stays in the buffer

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
          if (event.grounding) {
            setGrounding(event.grounding)
            groundingRef.current = event.grounding
          }
          if (event.chunk) {
            accumulated += event.chunk
            setText(accumulated)
            const parsed = usablePlan(parsePartialJson(accumulated))
            if (parsed) setPreview(parsed)
          }
          if (event.done) {
            finished = event
          }
        }
      }
      if (done) break
    }

    if (!finished) {
      throw new ApiError('The connection closed before the plan was finished.', {
        code: 'stream_truncated',
        hint: 'Nothing was saved. Try again.',
      })
    }

    setPreview(finished.plan ?? null)
    // Grounding rides along, because `finished` (the done event) has none and
    // the caller's `stream.grounding` is a stale read.
    return { ...finished, grounding: groundingRef.current }
  }, [])

  const start = useCallback(
    async (query, { chatId, weekNumber, classId } = {}) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)

      try {
        let lastErr = null
        for (let tryNum = 0; tryNum <= MAX_AUTO_RETRIES; tryNum++) {
          if (tryNum > 0) await sleep(RETRY_DELAY_MS)
          try {
            const result = await attempt(query, { chatId, weekNumber, classId, controller })
            onDoneRef.current?.(result)
            return result
          } catch (err) {
            if (err.name === 'AbortError') return null // user pressed Stop
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

  return { start, stop, reset, isStreaming, text, preview, grounding }
}
