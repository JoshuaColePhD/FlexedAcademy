import { cellKey } from './cellTweakConfig'
import { CellTweak } from './CellTweak'

/* Shared non-component behavior lives outside the component module so React's
 * Fast Refresh can preserve the editor state while either table consumer
 * reloads during development. */
export function cellKit({
  flashCells,
  workingCells,
  canTweak,
  openTweak,
  openCell,
  applyTweak,
  draft,
}) {
  const isOpen = (dayIndex, field) =>
    openTweak?.dayIndex === dayIndex && openTweak?.field === field
  const flashed = (dayIndex, field) => flashCells?.has(cellKey(dayIndex, field))
  const working = (dayIndex, field) => workingCells?.has(cellKey(dayIndex, field))

  const classNames = (dayIndex, field, extra = '') =>
    [extra, canTweak ? 'is-editable' : '', flashed(dayIndex, field) ? 'fa-flash' : '', working(dayIndex, field) ? 'is-working' : '']
      .filter(Boolean)
      .join(' ')

  const workingLabel = (dayIndex, field) =>
    working(dayIndex, field) ? (
      <>
        <span className="plan-cell-writing" aria-hidden="true">Writing</span>
        <span className="visually-hidden">Updating this cell</span>
      </>
    ) : null

  const editableProps = (dayIndex, field) =>
    canTweak
      ? {
          className: classNames(dayIndex, field),
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
          ...(working(dayIndex, field) ? { 'aria-busy': true } : {}),
        }
      : {
          className: classNames(dayIndex, field) || undefined,
          ...(working(dayIndex, field) ? { 'aria-busy': true } : {}),
        }

  const tweakBody = (dayIndex, field, dayName) => (
    <CellTweak
      key={`${dayIndex}-${field}`}
      field={field}
      dayName={dayName}
      draft={draft}
      onApply={applyTweak}
    />
  )

  return { canTweak, isOpen, flashed, working, workingLabel, editableProps, tweakBody }
}
