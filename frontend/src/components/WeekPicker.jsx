import { useEffect, useRef } from 'react'
import { Check } from 'lucide-react'
import { shortRange } from '../lib/dates'

/* Which week this conversation is planning. The chat header sheet shows this
 * list in flow — a nested dropdown inside that dialog used to hide the course
 * field and jump the selected week off-screen. */
export function WeekPicker({
  options,
  priorOptions = [],
  value,
  onChange,
  schoolName,
  disabled = false,
}) {
  const listRef = useRef(null)
  const selectedRef = useRef(null)

  useEffect(() => {
    const list = listRef.current
    const selected = selectedRef.current
    if (!list || !selected) return
    const top = selected.offsetTop - list.clientHeight / 2 + selected.offsetHeight / 2
    list.scrollTop = Math.max(0, top)
  }, [value, options.length, priorOptions.length])

  if (!options.length && !priorOptions.length) return null

  const labelFor = (week) => {
    const range = shortRange(week.start, week.end)
    return `Week ${String(week.week).padStart(2, '0')}${range ? ` · ${range}` : ''}`
  }

  const renderWeek = (week) => {
    const selected = week.week === value
    return (
      <li key={week.week}>
        <button
          ref={selected ? selectedRef : undefined}
          type="button"
          role="option"
          aria-selected={selected}
          disabled={disabled}
          onClick={() => onChange(week.week)}
          className={`week-picker-option${selected ? ' is-selected' : ''}`}
        >
          <span className="min-w-0 flex-1 truncate">{labelFor(week)}</span>
          {week.has_plan ? <Check size={13} aria-hidden="true" className="shrink-0 text-ok" /> : null}
        </button>
      </li>
    )
  }

  return (
    <ul
      ref={listRef}
      role="listbox"
      aria-label={schoolName ? `${schoolName} weeks` : 'Weeks'}
      className="week-picker-embedded"
    >
      {options.map(renderWeek)}
      {priorOptions.length ? (
        <li className="week-picker-group" role="presentation">
          <p className="week-picker-group-label">Earlier weeks</p>
        </li>
      ) : null}
      {priorOptions.map(renderWeek)}
    </ul>
  )
}
