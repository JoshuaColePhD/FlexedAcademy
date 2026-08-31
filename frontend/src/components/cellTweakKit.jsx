import { cellKey } from './cellTweakConfig'
import { CellTweak } from './CellTweak'

/* Shared non-component behavior lives outside the component module so React's
 * Fast Refresh can preserve the editor state while either table consumer
 * reloads during development. */
export function cellKit({
  flashCells,
  canTweak,
  openTweak,
  openCell,
  applyTweak,
  draft,
}) {
  const isOpen = (dayIndex, field) =>
    openTweak?.dayIndex === dayIndex && openTweak?.field === field
  const flashed = (dayIndex, field) => flashCells?.has(cellKey(dayIndex, field))

  const editableProps = (dayIndex, field) =>
    canTweak
      ? {
          className: `is-editable${flashed(dayIndex, field) ? ' fa-flash' : ''}`,
          onClick: () => openCell(dayIndex, field),
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openCell(dayIndex, field)
            }
          },
          tabIndex: 0,
          role: 'button',
          'aria-label': `Edit ${field.replaceAll('_', ' ')}`,
        }
      : { className: flashed(dayIndex, field) ? 'fa-flash' : undefined }

  const tweakBody = (dayIndex, field, dayName) => (
    <CellTweak
      key={`${dayIndex}-${field}`}
      field={field}
      dayName={dayName}
      draft={draft}
      onApply={applyTweak}
    />
  )

  return { canTweak, isOpen, flashed, editableProps, tweakBody }
}
