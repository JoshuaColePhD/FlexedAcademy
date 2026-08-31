import { FIELD_LABELS } from '../lib/planShape'
import { useRef } from 'react'

/* The cell is a document editing surface, not a second AI composer. Global AI
 * revisions belong in the page composer, where the teacher can see the whole
 * conversation and plan context. This editor saves exactly what the teacher
 * typed when focus leaves the cell. */
export function CellTweak({
  field,
  dayName,
  draft,
  onApply,
}) {
  const label = FIELD_LABELS[field] || field
  const context = dayName ? `${dayName} · ${label}` : label
  const draftRef = useRef(draft)

  return (
    <div
      aria-label={`Editing ${context}`}
      role="textbox"
      aria-multiline="true"
      className="input cell-inline-editor-input"
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
      placeholder={`Edit ${label.toLowerCase()}…`}
      onInput={(event) => {
        draftRef.current = event.currentTarget.innerText
      }}
      onBlur={() => onApply(draftRef.current)}
    >
      {draft}
    </div>
  )
}
