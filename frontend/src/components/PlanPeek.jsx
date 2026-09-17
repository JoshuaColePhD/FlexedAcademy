import { useEffect, useRef, useState } from 'react'
import { ChevronUp, FileText } from 'lucide-react'
import { haptic } from '../lib/haptics'

/*
 * The phone's plan hand-off: a small, always-reachable handle above the
 * composer that can grow into the same ArtifactPanel used by the full reader.
 * Keeping the panel as a child here is important — Weeden's day cards and the
 * Florence table remain the single source of truth for the plan's content and
 * school-specific presentation.
 */
export function PlanPeek({ open, onToggle, weekLabel, children }) {
  const pointerRef = useRef(null)
  const suppressClickRef = useRef(false)
  const sheetRef = useRef(null)
  const previewRef = useRef(false)
  const openHeightRef = useRef(0)
  const previewFrameRef = useRef(null)
  const pendingPreviewRef = useRef(0)
  const [previewing, setPreviewing] = useState(false)
  const [dragging, setDragging] = useState(false)

  // The old 104px cap made a long thumb pull feel like it hit an invisible
  // wall. This is only the minimum; the real distance is measured from the
  // handle to the bottom of the phone's header so a pull can reach the full
  // available reader height on every device.
  const MIN_OPEN_DRAG_DISTANCE = 104

  useEffect(() => () => {
    if (previewFrameRef.current != null) window.cancelAnimationFrame(previewFrameRef.current)
  }, [])

  const measureOpenHeight = () => {
    const sheet = sheetRef.current
    if (!sheet) return MIN_OPEN_DRAG_DISTANCE
    // The transcript is the flexible region that the dock compresses. Using
    // its top, rather than a hard-coded viewport inset, keeps the reader below
    // the phone header, context strip, and any visible banner on this account.
    const transcript = document.querySelector('.workspace-chat .scroll-y')
    const header = document.querySelector('.workspace-topbar')
    const topBoundary = transcript?.getBoundingClientRect().top || header?.getBoundingClientRect().bottom || 0
    const available = Math.round(sheet.getBoundingClientRect().top - topBoundary)
    const height = Math.max(MIN_OPEN_DRAG_DISTANCE, available)
    openHeightRef.current = height
    sheet.style.setProperty('--plan-peek-open-height', `${height}px`)
    return height
  }

  const releasePointer = (event) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  // Pointer moves can arrive at 120Hz on current phones. Keep the gesture out
  // of React and coalesce multiple events into one browser paint, so a burst
  // of pointer events cannot queue more layout work than the display can show.
  const paintPreview = (distance) => {
    sheetRef.current?.style.setProperty('--plan-peek-drag', `${distance}px`)
    if (distance > 0 && !previewRef.current) {
      previewRef.current = true
      setPreviewing(true)
    } else if (distance === 0 && previewRef.current) {
      previewRef.current = false
      setPreviewing(false)
    }
  }

  const setPreview = (distance) => {
    pendingPreviewRef.current = distance
    if (previewFrameRef.current != null) return
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null
      paintPreview(pendingPreviewRef.current)
    })
  }

  const finishPointer = (event) => {
    const start = pointerRef.current
    if (!start) return
    const delta = event.clientY - start.y
    const elapsed = Math.max(1, performance.now() - start.at)
    const velocity = delta / elapsed
    pointerRef.current = null
    setDragging(false)
    setPreview(0)
    releasePointer(event)

    // A deliberate drag should not also fire the button's synthetic click.
    if (Math.abs(delta) > 8) {
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 120)
    }

    // Pull is only mounted while closed. Open snaps on a confident upward
    // flick or a long enough drag; the document Close button dismisses it.
    const openDistance = openHeightRef.current || MIN_OPEN_DRAG_DISTANCE
    if (-delta > openDistance * 0.24 || velocity < -0.5) {
      haptic('light')
      onToggle(true)
    }
  }

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    measureOpenHeight()
    pointerRef.current = { y: event.clientY, at: performance.now() }
    setDragging(true)
    setPreview(0)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    if (event.cancelable) event.preventDefault()
  }

  const onPointerMove = (event) => {
    const start = pointerRef.current
    if (!start) return
    const delta = event.clientY - start.y
    // Closed: an upward pull reveals the first slice of the document before
    // release so the thumb stays connected to the growing sheet.
    const next = Math.min(openHeightRef.current || MIN_OPEN_DRAG_DISTANCE, Math.max(0, -delta))
    setPreview(next)
    if (event.cancelable) event.preventDefault()
  }

  const cancelPointer = (event) => {
    if (!pointerRef.current) return
    pointerRef.current = null
    setDragging(false)
    setPreview(0)
    releasePointer(event)
  }

  const handleClick = () => {
    if (suppressClickRef.current) return
    measureOpenHeight()
    haptic('light')
    onToggle(true)
  }

  const handleLabel = 'View lesson plan'
  const handleAriaLabel = `View lesson plan${weekLabel ? ` for ${weekLabel}` : ''}`

  return (
    <section
      ref={sheetRef}
      className={`plan-peek${open ? ' is-open' : ''}${dragging ? ' is-dragging' : ''}${previewing ? ' is-drag-preview' : ''}`}
      aria-label="Lesson plan preview"
    >
      {/* Once open, the document's own Close control dismisses the reader —
         keeping this pull around during the lift just duplicates that exit. */}
      {!open ? (
        <button
          type="button"
          className="plan-peek-handle"
          aria-expanded={false}
          aria-controls="plan-peek-body"
          aria-label={handleAriaLabel}
          onClick={handleClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishPointer}
          onPointerCancel={cancelPointer}
        >
          <FileText className="plan-peek-handle-icon" size={15} strokeWidth={1.9} aria-hidden="true" />
          <span className="plan-peek-handle-label">{handleLabel}</span>
          <span className="plan-peek-handle-action" aria-hidden="true">
            <ChevronUp size={16} />
          </span>
        </button>
      ) : null}
      <div id="plan-peek-body" className="plan-peek-body" aria-hidden={!open} inert={!open}>
        <div className="plan-peek-body-inner">{children}</div>
      </div>
    </section>
  )
}
