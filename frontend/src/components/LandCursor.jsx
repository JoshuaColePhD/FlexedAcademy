import { useEffect, useRef } from 'react'

/* Custom cursor for the public landing page only — never the workspace.
 *
 * Spec: pointer-events none on the wrapper; GPU translate3d tracking;
 * lerp so the ring trails the pointer; magnetic snap on .magnetic-target;
 * morph + badge on [data-cursor-media]; mix-blend difference on
 * [data-cursor-text]; fade out on document mouseleave.
 *
 * Fine pointers only. Reduced-motion and touch keep the OS cursor.
 */

const LERP_DOT = 0.38
const LERP_RING = 0.16
const MAGNET_PULL = 0.22
const MAGNET_MAX = 12

function prefersCustomCursor() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const fine = window.matchMedia('(pointer: fine)').matches
  /* Touch-only devices stay on the OS cursor. A VM that reports neither
     fine nor coarse still has a mouse in the seat, so it gets the ring. */
  if (coarse && !fine) return false
  return true
}

export function LandCursor({ rootRef }) {
  const wrapRef = useRef(null)
  const ringRef = useRef(null)
  const dotRef = useRef(null)
  const badgeRef = useRef(null)

  useEffect(() => {
    const root = rootRef.current
    const wrap = wrapRef.current
    const ring = ringRef.current
    const dot = dotRef.current
    const badge = badgeRef.current
    if (!root || !wrap || !ring || !dot || !badge) return undefined
    if (!prefersCustomCursor()) return undefined

    root.classList.add('land--cursor')

    let mx = window.innerWidth / 2
    let my = window.innerHeight / 2
    let dotX = mx
    let dotY = my
    let ringX = mx
    let ringY = my
    let visible = false
    let raf = 0
    let magnetEl = null
    let running = true

    const setState = (state, label = '') => {
      if (wrap.dataset.state !== state) wrap.dataset.state = state
      if (badge.textContent !== label) badge.textContent = label
    }

    const releaseMagnet = () => {
      if (!magnetEl) return
      magnetEl.style.setProperty('--magnet-x', '0px')
      magnetEl.style.setProperty('--magnet-y', '0px')
      magnetEl = null
    }

    const hide = () => {
      visible = false
      wrap.style.opacity = '0'
      releaseMagnet()
      setState('idle')
    }

    const onMove = (event) => {
      mx = event.clientX
      my = event.clientY
      if (!visible) {
        visible = true
        wrap.style.opacity = '1'
        dotX = ringX = mx
        dotY = ringY = my
      }
    }

    const onLeave = (event) => {
      if (event.type === 'mouseout' && (event.relatedTarget || event.toElement)) return
      hide()
    }

    const tick = () => {
      if (!running) return
      const hit = document.elementFromPoint(mx, my)
      const overForm = Boolean(hit?.closest('.land-signin-pop, input, textarea, select, [contenteditable]'))
      const nextMagnet = overForm ? null : hit?.closest('.magnetic-target')
      const media = overForm ? null : hit?.closest('[data-cursor-media]')
      const text = overForm ? null : hit?.closest('[data-cursor-text]')

      if (nextMagnet !== magnetEl) {
        releaseMagnet()
        magnetEl = nextMagnet
      }

      let tx = mx
      let ty = my
      if (magnetEl) {
        const box = magnetEl.getBoundingClientRect()
        const cx = box.left + box.width / 2
        const cy = box.top + box.height / 2
        tx = cx + (mx - cx) * 0.1
        ty = cy + (my - cy) * 0.1
        const pullX = Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, (mx - cx) * MAGNET_PULL))
        const pullY = Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, (my - cy) * MAGNET_PULL))
        magnetEl.style.setProperty('--magnet-x', `${pullX}px`)
        magnetEl.style.setProperty('--magnet-y', `${pullY}px`)
        setState('magnetic')
      } else if (media) {
        setState('media', media.getAttribute('data-cursor-media') || 'Play')
      } else if (text) {
        setState('text')
      } else {
        setState('idle')
      }

      dotX += (mx - dotX) * LERP_DOT
      dotY += (my - dotY) * LERP_DOT
      ringX += (tx - ringX) * LERP_RING
      ringY += (ty - ringY) * LERP_RING

      dot.style.transform = `translate3d(${dotX}px, ${dotY}px, 0) translate(-50%, -50%)`
      ring.style.transform = `translate3d(${ringX}px, ${ringY}px, 0) translate(-50%, -50%)`
      raf = requestAnimationFrame(tick)
    }

    document.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', onLeave)
    document.addEventListener('mouseout', onLeave)
    window.addEventListener('blur', hide)
    raf = requestAnimationFrame(tick)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('mouseout', onLeave)
      window.removeEventListener('blur', hide)
      releaseMagnet()
      root.classList.remove('land--cursor')
    }
  }, [rootRef])

  return (
    <div ref={wrapRef} className="land-cursor" aria-hidden="true" data-state="idle">
      <div ref={ringRef} className="land-cursor-ring">
        <span ref={badgeRef} className="land-cursor-badge" />
      </div>
      <div ref={dotRef} className="land-cursor-dot" />
    </div>
  )
}
