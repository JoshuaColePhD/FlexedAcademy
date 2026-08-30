import { X } from 'lucide-react'
import { FIELD_LABELS } from '../lib/planShape'
import { CHIPS } from './cellTweakConfig'

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
  // The standard picker: `options` is this week's own retrieved standards
  // for this field (full records, so a description shows, not a bare
  // code) — null when this field can't carry a code, or onPick is absent
  // (no plan to write into yet). `onPick` sets the cell directly, no model
  // call — see service.set_day_field's own docstring for why that's a
  // real, separate write and not just a shortcut into the free-text box.
  options,
  onPick,
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
      {/* The direct pick: every standard THIS WEEK actually retrieved for
          this field, already grounded by construction — clicking one skips
          the free-text box and the model call entirely. Only offered when
          there's something to pick from; a thin week with nothing retrieved
          for this field still has the free-text path below as its only
          option, same as before this existed. */}
      {onPick && options?.length ? (
        <div className="cell-tweak-picker" role="listbox" aria-label={`Retrieved ${FIELD_LABELS[field] || field} options`}>
          {options.map((opt) => (
            <button
              key={opt.code}
              type="button"
              role="option"
              className="cell-tweak-picker-option fa-press"
              // Matches the model's own "CODE -- description" convention for
              // this field (see any generated cell) — not just the bare
              // code, or the cell would visibly lose its description
              // compared to every other week's.
              onClick={() => onPick(opt.description ? `${opt.code} -- ${opt.description}` : opt.code)}
              disabled={busy}
            >
              <span className="cell-tweak-picker-code">{opt.code}</span>
              <span className="cell-tweak-picker-desc">{opt.description}</span>
            </button>
          ))}
        </div>
      ) : null}
      {onPick && options?.length ? (
        <div className="cell-tweak-picker-sep">
          <span>or describe a different change</span>
        </div>
      ) : null}
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
