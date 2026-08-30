import { FIELD_LABELS } from '../lib/planShape'
import { CODE_FIELDS, cellKey } from './cellTweakConfig'
import { CellTweak } from './CellTweak'

/* Shared non-component behavior lives outside the component module so React's
 * Fast Refresh can preserve the editor state while either table consumer
 * reloads during development. */
export function cellKit({
  busy,
  flashCells,
  canTweak,
  openTweak,
  openCell,
  closeCell,
  applyTweak,
  pickStandard,
  standardsByCode,
  draft,
  setDraft,
  scope,
  setScope,
  weekDayCount,
}) {
  const isOpen = (dayIndex, field) =>
    openTweak?.dayIndex === dayIndex && openTweak?.field === field
  const flashed = (dayIndex, field) => flashCells?.has(cellKey(dayIndex, field))

  const editableProps = (dayIndex, field) =>
    canTweak
      ? {
          className: `is-editable${flashed(dayIndex, field) ? ' fa-flash' : ''}`,
          onClick: () => openCell(dayIndex, field),
        }
      : { className: flashed(dayIndex, field) ? 'fa-flash' : undefined }

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

  const tweakBody = (dayIndex, field, current) => (
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
      options={CODE_FIELDS.has(field) ? Object.values(standardsByCode || {}).filter(Boolean) : null}
      onPick={pickStandard ? (code) => pickStandard(dayIndex, field, code) : null}
    />
  )

  return { canTweak, isOpen, flashed, editableProps, Trigger, tweakBody }
}
