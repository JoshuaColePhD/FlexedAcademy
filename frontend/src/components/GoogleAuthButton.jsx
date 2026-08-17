import { useLayoutEffect, useRef, useState } from 'react'
import { GoogleLogin } from '@react-oauth/google'

/* Both auth forms passed width="100%" to GoogleLogin — reads like a normal
 * CSS value, but Google's own API takes `width` in PIXELS
 * (developers.google.com/identity/gsi/web/reference/js-reference#width), a
 * literal size for the iframe it renders, not a percentage of anything.
 * That was already invalid before this component existed; it stayed
 * invisible only because nothing clipped whatever width Google fell back
 * to.
 *
 * The actual fix: measure the frame's own pixel width and hand Google a
 * real number, via ResizeObserver so it stays correct across a resize
 * instead of freezing at whatever width existed on first mount.
 *
 * The wrapper used to also carry its own border/shadow/rounded corners
 * with overflow-hidden — which kept clipping Google's own icon no matter
 * how the corner radius was tuned, because Google doesn't render one fixed
 * shape here. A signed-out browser gets the plain "Continue with Google"
 * pill; a browser with an existing Google session gets a wider, DIFFERENT
 * layout ("Sign in as [name]", avatar on the left, the G badge pinned in
 * its own corner on the right) — a different internal shape with its own
 * corners in different places, and Google renders it that way regardless
 * of our own shape/theme props: it's a distinct component (an identity
 * confirmation chip), not the plain button with a name stuck on. Matching
 * our own rounding to one of those shapes just broke the other one the
 * moment Google decided which variant to render. The real fix for OUR OWN
 * clipping is to stop clipping at all: no overflow-hidden, no border-
 * radius, no border/shadow of our own.
 *
 * On Josh's own request, the personalized variant is now suppressed
 * entirely rather than restyled — see the cookie-clear below. Google
 * decides which variant to render by checking `g_state`, a first-party
 * cookie ITS OWN script sets on this domain (not Google's) the first time
 * someone signs in here, purely to remember "this browser has used Sign
 * In With Google on this exact site before." That's what the personalized
 * layout is actually reading; there's no supported button prop to turn it
 * off directly, since it isn't a style option, it's Google's own
 * remembered state. Clearing that cookie before Google's script runs
 * removes the ONE signal that state is read from, so the plain pill
 * renders every time — same client, same ID-token credential flow, same
 * backend, nothing about the actual sign-in changes, only which layout
 * Google's script chooses to draw. Best-effort, not an official API: this
 * relies on Google continuing to use this exact cookie name for this
 * exact purpose, which could change in a future version of their script.
 */
export function GoogleAuthButton({ onSuccess, onError, size = 'large', text = 'continue_with' }) {
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    try {
      document.cookie = 'g_state=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
    } catch {
      /* Cookies blocked — Google's script falls back to its own default
         (possibly still personalized), same as if this line didn't run. */
    }
  }, [])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) setWidth(Math.floor(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    // Plain and unstyled on purpose — see the comment above. Nothing here
    // clips or frames Google's own button, whichever variant it renders.
    <div ref={wrapRef} className="w-full">
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
