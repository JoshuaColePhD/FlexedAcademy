import { useCallback, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'

const SSE_PREFIX = 'data:'

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

  const start = useCallback(
    async (messages, { chatId, mode = 'standard' } = {}) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setIsStreaming(true)
      setText('')
      let accumulated = ''

      try {
        const res = await fetch(api.chatStreamUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, mode, chat_id: chatId ?? null }),
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

        const result = { text: accumulated, toolCalled }
        onDoneRef.current?.(result)
        return result
      } catch (err) {
        if (err.name === 'AbortError') return null
        onErrorRef.current?.(err)
        throw err
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        setIsStreaming(false)
      }
    },
    []
  )

  return { start, stop, reset, isStreaming, text }
}
