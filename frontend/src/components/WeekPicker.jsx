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
    <div className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
      <label htmlFor="week-picker" className="shrink-0">
        Planning for
      </label>
      {/* Borderless/transparent — this now lives inside the composer's own
          header strip, not as a standalone chip, so it should read as part
          of that control rather than a second one next to it.

          min-w-0 alone doesn't stop a native <select> sizing itself to its
          longest option's text — that's the box's intrinsic content width,
          which flex-shrink doesn't reliably override for form controls on
          mobile Safari. A real unit name plus " (already planned)" is long
          enough to blow the WHOLE PAGE past 100vw once that happens: not a
          clipped select, a horizontally scrolling app shell. flex-1 forces
          the box itself to claim the remaining row space instead of its
          content's width, so the OS clips the rendered text instead. */}
      <select
        id="week-picker"
        value={value ?? ''}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 truncate rounded-md border-0 bg-transparent px-1 py-0.5 font-medium text-ink outline-none focus:bg-paper-raised focus:ring-1 focus:ring-accent"
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
