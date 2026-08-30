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
  const [dragDistance, setDragDistance] = useState(0)
  const [dragging, setDragging] = useState(false)

  const OPEN_DRAG_DISTANCE = 120
  const CLOSE_DRAG_DISTANCE = 96

  const finishPointer = (event) => {
    const start = pointerRef.current
    if (!start) return
    const delta = event.clientY - start.y
    pointerRef.current = null
    setDragging(false)
    setDragDistance(0)

    // A deliberate drag should not also fire the button's synthetic click.
    if (Math.abs(delta) > 24) {
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }

    if (open && delta > CLOSE_DRAG_DISTANCE / 2) onToggle(false)
    else if (!open && delta < -OPEN_DRAG_DISTANCE / 2) onToggle(true)
  }

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointerRef.current = { y: event.clientY }
    setDragging(true)
    setDragDistance(0)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event) => {
    const start = pointerRef.current
    if (!start) return
    const delta = event.clientY - start.y
    // The sheet itself grows with the gesture. Closed: an upward pull reveals
    // the first slice of the document. Open: a downward pull collapses that
    // slice before release. This keeps the thumb connected to the content
    // instead of translating a handle over a still-hidden panel.
    const next = open
      ? Math.min(CLOSE_DRAG_DISTANCE, Math.max(0, delta))
      : Math.min(OPEN_DRAG_DISTANCE, Math.max(0, -delta))
    setDragDistance(next)
  }

  const cancelPointer = (event) => {
    if (!pointerRef.current) return
    pointerRef.current = null
    setDragging(false)
    setDragDistance(0)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const handleClick = () => {
    if (suppressClickRef.current) return
    onToggle(!open)
  }

  return (
    <section
      className={`plan-peek${open ? ' is-open' : ''}${dragging ? ' is-dragging' : ''}${dragDistance ? ' is-drag-preview' : ''}`}
      style={{
        '--plan-peek-drag': `${dragDistance}px`,
      }}
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
