import { useEffect, useRef } from 'react'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || ''

export function TurnstileWidget({ action = 'signup', onToken, onError }) {
  const containerRef = useRef(null)
  const callbacksRef = useRef({ onToken, onError })
  callbacksRef.current = { onToken, onError }

  useEffect(() => {
    if (!SITE_KEY || !containerRef.current) return undefined
    let widgetId = null
    let cancelled = false

    const render = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        action,
        callback: (token) => callbacksRef.current.onToken(token),
        'expired-callback': () => callbacksRef.current.onToken(''),
        'error-callback': () => callbacksRef.current.onError?.(),
      })
    }

    const script = document.querySelector(`script[src="${SCRIPT_SRC}"]`)
    if (window.turnstile) render()
    else if (script) script.addEventListener('load', render, { once: true })
    else {
      const nextScript = document.createElement('script')
      nextScript.src = SCRIPT_SRC
      nextScript.async = true
      nextScript.defer = true
      nextScript.addEventListener('load', render, { once: true })
      document.head.appendChild(nextScript)
    }

    return () => {
      cancelled = true
      if (widgetId !== null && window.turnstile) window.turnstile.remove(widgetId)
    }
  }, [action])

  if (!SITE_KEY) return null
  return <div ref={containerRef} className="min-h-[65px]" aria-label="Bot protection" />
}

