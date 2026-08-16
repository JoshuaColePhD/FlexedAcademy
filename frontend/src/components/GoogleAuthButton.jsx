import { useLayoutEffect, useRef, useState } from 'react'
import { GoogleLogin } from '@react-oauth/google'

/* Both auth forms passed width="100%" to GoogleLogin — reads like a normal
 * CSS value, but Google's own API takes `width` in PIXELS
 * (developers.google.com/identity/gsi/web/reference/js-reference#width), a
 * literal size for the iframe it renders, not a percentage of anything.
 * That was already invalid before this component existed; it stayed
 * invisible only because nothing clipped whatever width Google fell back
 * to. Wrapping the button in a neo-raised frame (to match this app's own
 * embossed auth forms) added an overflow-hidden edge for the first time,
 * and the mismatch between Google's own fallback width and the frame's
 * real width turned into a visible clipped button.
 *
 * The actual fix: measure the frame's own pixel width and hand Google a
 * real number, via ResizeObserver so it stays correct across a resize
 * instead of freezing at whatever width existed on first mount.
 */
export function GoogleAuthButton({ onSuccess, onError, size = 'large', text = 'continue_with' }) {
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={wrapRef} className="neo-raised w-full overflow-hidden rounded-lg">
      {/* Nothing to render until the real width is known — a 0 or stale
          width handed to Google's own renderButton call is the exact bug
          this component exists to avoid. */}
      {width ? (
        <GoogleLogin
          onSuccess={onSuccess}
          onError={onError}
          theme="filled_black"
          size={size}
          width={width}
          text={text}
          shape="rectangular"
        />
      ) : null}
    </div>
  )
}
