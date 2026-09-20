import { useEffect, useRef } from 'react'

/* Magnetic pull on landing CTAs. The OS pointer stays visible everywhere;
 * this overlay is only a lerp ring that appears on .magnetic-target.
 * pointer-events: none so clicks are never stolen. Touch and reduced-motion
 * skip it. The workspace is unchanged.
 */

const LERP_RING = 0.16
const MAGNET_PULL = 0.22
const MAGNET_MAX = 12

function prefersMagnet() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const fine = window.matchMedia('(pointer: fine)').matches
  if (coarse && !fine) return false
  return true
}

export function LandCursor({ rootRef }) {
  const wrapRef = useRef(null)
  const ringRef = useRef(null)

  useEffect(() => {
    const root = rootRef.current
    const wrap = wrapRef.current
    const ring = ringRef.current
    if (!root || !wrap || !ring) return undefined
    if (!prefersMagnet()) return undefined

    let mx = window.innerWidth / 2
    let my = window.innerHeight / 2
    let ringX = mx
    let ringY = my
    let magnetEl = null
    let running = true
    let raf = 0

    const releaseMagnet = () => {
      if (!magnetEl) return
      magnetEl.style.setProperty('--magnet-x', '0px')
      magnetEl.style.setProperty('--magnet-y', '0px')
      magnetEl = null
    }

    const hide = () => {
      wrap.dataset.state = 'idle'
      wrap.style.opacity = '0'
      releaseMagnet()
    }

    const onMove = (event) => {
      mx = event.clientX
      my = event.clientY
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
        wrap.dataset.state = 'magnetic'
        wrap.style.opacity = '1'
      } else {
        wrap.dataset.state = 'idle'
        wrap.style.opacity = '0'
      }

      ringX += (tx - ringX) * LERP_RING
      ringY += (ty - ringY) * LERP_RING
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
    }
  }, [rootRef])

  return (
    <div ref={wrapRef} className="land-cursor" aria-hidden="true" data-state="idle">
      <div ref={ringRef} className="land-cursor-ring" />
    </div>
  )
}
