import { useEffect, useRef, useState } from 'react'

/* A scrollable container's own pull-to-refresh — the one native mobile
 * gesture MobileChatHome was missing once it became a real landing screen
 * instead of a rarely-opened drawer. Plain touch events, not framer-motion's
 * `drag`: drag and a vertical scroller fight over the same gesture, and this
 * only ever needs to act when the scroller is already at its top.
 *
 * Attach `containerRef` to the scrollable element and spread `handlers` onto
 * it. `pullDistance` (0..maxPull) and `refreshing` drive whatever indicator
 * the caller renders above the list.
 */
export function usePullToRefresh(onRefresh, { threshold = 64, maxPull = 96 } = {}) {
  const containerRef = useRef(null)
  const startYRef = useRef(null)
  const trackingRef = useRef(false)
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  // touchend's own handler is bound once per effect run (see the empty-ish
  // dep array below) — it needs the CURRENT distance, not whatever was in
  // scope the last time the effect ran, so it reads through a ref rather
  // than closing over the pullDistance state directly (same "ref, not a
  // stale closure" pattern used for volatile callbacks elsewhere in this
  // app — see ChatPage's own closeVoiceRef).
  const pullDistanceRef = useRef(0)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined

    const onTouchStart = (e) => {
      // Only a pull that starts with the list already scrolled to the top
      // counts — otherwise this hijacks an ordinary downward scroll deep in
      // a long chat list.
      if (el.scrollTop > 0 || refreshing) {
        trackingRef.current = false
        return
      }
      trackingRef.current = true
      startYRef.current = e.touches[0].clientY
    }

    const onTouchMove = (e) => {
      if (!trackingRef.current || startYRef.current == null) return
      const delta = e.touches[0].clientY - startYRef.current
      if (delta <= 0) {
        pullDistanceRef.current = 0
        setPullDistance(0)
        return
      }
      // Resistance past the raw finger distance, same idea as iOS's own
      // rubber-band — pulling further should keep moving, just less per
      // pixel of actual drag.
      const resisted = Math.min(maxPull, delta * 0.45)
      pullDistanceRef.current = resisted
      setPullDistance(resisted)
      // Only swallow the scroll once a pull is actually underway — a tap or
      // a tiny jitter shouldn't block the page's normal touch handling.
      if (delta > 4 && e.cancelable) e.preventDefault()
    }

    const onTouchEnd = async () => {
      if (!trackingRef.current) return
      trackingRef.current = false
      startYRef.current = null
      const committed = pullDistanceRef.current >= threshold
      pullDistanceRef.current = 0
      if (committed) {
        setRefreshing(true)
        setPullDistance(threshold)
        try {
          await onRefresh()
        } finally {
          setRefreshing(false)
          setPullDistance(0)
        }
      } else {
        setPullDistance(0)
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pullDistance is read via closure on purpose: re-binding every pixel of a drag would drop mid-gesture listeners.
  }, [onRefresh, refreshing, threshold, maxPull])

  return { containerRef, pullDistance, refreshing, threshold }
}
