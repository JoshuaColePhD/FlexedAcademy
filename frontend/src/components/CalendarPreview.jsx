import { shortRange } from '../lib/dates'

/* Read-only rendering of a parsed calendar submission's weeks — the same
 * list shape backend/schema.py's CALENDAR_JSON_SCHEMA produces and
 * schoolcal.py's file parser has always produced. Reused everywhere a
 * teacher needs to actually look at a submission before trusting it:
 * WelcomePage right after upload, SettingsPage/ClassPage's peer-confirm
 * dialog, and AdminPage's approval queue.
 *
 * Capped at 12 rows with a "+N more weeks" line rather than rendering all
 * ~35 — the point of this preview is "does this look like a real calendar",
 * not a full audit; scrolling past thirty rows to confirm a school year
 * defeats that.
 */
const PREVIEW_ROWS = 12

export function CalendarPreview({ weeks }) {
  if (!weeks?.length) {
    return <p className="text-sm text-ink-muted">No weeks to show.</p>
  }
  const shown = weeks.slice(0, PREVIEW_ROWS)
  const remaining = weeks.length - shown.length

  return (
    <div className="rounded-lg border border-edge">
      <ul className="max-h-72 divide-y divide-edge overflow-y-auto text-sm">
        {shown.map((w) => {
          const range = shortRange(w.start, w.end)
          return (
            <li key={w.week} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="text-ink">
                Week {String(w.week).padStart(2, '0')}
                {range ? <span className="text-ink-muted"> · {range}</span> : null}
              </span>
              {w.no_school ? (
                <span className="shrink-0 rounded-full bg-mark-tint px-2 py-0.5 text-2xs font-medium text-mark">
                  No school
                </span>
              ) : w.closures ? (
                <span className="shrink-0 rounded-full bg-flag-tint px-2 py-0.5 text-2xs font-medium text-flag">
                  {w.notes || 'Partial closure'}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {remaining > 0 ? (
        <p className="border-t border-edge px-3 py-1.5 text-2xs text-ink-muted">
          +{remaining} more week{remaining === 1 ? '' : 's'}
        </p>
      ) : null}
    </div>
  )
}
