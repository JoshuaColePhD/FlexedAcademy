import { useCallback, useRef, useState } from 'react'
import { ApiError, api } from '../lib/api'
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
   doesn't leave a request running. */

const SSE_PREFIX = 'data:'

export function useLessonStream({ onDone, onError } = {}) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState(null)
  const [grounding, setGrounding] = useState(null)
  const abortRef = useRef(null)

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
  }, [])

  const reset = useCallback(() => {
    setText('')
    setPreview(null)
    setGrounding(null)
  }, [])

  const start = useCallback(
    async (query, { chatId } = {}) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)
      setText('')
      setPreview(null)
      setGrounding(null)

      let accumulated = ''

      try {
        const res = await fetch(api.streamUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, chat_id: chatId ?? null }),
          signal: controller.signal,
        })

        if (!res.ok || !res.body) {
          let payload = null
          try {
            payload = await res.json()
          } catch {
            /* non-JSON error body */
          }
          const e = payload?.error
          throw new ApiError(e?.message || `The server rejected the request (${res.status}).`, {
            code: e?.code || 'http_error',
            hint: e?.hint,
            status: res.status,
            extra: e || {},
          })
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        let finished = null

        // Read until the stream ends, keeping any trailing partial record.
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const records = buffer.split('\n\n')
          buffer = records.pop() ?? '' // incomplete record stays in the buffer

          for (const record of records) {
            const line = record.split('\n').find((l) => l.startsWith(SSE_PREFIX))
            if (!line) continue

            let event
            try {
              event = JSON.parse(line.slice(SSE_PREFIX.length).trim())
            } catch {
              // A malformed control record is genuinely ignorable — but note
              // this catch covers ONLY the envelope, never the payload below.
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

        if (!finished) {
          throw new ApiError('The connection closed before the plan was finished.', {
            code: 'stream_truncated',
            hint: 'Nothing was saved. Try again.',
          })
        }

        setPreview(finished.plan ?? null)
        onDone?.(finished)
        return finished
      } catch (err) {
        if (err.name === 'AbortError') return null // user pressed Stop
        onError?.(err)
        throw err
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        setIsStreaming(false)
      }
    },
    [onDone, onError]
  )

  return { start, stop, reset, isStreaming, text, preview, grounding }
}
