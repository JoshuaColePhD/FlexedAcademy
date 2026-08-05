import { useCallback, useEffect, useRef, useState } from 'react'

/* One loading/error/data state machine, because the pages were each inventing
   their own and getting the same two things wrong.

   1. "empty" and "not yet asked" were the same state. StandardsPage kept its
      items in a bare `useState([])` with no loading flag, so it rendered
      "Nothing matches that filter." before the first request had returned —
      telling the teacher the corpus was empty while it was still loading. Hence
      an explicit `idle` status rather than inferring emptiness from `data`.

   2. Nothing cancelled. The filter box refetched on every keystroke with no
      abort, so a slow response for "r" could land after the fast one for "read"
      and overwrite it. Hence the run-id guard AND the AbortSignal: the signal
      stops the request, the run id stops a resolution that escaped anyway from
      touching state.

   `keepPrevious` is for search-over-a-list, where blanking the whole list on
   every keystroke is worse than showing slightly stale rows. */

const IDLE = { status: 'idle', data: null, error: null }

/**
 * @param {(signal: AbortSignal) => Promise<any>} fn
 * @param {any[]} deps            re-runs when these change (same rules as useEffect)
 * @param {{immediate?: boolean, keepPrevious?: boolean}} [opts]
 */
export function useAsync(fn, deps = [], { immediate = true, keepPrevious = false } = {}) {
  const [state, setState] = useState(IDLE)

  const fnRef = useRef(fn)
  fnRef.current = fn

  // Monotonic: only the newest run may write state.
  const runIdRef = useRef(0)
  const abortRef = useRef(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const run = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const runId = ++runIdRef.current

    setState((prev) => ({
      status: 'loading',
      data: keepPrevious ? prev.data : null,
      error: null,
    }))

    try {
      const data = await fnRef.current(controller.signal)
      if (runId !== runIdRef.current || !mountedRef.current) return undefined
      setState({ status: 'success', data, error: null })
      return data
    } catch (err) {
      // An abort is a superseded request, not a failure — leave the state alone
      // so the run that replaced it owns the display.
      if (err?.name === 'AbortError' || runId !== runIdRef.current || !mountedRef.current) {
        return undefined
      }
      setState((prev) => ({
        status: 'error',
        data: keepPrevious ? prev.data : null,
        error: err,
      }))
      return undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepPrevious])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    runIdRef.current++
    setState(IDLE)
  }, [])

  /* Patch the loaded data locally, for edits that don't need a refetch — deleting
     one plan out of a page of a hundred, or swapping in the row a rebuild
     returned. Takes the same updater shape as setState. */
  const setData = useCallback((updater) => {
    setState((prev) => ({
      ...prev,
      data: typeof updater === 'function' ? updater(prev.data) : updater,
    }))
  }, [])

  useEffect(() => {
    if (immediate) run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return {
    status: state.status,
    data: state.data,
    error: state.error,
    run,
    reset,
    setData,
    isIdle: state.status === 'idle',
    isLoading: state.status === 'loading',
    isError: state.status === 'error',
    isSuccess: state.status === 'success',
    /** True only when there's nothing to show yet — the skeleton condition. */
    isFirstLoad: state.status === 'loading' && state.data == null,
  }
}
