import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, apiErrorFromBody } from '../lib/api'
import { droppedConnectionCopy, isDroppedConnectionError } from '../lib/streamTransport'
import { parsePartialJson, usablePlan } from '../lib/partialJson'
import { applyPlanPatch, activeWorkingCellKey } from '../lib/planShape'
import * as perf from '../lib/performanceMetrics'

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
const RETRYABLE_CODES = new Set(['stream_truncated', 'stream_connection_error', 'upstream_timeout', 'upstream_connection_error', 'rate_limited'])
const MAX_AUTO_RETRIES = 2
const RETRY_DELAY_MS = 600

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function waitForVisible(signal) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      resolve()
      return
    }
    const cleanup = () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pageshow', onVis)
      signal?.removeEventListener('abort', onAbort)
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        cleanup()
        resolve()
      }
    }
    const onAbort = () => {
      cleanup()
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pageshow', onVis)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort)
  })
}

export function useLessonStream({ onDone, onError, onStatus, onStart } = {}) {
  const [isStreaming, setIsStreaming] = useState(false)
  const [status, setStatus] = useState(null)
  const [text, setText] = useState('')
  const [preview, setPreview] = useState(null)
  const [grounding, setGrounding] = useState(null)
  const [dayNames, setDayNames] = useState(null)
  const [workingCell, setWorkingCell] = useState(null)
  const abortRef = useRef(null)
  const paramsRef = useRef(null)
  const stoppedRef = useRef(false)
  const wakeLockRef = useRef(null)
  // Mirrors the grounding state so the resolved value can carry it — state set
  // mid-stream is not visible to the closure that started the stream.
  const groundingRef = useRef(null)

  /* Plan JSON is much larger than a normal chat reply, and the partial parser
     scans the whole accumulated document. The server can deliver several SSE
     chunks between paints, so parsing and setting React state for every chunk
     made the lesson-plan path do work the browser could not display. Keep the
     latest text, paint at most once per frame, and inspect the partial JSON at
     a modest cadence. The final flush below always parses the complete plan. */
  const pendingTextRef = useRef(null)
  const pendingPreviewRef = useRef(undefined)
  const previewRafRef = useRef(null)
  const firstPreviewRef = useRef(false)
  const lastPreviewParseAtRef = useRef(0)
  const PREVIEW_PARSE_INTERVAL_MS = 100
  const basePlanRef = useRef(null)

  const previewFromText = useCallback((value) => {
    const parsed = parsePartialJson(value)
    if (!parsed) return null
    if (basePlanRef.current && Array.isArray(parsed.updates)) {
      setWorkingCell(activeWorkingCellKey(basePlanRef.current, parsed))
      return applyPlanPatch(basePlanRef.current, parsed)
    }
    return usablePlan(parsed)
  }, [])

  const flushPlanUpdate = useCallback((finalText = null) => {
    if (previewRafRef.current != null) {
      cancelAnimationFrame(previewRafRef.current)
      previewRafRef.current = null
    }
    const textToPaint = finalText ?? pendingTextRef.current
    if (textToPaint != null) setText(textToPaint)
    if (finalText != null) {
      const parsed = previewFromText(finalText)
      if (parsed) setPreview(parsed)
    } else if (pendingPreviewRef.current !== undefined) {
      setPreview(pendingPreviewRef.current)
    }
    pendingTextRef.current = null
    pendingPreviewRef.current = undefined
  }, [previewFromText])

  const queuePlanUpdate = useCallback((value) => {
    pendingTextRef.current = value
    const now = performance.now()
    if (now - lastPreviewParseAtRef.current >= PREVIEW_PARSE_INTERVAL_MS) {
      const parsed = previewFromText(value)
      if (parsed) {
        pendingPreviewRef.current = parsed
        if (!firstPreviewRef.current) {
          firstPreviewRef.current = true
          perf.mark('lesson-stream:first-preview')
          perf.measure('lesson-stream:time-to-first-preview', 'lesson-stream:start', 'lesson-stream:first-preview')
        }
      }
      lastPreviewParseAtRef.current = now
    }
    if (previewRafRef.current != null) return
    previewRafRef.current = requestAnimationFrame(() => {
      previewRafRef.current = null
      if (pendingTextRef.current == null) return
      setText(pendingTextRef.current)
      if (pendingPreviewRef.current !== undefined) setPreview(pendingPreviewRef.current)
      pendingTextRef.current = null
      pendingPreviewRef.current = undefined
    })
  }, [previewFromText])

  const cancelQueuedPlan = useCallback(() => {
    if (previewRafRef.current != null) {
      cancelAnimationFrame(previewRafRef.current)
      previewRafRef.current = null
    }
    pendingTextRef.current = null
    pendingPreviewRef.current = undefined
  }, [])

  useEffect(() => cancelQueuedPlan, [cancelQueuedPlan])

  // Latest callbacks without making them dependencies of `start`.
  const onDoneRef = useRef(onDone)
  const onErrorRef = useRef(onError)
  const onStatusRef = useRef(onStatus)
  const onStartRef = useRef(onStart)
  onDoneRef.current = onDone
  onErrorRef.current = onError
  onStatusRef.current = onStatus
  onStartRef.current = onStart

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
    stoppedRef.current = true
    const requestId = paramsRef.current?.requestId
    if (requestId) void api.cancelGenerate(requestId).catch(() => {})
    abortRef.current?.abort()
    abortRef.current = null
    wakeLockRef.current?.release?.().catch(() => {})
    wakeLockRef.current = null
    cancelQueuedPlan()
    setIsStreaming(false)
    setStatus(null)
    setText('')
    setPreview(null)
    setGrounding(null)
    setDayNames(null)
    setWorkingCell(null)
    groundingRef.current = null
  }, [cancelQueuedPlan])

  const reset = useCallback(() => {
    cancelQueuedPlan()
    setText('')
    setPreview(null)
    setGrounding(null)
    setDayNames(null)
    setWorkingCell(null)
    groundingRef.current = null
    setStatus(null)
  }, [cancelQueuedPlan])

  // One attempt: opens the SSE connection and either returns the finished
  // result or throws. Retrying lives in `start`, not here — see useChatStream
  // for why that split matters (onDone must fire at most once per call).
  const attempt = useCallback(async (query, { chatId, weekNumber, classId, conversationContext, referenceContext, controller, requestId, attempt, revisePlanId }) => {
    cancelQueuedPlan()
    setText('')
    setPreview(basePlanRef.current)
    setGrounding(null)
    setDayNames(null)
    setWorkingCell(null)
    groundingRef.current = null
    setStatus({ phase: 'accepted', label: 'Accepted', requestId })
    perf.mark('lesson-stream:start')

    let accumulated = ''
    let sawWriting = false
    const attemptController = new AbortController()
    const onParentAbort = () => attemptController.abort()
    controller.signal.addEventListener('abort', onParentAbort)
    if (controller.signal.aborted) attemptController.abort()
    let idleTimedOut = false
    let idleTimer
    const bumpIdle = () => {
      window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        idleTimedOut = true
        attemptController.abort()
      }, 20000)
    }
    bumpIdle()
    const rethrowAbort = (err) => {
      if (err.name !== 'AbortError') return
      if (idleTimedOut) {
        throw new ApiError('The connection went quiet while matching standards.', {
          code: 'stream_connection_error',
          hint: 'The week is still building. Reconnecting…',
          extra: { retryable: true },
        })
      }
      throw err
    }

    try {
    onStatusRef.current?.({
      code: 'retrieving',
      label: 'Matching standards…',
      requestId,
      attempt,
      step: 'standards',
    })
    let res
    try {
      res = await fetch(api.streamUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          conversation_context: conversationContext || '',
          reference_context: referenceContext || '',
          chat_id: chatId ?? null,
          week_number: weekNumber ?? null,
          // The page's own class (ChatPage's classId route param), not just
          // the chat's stored one — an older chat can have no class_id of its
          // own, and the backend now refuses to guess one. See generate.py's
          // GenerateRequest.class_id for the write-side half of this fix.
          class_id: classId ?? null,
          request_id: requestId,
          attempt,
          ...(revisePlanId ? { revise_plan_id: revisePlanId } : {}),
        }),
        signal: attemptController.signal,
        credentials: 'include',
      })
    } catch (err) {
      rethrowAbort(err)
      if (isDroppedConnectionError(err)) {
        const copy = droppedConnectionCopy(false)
        throw new ApiError(copy.message, { code: copy.code, hint: copy.hint, extra: { retryable: true } })
      }
      throw err
    }

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
      let next
      try {
        next = await reader.read()
      } catch (err) {
        rethrowAbort(err)
        if (isDroppedConnectionError(err)) {
          const copy = droppedConnectionCopy(sawWriting || Boolean(accumulated))
          throw new ApiError(copy.message, { code: copy.code, hint: copy.hint, extra: { retryable: true } })
        }
        throw new ApiError('The connection dropped while writing the week.', {
          code: 'stream_connection_error',
          hint: 'Checking whether the plan finished saving…',
          extra: { retryable: true },
        })
      }
      bumpIdle()
      const { value, done } = next
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
          if (controller.signal.aborted || stoppedRef.current) continue
          if (event.request_id && event.request_id !== requestId) continue
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
          if (event.status) {
            const labels = {
              queued: 'Queued — your request is safe…',
              retrieving: 'Matching standards…',
              thinking: 'Thinking…',
              writing: 'Writing your lesson plan…',
              saving: 'Saving the week…',
              accepted: 'Accepted',
              context_ready: 'Class context ready',
            }
            const phase = typeof event.status === 'string' ? event.status : event.status.phase
            if (phase === 'writing' || phase === 'saving') sawWriting = true
            const statusLabel = typeof event.status === 'object' ? event.status.label : event.label
            const nextStatus = {
              phase,
              label: statusLabel || labels[phase] || phase,
              requestId: event.request_id || requestId,
              attempt: event.attempt ?? 0,
            }
            setStatus(nextStatus)
            onStatusRef.current?.({
              code: phase,
              label: nextStatus.label,
              requestId: nextStatus.requestId,
              attempt: nextStatus.attempt,
              step: phase === 'retrieving' ? 'standards' : phase === 'writing' || phase === 'saving' ? 'days' : phase === 'thinking' ? 'standards' : phase === 'context_ready' ? 'standards' : phase === 'accepted' || phase === 'queued' ? 'context' : undefined,
            })
          }
          if (Array.isArray(event.template_days) && event.template_days.length) {
            setDayNames(event.template_days)
          }
          if (event.chunk) {
            accumulated += event.chunk
            if (accumulated === event.chunk) {
              perf.mark('lesson-stream:first-token')
              perf.measure(
                'lesson-stream:time-to-first-token',
                'lesson-stream:start',
                'lesson-stream:first-token'
              )
            }
            queuePlanUpdate(accumulated)
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
        hint: 'Checking whether the plan finished saving…',
      })
    }

    if (controller.signal.aborted || stoppedRef.current) return null
    flushPlanUpdate(accumulated)
    setPreview(finished.plan ?? null)
    setStatus({ phase: 'complete', label: 'Complete' })
    perf.mark('lesson-stream:end')
    perf.measure('lesson-stream:duration', 'lesson-stream:start', 'lesson-stream:end')
    // Grounding rides along, because `finished` (the done event) has none and
    // the caller's `stream.grounding` is a stale read.
    return { ...finished, grounding: groundingRef.current, requestId }
    } finally {
      window.clearTimeout(idleTimer)
      controller.signal.removeEventListener('abort', onParentAbort)
    }
  }, [cancelQueuedPlan, flushPlanUpdate, queuePlanUpdate])

  const start = useCallback(
    async (query, { chatId, weekNumber, classId, conversationContext = '', referenceContext = '', requestId: requestedRequestId, revisePlanId = null, basePlan = null } = {}) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      stoppedRef.current = false
      const requestId = requestedRequestId || (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
      firstPreviewRef.current = false
      basePlanRef.current = basePlan
      paramsRef.current = { query, chatId, weekNumber, classId, conversationContext, referenceContext, requestId, revisePlanId }
      onStartRef.current?.({ requestId, attempt: 0 })

      setIsStreaming(true)
      setStatus({ phase: 'accepted', label: 'Accepted', requestId })
      try {
        wakeLockRef.current = await navigator.wakeLock?.request('screen')
      } catch {
        wakeLockRef.current = null
      }

      try {
        let lastErr = null
        for (let tryNum = 0; tryNum <= MAX_AUTO_RETRIES; tryNum++) {
          if (stoppedRef.current) return null
          if (tryNum > 0) await sleep(RETRY_DELAY_MS)
          try {
            const result = await attempt(query, {
              chatId,
              weekNumber,
              classId,
              conversationContext,
              referenceContext,
              controller,
              requestId,
              attempt: tryNum,
              revisePlanId,
            })
            if (!result || controller.signal.aborted || stoppedRef.current) return null
            onDoneRef.current?.(result)
            return result
          } catch (err) {
            if (stoppedRef.current || err.name === 'AbortError') return null
            lastErr = err
            // A structured SSE error (validation, schema, entitlement, …) is
            // terminal for this attempt. Job-status reconnect exists for
            // dropped/truncated streams where the server may still be writing
            // — not for a request the stream already rejected.
            const streamRetryable = RETRYABLE_CODES.has(err.code) || err.extra?.retryable
            if (!streamRetryable) break
            let snap = null
            try {
              snap = await api.getGenerateJob(requestId)
            } catch {
              snap = null
            }
            if (snap?.status === 'done' && snap.result) {
              const result = { ...snap.result, requestId, grounding: groundingRef.current }
              if (controller.signal.aborted || stoppedRef.current) return null
              onDoneRef.current?.(result)
              return result
            }
            if (snap?.status === 'cancelled') return null
            if (snap?.status === 'error') {
              lastErr = new ApiError(snap.error?.message || err.message, {
                code: snap.error?.code || err.code || 'stream_error',
                hint: snap.error?.hint || err.hint,
              })
              break
            }
            const retryable = streamRetryable || snap?.status === 'running'
            setStatus({
              phase: 'retrying',
              label: snap?.status === 'running' ? 'Still building — reconnecting…' : 'Reconnecting…',
              requestId,
              attempt: tryNum,
            })
            onStatusRef.current?.({
              code: 'retrying',
              label: snap?.status === 'running' ? 'Still building — reconnecting…' : 'Reconnecting…',
              requestId,
              attempt: tryNum,
            })
            if (retryable && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
              try {
                await waitForVisible(controller.signal)
              } catch {
                return null
              }
            }
            if (retryable) continue
            if (tryNum >= MAX_AUTO_RETRIES) break
          }
        }
        onErrorRef.current?.(lastErr)
        throw lastErr
      } finally {
        wakeLockRef.current?.release?.().catch(() => {})
        wakeLockRef.current = null
        if (abortRef.current === controller) abortRef.current = null
        setIsStreaming(false)
        setWorkingCell(null)
      }
    },
    [attempt]
  )

  return { start, stop, reset, isStreaming, text, preview, grounding, status, dayNames, workingCell }
}
