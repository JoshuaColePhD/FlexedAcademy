import { useCallback, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'

export function useChatStream({ onError } = {}) {
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef(null)

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
  }, [])

  const start = useCallback(
    async (messages, mode, { onChunk, onDone }) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)
      let accumulated = ''

      try {
        const res = await fetch(api.chatStreamUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, mode }),
          signal: controller.signal,
          credentials: 'include',
        })

        if (!res.ok) {
          /* Was `new Error('Server error')`, which discarded the backend's
             {code, message, hint} envelope — and the hint is the half that tells
             the teacher what to do. Same parser the rest of the app uses. */
          let body = null
          try {
            body = await res.json()
          } catch {
            /* non-JSON error page — apiErrorFromBody falls back to the status */
          }
          throw apiErrorFromBody(body, res.status)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        const SSE_PREFIX = 'data:'

        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

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
              throw new ApiError(event.error.message || 'The reply failed.', {
                code: event.error.code || 'stream_error',
                hint: event.error.hint,
                extra: event.error,
              })
            }

            if (event.chunk) {
              accumulated += event.chunk
              onChunk(accumulated)
            }

            if (event.done) {
              onDone?.()
            }
          }
        }
        setIsStreaming(false)
      } catch (err) {
        setIsStreaming(false)
        if (err.name === 'AbortError') return
        onError?.(err)
      }
    },
    [onError]
  )

  return { start, stop, isStreaming }
}
