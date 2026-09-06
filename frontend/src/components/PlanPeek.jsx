import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

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
  const [previewing, setPreviewing] = useState(false)
  const [dragging, setDragging] = useState(false)

  // The old 104px cap made a long thumb pull feel like it hit an invisible
  // wall. This is only the minimum; the real distance is measured from the
  // handle to the bottom of the phone's header so a pull can reach the full
  // available reader height on every device.
  const MIN_OPEN_DRAG_DISTANCE = 104
  const MIN_CLOSE_DRAG_DISTANCE = 88

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

  // Pointer moves can arrive at 120Hz on current phones. Updating React state
  // for every pixel forced the full document tree to re-render under the
  // finger; write the paint-only CSS variable directly instead.
  const setPreview = (distance) => {
    sheetRef.current?.style.setProperty('--plan-peek-drag', `${distance}px`)
    if (distance > 0 && !previewRef.current) {
      previewRef.current = true
      setPreviewing(true)
    } else if (distance === 0 && previewRef.current) {
      previewRef.current = false
      setPreviewing(false)
    }
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

    // A quick, confident flick snaps the sheet even before it crosses the
    // distance threshold. A slow gesture has to travel far enough to make the
    // intended resting point unambiguous.
    const openDistance = openHeightRef.current || MIN_OPEN_DRAG_DISTANCE
    const closeDistance = Math.max(MIN_CLOSE_DRAG_DISTANCE, openHeightRef.current || MIN_CLOSE_DRAG_DISTANCE)
    if (open && (delta > closeDistance * 0.24 || velocity > 0.7)) onToggle(false)
    else if (!open && (-delta > openDistance * 0.24 || velocity < -0.5)) onToggle(true)
  }

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (!open) measureOpenHeight()
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
    // The sheet itself grows with the gesture. Closed: an upward pull reveals
    // the first slice of the document. Open: a downward pull collapses that
    // slice before release. This keeps the thumb connected to the content
    // instead of translating a handle over a still-hidden panel.
    const closeDistance = Math.max(MIN_CLOSE_DRAG_DISTANCE, openHeightRef.current || MIN_CLOSE_DRAG_DISTANCE)
    const next = open
      ? Math.min(closeDistance, Math.max(0, delta))
      : Math.min(openHeightRef.current || MIN_OPEN_DRAG_DISTANCE, Math.max(0, -delta))
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
    if (!open) measureOpenHeight()
    onToggle(!open)
  }

  return (
    <section
      ref={sheetRef}
      className={`plan-peek${open ? ' is-open' : ''}${dragging ? ' is-dragging' : ''}${previewing ? ' is-drag-preview' : ''}`}
      aria-label="Lesson plan preview"
    >
      <button
        type="button"
        className="plan-peek-handle"
        aria-expanded={open}
        aria-controls="plan-peek-body"
        aria-label={open ? 'Collapse lesson plan preview' : `Open ${weekLabel || 'lesson plan'} preview`}
        onClick={handleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={cancelPointer}
      >
        <span className="plan-peek-grabber" aria-hidden="true" />
        <span className="plan-peek-handle-label">{weekLabel || 'Lesson plan'}</span>
        <span className="plan-peek-handle-action" aria-hidden="true">
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </span>
      </button>
      <div id="plan-peek-body" className="plan-peek-body" aria-hidden={!open} inert={!open}>
        <div className="plan-peek-body-inner">{children}</div>
      </div>
    </section>
  )
}
