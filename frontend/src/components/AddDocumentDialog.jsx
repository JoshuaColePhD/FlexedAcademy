import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { ClassDocuments } from './ClassDocuments.jsx'
import { useExitTransition } from '../hooks/useExitTransition'
import { useFocusTrap } from '../hooks/useFocusTrap'

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
 */
export function AddDocumentDialog({ open, onClose, cls, onChanged }) {
  const { mounted, closing } = useExitTransition(open, 200)
  const dialogRef = useRef(null)

  useFocusTrap(dialogRef, { active: open, trap: true, onEscape: onClose })

  if (!mounted || !cls) return null

  return createPortal(
    <div
      className={`dialog-scrim${closing ? ' is-closing' : ''}`}
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
        <h2 id="add-document-title">Add a pacing guide or syllabus</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Either one helps plans for {cls.name} follow your real sequence and unit names instead of a generic
          pace.
        </p>

        <ClassDocuments cls={cls} onChanged={onChanged} />

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
