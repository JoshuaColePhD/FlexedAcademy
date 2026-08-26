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
export function WeekPicker({ options, value, onChange, schoolName, disabled = false }) {
  /* No weeks means the teacher's school has no calendar file on disk — a
     real, reachable state, because a school's row and its calendar live in
     different places by design (admin adds the row; the year itself is a
     hand-authored file in version control). This used to `return null`, so
     the control simply vanished and took the explanation with it: no week
     on screen, no week in the prompt, and nothing anywhere saying why or
     for which school. Naming the school is the whole point — "no calendar"
     is useless without "whose". The school's own name used to live INSIDE
     this row too (a visible label next to the select) — pulled out into its
     own leading badge in ChatPage.jsx on request (school, then course, then
     date, left to right), so it's kept here only for the empty-state
     message and the select's accessible name, neither of which is visible
     text anymore. */
  if (!options.length) {
    return null
  }

  return (
    <div className="chat-week">
      <CalendarDays size={12} aria-hidden="true" />
      {/* min-w-0 alone does NOT stop a native <select> sizing itself to its
          longest option's text — that's the box's intrinsic content width,
          which flex-shrink doesn't reliably override for form controls on
          mobile Safari. A real unit name plus a cross-month date range is
          long enough to push the whole app shell past 100vw once that
          happens: not a clipped select, a horizontally scrolling page.
          flex-1 (flex-basis 0, not auto) sidesteps that intrinsic sizing
          entirely so the OS clips the rendered text instead — but
          flex-grow:1 alone also let it claim ALL of the row's leftover
          space whenever the class name beside it was short, stretching the
          box (and the arrow painted at ITS right edge, not the text's) far
          past the visible label. max-w caps how far it grows without
          reintroducing the intrinsic-sizing bug max-width alone would (a
          max-width computed from auto content still sizes off the longest
          option); flex-shrink still takes it below that cap under real
          pressure. 28ch comfortably covers the longest realistic option
          ("Week 12 · Sep 29–Oct 3 ✓", ~24 chars) now that "already
          planned" is a checkmark instead of eighteen characters of text —
          shrink this back down if the option text ever grows again. */}
      <select
        id="week-picker"
        aria-label={schoolName ? `${schoolName} week` : 'Week'}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="week-picker-select bg-paper-raised min-w-0 max-w-[28ch] flex-1 truncate"
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
        {options.map((w) => {
          // No calendar on file yet for this school (schoolcal.py's own
          // synthetic weeks for that case carry no start/end) — a week
          // number with no date range, rather than shortRange's own empty
          // string leaving a bare trailing "· " behind.
          const range = shortRange(w.start, w.end)
          return (
            <option key={w.week} value={w.week}>
              {/* A native <option> can only hold plain text — no icon, no
                  markup — so "already planned" (long enough on its own to
                  be most of what got truncated to "alre…" in the closed
                  select) becomes a bare checkmark instead: same signal,
                  three characters instead of eighteen. */}
              Week {String(w.week).padStart(2, '0')}
              {range ? ` · ${range}` : ''}
              {w.has_plan ? ' ✓' : ''}
            </option>
          )
        })}
      </select>
    </div>
  )
}
