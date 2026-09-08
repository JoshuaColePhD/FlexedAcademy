import { useEffect, useRef, useState } from 'react'
import { CalendarDays, Check, ChevronsUpDown } from 'lucide-react'
import { shortRange } from '../lib/dates'
import { useExitTransition } from '../hooks/useExitTransition'

/* Which week this conversation is planning. This is a themed listbox rather
 * than a native select so its open state uses the same curved menu treatment
 * as the class picker on every platform. */
export function WeekPicker({ options, value, onChange, schoolName, disabled = false, fullWidthMenu = false }) {
  const [open, setOpen] = useState(false)
  const { mounted, closing } = useExitTransition(open, 150)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!options.length) return null

  const selected = options.find((option) => option.week === value)
  const labelFor = (week) => {
    const range = shortRange(week.start, week.end)
    return `Week ${String(week.week).padStart(2, '0')}${range ? ` · ${range}` : ''}`
  }

  return (
    <div className={`chat-week relative${open ? ' is-open' : ''}`} ref={ref}>
      <CalendarDays size={12} aria-hidden="true" />
      <button
        id="week-picker"
        type="button"
        aria-label={schoolName ? `${schoolName} week` : 'Week'}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="week-picker-trigger min-w-0 flex-1"
      >
        <span className="min-w-0 flex-1 truncate">{selected ? labelFor(selected) : 'Week not set'}</span>
        <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
      </button>
      {mounted ? (
        <ul
          role="listbox"
          aria-label={schoolName ? `${schoolName} weeks` : 'Weeks'}
          className={`week-picker-menu neo-panel fa-card-drop absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-2xl bg-paper-raised py-1${fullWidthMenu ? ' chat-header-sheet-menu' : ''}${closing ? ' fa-chip-exit' : ''}`}
        >
          {options.map((week) => (
            <li key={week.week}>
              <button
                type="button"
                role="option"
                aria-selected={week.week === value}
                onClick={() => {
                  setOpen(false)
                  onChange(week.week)
                }}
                className={`flex min-h-touch w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${week.week === value ? 'bg-paper-inset text-ink' : 'text-ink-soft hover:bg-paper-sunken'}`}
              >
                <span className="min-w-0 flex-1 truncate">{labelFor(week)}</span>
                {week.has_plan ? <Check size={13} aria-hidden="true" className="shrink-0 text-ok" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
