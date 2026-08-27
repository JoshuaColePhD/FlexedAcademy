import { useEffect, useRef, useState } from 'react'

/* A scrollable container's own pull-to-refresh — the one native mobile
 * gesture MobileChatHome was missing once it became a real landing screen
 * instead of a rarely-opened drawer. Plain touch events, not framer-motion's
 * `drag`: drag and a vertical scroller fight over the same gesture, and this
 * only ever needs to act when the scroller is already at its top.
 *
 * Attach `containerRef` to the scrollable element, `indicatorRef` to the
 * indicator's wrapper (its height is what grows with the pull) and
 * `iconRef` to the spinning glyph inside it. The drag itself is written
 * straight to those DOM nodes' own `style`, NOT to React state — the first
 * version of this hook called setPullDistance() on every touchmove, which
 * is a state update (and a re-render of Rail's whole chat list) on every
 * pixel of finger movement, easily 60+ times a second. That reads as janky
 * on real mobile hardware even though it looked fine in a desktop-browser
 * emulator; writing directly to style during the drag and only touching
 * React state once per gesture (`refreshing`) is the same "escape React for
 * a high-frequency visual update" trade this app already makes elsewhere
 * (Composer's own autosize measures/writes style directly rather than
 * running through state on every keystroke).
 */
// The indicator's resting height once a refresh actually commits — smaller
// than the full pulled distance, so it settles into a compact spinner
// instead of staying stretched to wherever the finger happened to reach.
const REFRESH_SETTLE_HEIGHT = 36

export function usePullToRefresh(onRefresh, { threshold = 64, maxPull = 96 } = {}) {
  const containerRef = useRef(null)
  const indicatorRef = useRef(null)
  const iconRef = useRef(null)
  const startYRef = useRef(null)
  const trackingRef = useRef(false)
  const pullDistanceRef = useRef(0)
  const [refreshing, setRefreshing] = useState(false)

  const paint = (distance) => {
    if (indicatorRef.current) indicatorRef.current.style.height = `${distance}px`
    if (iconRef.current) {
      iconRef.current.style.opacity = String(Math.min(1, distance / threshold))
      iconRef.current.style.transform = `rotate(${distance * 3}deg)`
    }
  }
  // No transition while a finger is actually moving it (1:1 tracking, zero
  // added latency) — only turned on for the moment of release, so the snap
  // to a resting height (0, or the settled spinner height) animates instead
  // of jumping. Toggled directly on the node for the same reason paint()
  // itself bypasses React: a CSS class flip is still a re-render if it's
  // wired through state, and this needs to happen exactly on touchstart/
  // touchend, not on whatever cadence React gets around to it.
  const setSnapTransition = (on) => {
    if (indicatorRef.current) indicatorRef.current.style.transition = on ? 'height 200ms var(--ease-out, ease-out)' : 'none'
  }

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
      setSnapTransition(false)
    }

    const onTouchMove = (e) => {
      if (!trackingRef.current || startYRef.current == null) return
      const delta = e.touches[0].clientY - startYRef.current
      if (delta <= 0) {
        pullDistanceRef.current = 0
        paint(0)
        return
      }
      // Resistance past the raw finger distance, same idea as iOS's own
      // rubber-band — pulling further should keep moving, just less per
      // pixel of actual drag.
      const resisted = Math.min(maxPull, delta * 0.45)
      pullDistanceRef.current = resisted
      paint(resisted)
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
      setSnapTransition(true)
      if (committed) {
        setRefreshing(true)
        paint(REFRESH_SETTLE_HEIGHT)
        // Full opacity, and hand rotation off to the CSS animate-spin class
        // AppShell applies while refreshing=true — paint()'s own rotate()
        // was for tracking a finger, not for a steady spin, and a CSS
        // @keyframes animation on the same property overrides an inline one
        // regardless, so clearing it here just avoids the two visibly
        // fighting for a frame before the animation takes over.
        if (iconRef.current) {
          iconRef.current.style.opacity = '1'
          iconRef.current.style.transform = ''
        }
        try {
          await onRefresh()
        } finally {
          setRefreshing(false)
          paint(0)
        }
      } else {
        paint(0)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paint()/threshold/maxPull read via closure on purpose: re-binding mid-gesture would drop the active listeners.
  }, [onRefresh, refreshing])

  return { containerRef, indicatorRef, iconRef, refreshing, threshold }
}
