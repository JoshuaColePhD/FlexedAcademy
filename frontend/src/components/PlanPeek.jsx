import { useRef, useState } from 'react'
import { ChevronDown, ChevronUp, GripHorizontal } from 'lucide-react'

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
  const [dragOffset, setDragOffset] = useState(0)
  const [dragging, setDragging] = useState(false)

  const finishPointer = (event) => {
    const start = pointerRef.current
    if (!start) return
    const delta = event.clientY - start.y
    pointerRef.current = null
    setDragging(false)
    setDragOffset(0)

    // A deliberate drag should not also fire the button's synthetic click.
    if (Math.abs(delta) > 24) {
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }

    if (open && delta > 48) onToggle(false)
    else if (!open && delta < -32) onToggle(true)
  }

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointerRef.current = { y: event.clientY }
    setDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event) => {
    const start = pointerRef.current
    if (!start) return
    const delta = event.clientY - start.y
    // The open sheet follows a downward pull. The collapsed handle follows a
    // short upward pull just enough to make the gesture feel connected before
    // snapping open on release.
    const next = open ? Math.max(0, delta) : Math.min(0, delta)
    setDragOffset(next)
  }

  const cancelPointer = (event) => {
    if (!pointerRef.current) return
    pointerRef.current = null
    setDragging(false)
    setDragOffset(0)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const handleClick = () => {
    if (suppressClickRef.current) return
    onToggle(!open)
  }

  return (
    <section
      className={`plan-peek${open ? ' is-open' : ''}`}
      style={{
        transform: dragOffset ? `translateY(${dragOffset}px)` : undefined,
        transition: dragging ? 'none' : undefined,
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
        <GripHorizontal size={16} aria-hidden="true" />
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
