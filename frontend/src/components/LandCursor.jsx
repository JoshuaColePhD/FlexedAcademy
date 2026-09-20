import { useEffect } from 'react'

/* Magnetic pull on landing CTAs. No custom cursor and no ring around the
 * pointer — the OS cursor stays. The shift is a few pixels, eased, so the
 * control nudges instead of following the mouse. Touch and reduced-motion
 * skip the pull.
 */

const MAGNET_PULL = 0.08
const MAGNET_MAX = 4
const MAGNET_LERP = 0.12

function prefersMagnet() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const fine = window.matchMedia('(pointer: fine)').matches
  if (coarse && !fine) return false
  return true
}

export function LandCursor({ rootRef }) {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !prefersMagnet()) return undefined

    let mx = window.innerWidth / 2
    let my = window.innerHeight / 2
    let magnetEl = null
    let pullX = 0
    let pullY = 0
    let running = true
    let raf = 0

    const releaseMagnet = () => {
      if (!magnetEl) return
      magnetEl.style.setProperty('--magnet-x', '0px')
      magnetEl.style.setProperty('--magnet-y', '0px')
      magnetEl = null
      pullX = 0
      pullY = 0
    }

    const onMove = (event) => {
      mx = event.clientX
      my = event.clientY
    }

    const onLeave = (event) => {
      if (event.type === 'mouseout' && (event.relatedTarget || event.toElement)) return
      releaseMagnet()
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

      if (magnetEl) {
        const box = magnetEl.getBoundingClientRect()
        const cx = box.left + box.width / 2
        const cy = box.top + box.height / 2
        const targetX = Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, (mx - cx) * MAGNET_PULL))
        const targetY = Math.max(-MAGNET_MAX, Math.min(MAGNET_MAX, (my - cy) * MAGNET_PULL))
        pullX += (targetX - pullX) * MAGNET_LERP
        pullY += (targetY - pullY) * MAGNET_LERP
        magnetEl.style.setProperty('--magnet-x', `${pullX}px`)
        magnetEl.style.setProperty('--magnet-y', `${pullY}px`)
      }

      raf = requestAnimationFrame(tick)
    }

    document.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', onLeave)
    document.addEventListener('mouseout', onLeave)
    window.addEventListener('blur', releaseMagnet)
    raf = requestAnimationFrame(tick)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('mouseout', onLeave)
      window.removeEventListener('blur', releaseMagnet)
      releaseMagnet()
    }
  }, [rootRef])

  return null
}
