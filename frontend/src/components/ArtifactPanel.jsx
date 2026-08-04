import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw, X } from 'lucide-react'
import { api } from '../lib/api'
import { LessonPlanTable } from './LessonPlanTable'
import { GroundingStrip, Marginalia } from './Marginalia'

const WIDTH_KEY = 'aplang.artifactWidth'
const MIN_W = 420

function useResizable() {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(saved) && saved >= MIN_W ? saved : null
  })
  const dragging = useRef(false)

  const onPointerDown = useCallback((e) => {
    dragging.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }, [])

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return
      const next = Math.max(MIN_W, Math.min(window.innerWidth - 360, window.innerWidth - e.clientX))
      setWidth(next)
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      setWidth((w) => {
        if (w) localStorage.setItem(WIDTH_KEY, String(w))
        return w
      })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // Keyboard-resizable too, so the handle isn't mouse-only.
  const onKeyDown = useCallback((e) => {
    const step = e.shiftKey ? 80 : 24
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      setWidth((w) => {
        const base = w || 640
        const next = Math.max(
          MIN_W,
          Math.min(window.innerWidth - 360, base + (e.key === 'ArrowLeft' ? step : -step))
        )
        localStorage.setItem(WIDTH_KEY, String(next))
        return next
      })
    }
  }, [])

  return { width, onPointerDown, onKeyDown }
}

export function ArtifactPanel({ artifact, onClose, onReviseDay, busy, streamingText }) {
  const { width, onPointerDown, onKeyDown } = useResizable()
  const [rebuilding, setRebuilding] = useState(false)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const plan = artifact?.plan
  const planId = artifact?.planId
  const grounded = new Set(artifact?.grounding?.codes || artifact?.retrievedIds || [])

  const rebuild = async () => {
    setRebuilding(true)
    try {
      await api.rebuildPlan(planId)
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <aside
      className="artifact-panel"
      style={width ? { width } : undefined}
      aria-label="Generated lesson plan"
    >
      <button
        type="button"
        className="resizer"
        aria-label="Resize panel. Use the left and right arrow keys."
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />

      <div className="artifact-head">
        <span className="artifact-head-title">
          <strong>{plan?.week_of || 'Lesson plan'}</strong>
          <small>
            {planId ? 'florence-docx-v2 · saved' : busy ? 'Drafting…' : 'Preview'}
            {artifact?.unit ? ` · ${artifact.unit}` : ''}
          </small>
        </span>

        {planId ? (
          <>
            <button
              type="button"
              className="btn-icon"
              onClick={rebuild}
              disabled={rebuilding}
              aria-label="Rebuild the document from the saved plan"
              title="Rebuild document"
            >
              {rebuilding ? (
                <Loader2 size={15} className="spin" aria-hidden="true" />
              ) : (
                <RefreshCw size={15} aria-hidden="true" />
              )}
            </button>
            <a
              className="btn btn-outline"
              href={api.planDownloadUrl(planId)}
              download
              aria-label="Download as a Word document"
            >
              <Download size={14} aria-hidden="true" /> DOCX
            </a>
          </>
        ) : (
          /* No planId yet means the document does not exist — the old UI rendered
             a live link that requested /api/download/null mid-stream. */
          <button className="btn btn-outline" disabled aria-label="Download available once saved">
            <Download size={14} aria-hidden="true" /> DOCX
          </button>
        )}

        <button type="button" className="btn-icon" onClick={onClose} aria-label="Close panel">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="artifact-scroll">
        {plan?.days?.length ? (
          <>
            {artifact?.grounding ? <GroundingStrip grounding={artifact.grounding} /> : null}
            <div style={{ height: 'var(--sp-4)' }} />
            <LessonPlanTable
              plan={plan}
              groundedCodes={grounded}
              onReviseDay={planId ? onReviseDay : undefined}
              busy={busy}
            />
            <div style={{ height: 'var(--sp-4)' }} />
            <Marginalia warnings={artifact?.warnings} />
          </>
        ) : streamingText ? (
          <pre className="artifact-raw">{streamingText}</pre>
        ) : (
          <p className="empty-note">Waiting for the first day…</p>
        )}
      </div>
    </aside>
  )
}
