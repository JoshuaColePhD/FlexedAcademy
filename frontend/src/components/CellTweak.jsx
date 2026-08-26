import { X } from 'lucide-react'
import { FIELD_LABELS } from '../lib/planShape'

/* One implementation of "what a clickable cell is", shared by the district
 * table (LessonPlanTable.jsx) and the phone day-card deck (PlanDayCards.jsx).
 * Both show the same week in two shapes, and every one of these behaviours —
 * which fields open, what flashes, how a keyboard reaches them — has to be
 * identical in both or the two views quietly become two different editors.
 * Extracted to its own module (not left inside LessonPlanTable, which
 * PlanDayCards already imports) so importing it doesn't create a cycle.
 */

/** Suggested tweaks, per field. A chip fills the input rather than firing the
 *  revision outright: a stray click on a compliance document should not cost a
 *  model call and a rebuilt .docx. */
export const CHIPS = {
  learning_targets: ['Shorter', 'Lower the DOK', 'Make the verb measurable'],
  standards: ['Use a different standard', 'Add a second code'],
  act_alignment: ['Use a different ACT code', 'Leave it empty'],
  engagement_strategy: ['Something more active', 'Fewer strategies'],
  do_now: ['Shorter', 'More rigorous', 'Make it a quickwrite'],
  during: ['Shorter', 'More rigorous', 'Add a group activity'],
  assessment: ['Shorter', 'More rigorous', 'Make it written'],
}

export const cellKey = (dayIndex, field) => `${dayIndex}:${field}`

/** The editor, rendered where the text was. */
export function CellTweak({
  field,
  current,
  draft,
  setDraft,
  onApply,
  onCancel,
  busy,
  scope,
  setScope,
  weekDayCount,
}) {
  return (
    // fa-card-drop, not a bare Fragment: this popover used to appear/
    // disappear as a hard conditional render with zero animation — a
    // small thing resolving into place is exactly what this animation
    // already communicates elsewhere (voice mode's decision cards).
    <div className="fa-card-drop">
      <div className="cell-tweak-current">
        <b className="cell-tweak-label">{FIELD_LABELS[field] || field} · tweaking</b>
        {current}
      </div>
      {/* Only worth asking when there's more than one day to spread the
          instruction across — a single-teaching-day week has nothing for
          "All N days" to mean. */}
      {setScope && weekDayCount > 1 ? (
        <div className="cell-tweak-scope" role="radiogroup" aria-label="Apply this tweak to">
          <button
            type="button"
            role="radio"
            aria-checked={scope !== 'week'}
            className={`cell-tweak-scope-opt${scope !== 'week' ? ' is-active' : ''}`}
            onClick={() => setScope('day')}
          >
            This day
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={scope === 'week'}
            className={`cell-tweak-scope-opt${scope === 'week' ? ' is-active' : ''}`}
            onClick={() => setScope('week')}
          >
            All {weekDayCount} days
          </button>
        </div>
      ) : null}
      <div className="cell-tweak-row">
        <label className="visually-hidden" htmlFor="cell-tweak-input">
          What should change about this {FIELD_LABELS[field] || field}?
        </label>
        <input
          id="cell-tweak-input"
          className="input"
          autoFocus
          placeholder="What should change?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onApply()
            if (e.key === 'Escape') {
              /* Stops here. ArtifactPanel's focus trap also listens for Escape
                 and collapses the whole document — so without this, cancelling
                 a two-word tweak threw away the document you were working in. */
              e.stopPropagation()
              onCancel()
            }
          }}
        />
        <button
          type="button"
          className="cell-tweak-apply"
          disabled={busy || !draft.trim()}
          onClick={onApply}
        >
          Apply
        </button>
        <button type="button" className="btn-icon" onClick={onCancel} aria-label="Cancel this tweak">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="cell-tweak-chips">
        {(CHIPS[field] || []).map((chip) => (
          <button
            key={chip}
            type="button"
            className="cell-tweak-chip fa-press"
            onClick={() => {
              setDraft(chip)
              document.getElementById('cell-tweak-input')?.focus()
            }}
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Builds the shared open/close/flash/keyboard-trigger behaviour for a set of
 *  tweakable cells. Both LessonPlanTable's PlanTable and PlanDayCards call
 *  this with the SAME state (owned by LessonPlanTable) so the two views can
 *  never disagree about which cell is open. */
export function cellKit({
  busy,
  flashCells,
  canTweak,
  openTweak,
  openCell,
  closeCell,
  applyTweak,
  draft,
  setDraft,
  scope,
  setScope,
  weekDayCount,
}) {
  const isOpen = (dayIndex, field) =>
    openTweak?.dayIndex === dayIndex && openTweak?.field === field
  const flashed = (dayIndex, field) => flashCells?.has(cellKey(dayIndex, field))

  /* Deliberately NOT role="button" + tabIndex on the cell. Two consumers put
     <Cite> buttons inside it, and a button inside a button is a real
     screen-reader failure, not a lint nit. The pointer affordance is the
     cell; the keyboard affordance is the Trigger, which is off-screen until
     focused. */
  const editableProps = (dayIndex, field) =>
    canTweak
      ? {
          className: `is-editable${flashed(dayIndex, field) ? ' fa-flash' : ''}`,
          onClick: () => openCell(dayIndex, field),
        }
      : { className: flashed(dayIndex, field) ? 'fa-flash' : undefined }

  /** The keyboard path into a cell tweak. Invisible until it has focus, at
   *  which point it becomes a visible pill — so tabbing through the document
   *  never lands on something a sighted keyboard user cannot see. */
  const Trigger = ({ dayIndex, field, dayName }) =>
    canTweak ? (
      <button
        type="button"
        className="cell-tweak-trigger"
        onClick={(e) => {
          e.stopPropagation()
          openCell(dayIndex, field)
        }}
      >
        Tweak {dayName}’s {FIELD_LABELS[field] || field}
      </button>
    ) : null

  const tweakBody = (field, current) => (
    <CellTweak
      field={field}
      current={current}
      draft={draft}
      setDraft={setDraft}
      onApply={applyTweak}
      onCancel={closeCell}
      busy={busy}
      scope={scope}
      setScope={setScope}
      weekDayCount={weekDayCount}
    />
  )

  return { canTweak, isOpen, flashed, editableProps, Trigger, tweakBody }
}
