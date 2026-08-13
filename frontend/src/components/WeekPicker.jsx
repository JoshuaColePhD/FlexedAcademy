import { CalendarDays } from 'lucide-react'
import { shortRange } from '../lib/dates'

/* Which week this conversation is planning — stated plainly, and changeable
 * without leaving the chat.
 *
 * History worth knowing before editing this: a version of this control lived
 * INSIDE the composer's header strip and was removed (commit eda8141) for
 * making that dock feel busy. It came back first as a read-only readout,
 * which answered "which week am I on" but left changing it to a trip out to
 * My classes and a scroll through 36 rows — too much friction for the one
 * thing a teacher does constantly. So: a real dropdown again, but its own
 * quiet line above the composer rather than crowded into it.
 *
 * Two things make it honest where the old one wasn't:
 *  - It stays visible for the whole conversation. The old one rendered only
 *    while the chat was empty, so the moment you started talking you lost
 *    sight of the week again — half of why it was easy to lose track.
 *  - The value comes from the chat's own pinned week (db.py migration 24),
 *    not from a calendar expression that drifts to the next unplanned week
 *    the moment this one gets built.
 */
export function WeekPicker({ options, value, onChange, disabled = false }) {
  if (!options.length) return null

  return (
    <div className="chat-week">
      <CalendarDays size={12} aria-hidden="true" />
      <label htmlFor="week-picker" className="shrink-0">
        Planning
      </label>
      {/* min-w-0 alone does NOT stop a native <select> sizing itself to its
          longest option's text — that's the box's intrinsic content width,
          which flex-shrink doesn't reliably override for form controls on
          mobile Safari. A real unit name plus " · already planned" is long
          enough to push the whole app shell past 100vw once that happens:
          not a clipped select, a horizontally scrolling page. flex-1 makes
          the box claim the row's remaining space instead of its content's
          width, so the OS clips the rendered text instead. */}
      <select
        id="week-picker"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="week-picker-select min-w-0 flex-1 truncate"
      >
        {/* Chats created before the week was pinned (db.py migration 24) have
            no week to show. Without an option matching value="" the browser
            falls back to selecting the FIRST one, so such a chat quietly
            claimed to be about whatever week happened to top the list —
            precisely the misreporting this control exists to end. Naming the
            gap is honest, and picking a week from here fills it in. */}
        {value == null ? (
          <option value="" disabled>
            Week not set
          </option>
        ) : null}
        {options.map((w) => (
          <option key={w.week} value={w.week}>
            Week {String(w.week).padStart(2, '0')} · {shortRange(w.start, w.end)}
            {w.has_plan ? ' · already planned' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}
