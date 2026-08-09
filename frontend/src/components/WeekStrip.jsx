/* The week strip — the design's signature element.
 *
 * Five cells, Monday to Friday, in the order the model writes them. It is the
 * same object in three places: the empty state (an unwritten week), the
 * generation indicator (days filling left to right), and the artifact header (a
 * finished week at a glance). It encodes something true about the content — a
 * plan IS five days, produced in order — rather than decorating it.
 *
 * Deliberately not a percentage bar. "3 of 5 days written, Thursday in
 * progress" is the fact a teacher wants; "62%" is not. */

import { dayTitle } from '../lib/planShape'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri' }

/** @param {{days?: Array, writing?: boolean, compact?: boolean, loose?: boolean}} props
 *  `days` is the plan's own day objects; anything absent is treated as unwritten.
 *
 *  `loose` is the form it takes inside a chat message: separate rounded cells
 *  rather than one ruled block, because in the transcript it is a piece of
 *  evidence attached to a reply and not a header over a document. A no-school
 *  day is hatched there — tone alone can't say "school is shut" as against
 *  "this surface is sunken", and in a five-cell strip that difference is the
 *  whole point. */
export function WeekStrip({ days, writing = false, compact = false, loose = false, className = '' }) {
  const byName = new Map((days || []).map((d) => [d.name, d]))

  // The day currently being written is the first one that hasn't arrived. Only
  // meaningful while a stream is open.
  const nextUnwritten = DAYS.find((n) => !byName.has(n))

  const written = DAYS.filter((n) => byName.has(n))
  const label = writing
    ? `Writing ${nextUnwritten || 'the last day'} — ${written.length} of 5 days done`
    : written.length === 0
      ? 'No days written yet'
      : `${written.length} of 5 days`

  // The chat-reply form (loose=true), on request: a neomorphic bulleted list
  // instead of the five-card grid below. Scoped to THIS variant only — the
  // grid stays the signature element everywhere else (the artifact header,
  // the generation-progress indicator) — because neo-world's soft, low-
  // contrast edges are a tradeoff worth making for one decorative element
  // inside a reply, not for the document header a teacher actually verifies
  // standards against.
  if (loose) {
    return (
      <div className={className}>
        <ul
          className="neo-world neo-panel flex flex-col gap-1 rounded-2xl bg-paper-raised p-2"
          role="group"
          aria-label={label}
        >
          {DAYS.map((name) => {
            const day = byName.get(name)
            const isOff = day?.no_school
            const isWriting = writing && name === nextUnwritten
            const title = day ? dayTitle(day) : null

            return (
              <li key={name} className="flex items-center gap-3 px-3 py-2">
                <span
                  aria-hidden="true"
                  className={`neo-inset grid h-8 w-8 shrink-0 place-items-center rounded-full text-2xs font-semibold ${
                    isOff ? 'text-ink-faint' : day ? 'text-accent-text' : 'text-ink-muted'
                  }`}
                >
                  {SHORT[name].slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {isOff ? (
                    <span className="text-ink-faint">{title || 'No school'}</span>
                  ) : day ? (
                    title || <span className="text-ink-faint">Written</span>
                  ) : isWriting ? (
                    <span className="text-ink-muted">Writing…</span>
                  ) : (
                    <span className="text-ink-faint">Not written yet</span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="visually-hidden" role="status">
          {label}
        </p>
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="week-strip" role="group" aria-label={label}>
        {DAYS.map((name) => {
          const day = byName.get(name)
          const isOff = day?.no_school
          const isWriting = writing && name === nextUnwritten
          const state = isOff ? 'is-off' : day ? 'is-filled' : isWriting ? 'is-writing' : ''

          return (
            <div className={`week-day ${state}`} key={name}>
              <span className="week-day-label">{SHORT[name]}</span>

              {isOff ? (
                <span className="week-day-note">{dayTitle(day)}</span>
              ) : day ? (
                !compact && dayTitle(day) ? (
                  <span className="week-day-note line-clamp-2">{dayTitle(day)}</span>
                ) : null
              ) : isWriting ? (
                <span className="week-day-bar" aria-hidden="true">
                  <i />
                </span>
              ) : (
                /* An unwritten day is a blank ruled line, not a grey box. */
                <span
                  aria-hidden="true"
                  className="mt-auto block h-px w-full bg-edge-strong"
                />
              )}
            </div>
          )
        })}
      </div>
      <p className="visually-hidden" role="status">
        {label}
      </p>
    </div>
  )
}
