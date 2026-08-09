import { shortRange } from '../lib/dates'

/* Which week a new plan is about to become — visible and changeable BEFORE
 * generation starts, not discovered from the finished document's own header
 * after a 30-second wait. Defaults to the same next-unplanned week the
 * Greeting suggestion already names; picking a different one here is what
 * makes that choice deterministic instead of left to the model's guess (see
 * backend/routes/generate.py's `_with_week`). */
export function WeekPicker({ options, value, onChange }) {
  if (!options.length) return null

  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-ink-muted">
      <label htmlFor="week-picker" className="shrink-0">
        Planning for
      </label>
      <select
        id="week-picker"
        value={value ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 rounded-md border border-edge bg-paper-raised px-2 py-1 font-medium text-ink outline-none focus:border-accent"
      >
        {options.map((w) => (
          <option key={w.week} value={w.week}>
            Week {String(w.week).padStart(2, '0')} — {shortRange(w.start, w.end)}
            {w.has_plan ? ' (already planned)' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
