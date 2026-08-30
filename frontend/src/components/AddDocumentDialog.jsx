import { lazy, Suspense, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useExitTransition } from '../hooks/useExitTransition'
import { useFocusTrap } from '../hooks/useFocusTrap'

const ClassDocuments = lazy(() => import('./ClassDocuments.jsx').then((module) => ({ default: module.ClassDocuments })))

// Mirrors ClassDocuments' own KIND_LABEL, but as a heading rather than a
// dropdown option — "Add a syllabus" reads better than "Add a Syllabus
// document" once it's the title of the whole dialog.
const DIALOG_TITLE = {
  pacing_guide: 'Add a pacing guide',
  syllabus: 'Add a syllabus',
  curriculum_map: 'Add a curriculum map',
  other: 'Add a document',
}

/* What "Add a pacing guide" (contextualSuggestions.js's add-pacing-guide,
 * action: 'open-settings') opens from the composer, instead of the plain-text
 * chat prompt it used to fill in — asking the model in a chat message to
 * "add the pacing guide" only ever got the teacher redirected to the class
 * settings page anyway, one extra hop for something that's just a file
 * upload. This is that upload, without leaving the chat.
 *
 * ClassDocuments already IS that upload flow (kind picker, file input,
 * existing-documents list) — ClassPage's own settings page renders it
 * inline. This is only the modal shell around the same component, so a
 * pacing guide or syllabus added here shows up identically wherever
 * hasPacingGuide is read from (ChatPage, ClassPage, PlansPage all key off
 * the same class-documents query).
 *
 * .dialog-scrim--panel offsets past the sidebar at desktop widths (same
 * `left: var(--sidebar-w)` .artifact-overlay already uses) — a plain
 * .dialog-scrim centers across the sidebar's width too, so this dialog
 * (only ever opened from inside the chat panel) landed visibly left of
 * the panel it belongs to.
 */
export function AddDocumentDialog({ open, onClose, cls, onChanged }) {
  const { mounted, closing } = useExitTransition(open, 200)
  const dialogRef = useRef(null)
  // Mirrors ClassDocuments' own `kind` state (default matches its own
  // useState default) so the heading names whatever's actually selected,
  // not a generic "pacing guide or syllabus" regardless of choice.
  const [kind, setKind] = useState('pacing_guide')

  useFocusTrap(dialogRef, { active: open, trap: true, onEscape: onClose })

  if (!mounted || !cls) return null

  return createPortal(
    <div
      className={`dialog-scrim dialog-scrim--panel${closing ? ' is-closing' : ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`dialog${closing ? ' is-closing' : ''}`}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-document-title"
      >
        <h2 id="add-document-title">{DIALOG_TITLE[kind]}</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Keeps {cls.name}'s plans grounded in your real sequence, not a generic pace.
        </p>

        <Suspense fallback={<div className="py-8 text-sm text-ink-muted">Loading documents…</div>}>
          <ClassDocuments cls={cls} onChanged={onChanged} onKindChange={setKind} />
        </Suspense>

        <div className="dialog-actions mt-6">
          <button type="button" className="btn btn-primary fa-press" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
