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

import { Check, Loader2 } from 'lucide-react'
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

  // The chat-reply form (loose=true), on request: a neomorphic vertical list
  // instead of the five-card grid below. Also what the generation-progress
  // indicator uses now (ChatPage passes writing+loose together) — a vertical
  // stack has room for a distinct in-progress row the horizontal grid never
  // did, and neo-world's soft edges are no longer a tradeoff unique to one
  // surface now that the whole authenticated app wears them. The document
  // header (the one place a teacher verifies standards against) is the sole
  // holdout, kept on the plain grid below for full contrast.
  if (loose) {
    return (
      <div className={className}>
        <ul
          className="neo-world neo-panel flex flex-col gap-1 rounded-2xl bg-paper-raised p-2"
          role="group"
          aria-label={label}
        >
          {DAYS.map((name, i) => {
            const day = byName.get(name)
            const isOff = day?.no_school
            const isWriting = writing && name === nextUnwritten
            const title = day ? dayTitle(day) : null
            // A day's own status, not a fixed index — the row that just
            // finished replays its entrance the instant IT arrives, not on a
            // synthetic stagger (compare RailRow's fixed 60ms one, which has
            // to fake that pacing because nothing there is actually arriving
            // over time). Real generation timing IS the timing, so the key
            // just has to change when the status does, for React to remount
            // the row and let fa-rise play again.
            const status = day ? 'done' : isWriting ? 'writing' : 'pending'
            // The one case the reasoning above doesn't cover: a plan that's
            // ALREADY finished the moment this mounts (reopening a chat, or
            // any reply whose plan arrived whole rather than streamed) has
            // no real per-row arrival time to key off — every row is "done"
            // in the same render, so fa-rise fires on all five at once. A
            // fixed stagger, RailRow's own trick, is the right fallback
            // there specifically: `writing` being false is exactly the
            // signal that there's no real timing left to prefer.
            const dropStyle = !writing ? { animationDelay: `${i * 60}ms` } : undefined

            return (
              <li
                key={`${name}-${status}`}
                style={dropStyle}
                className={`flex items-center gap-3 px-3 py-2 ${status === 'done' ? 'fa-rise' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-2xs font-semibold transition-shadow ${
                    isWriting
                    ? 'neo-raised text-accent-text fa-progress-sweep'
                      : `neo-inset ${isOff ? 'text-ink-faint' : day ? 'text-accent-text' : 'text-ink-muted'}`
                  }`}
                >
                  {/* Check/spinner only while writing — three distinct states
                      (done/active/pending) that carry real information about
                      a week still being built. On a FINISHED plan every row
                      is "done", so a checkmark on all five would say nothing
                      a teacher doesn't already know from it being attached to
                      a reply at all — the day-of-week initial is what that
                      view actually needs (this is evidence FOR a specific
                      day, not a progress report). */}
                  {writing && day ? (
                    // The row already remounts on this status change (the key
                    // above is `${name}-${status}`), so the pop replays for
                    // every day as it lands — not just the first one — the
                    // same moment fa-rise is announcing on the row itself.
                    <Check size={14} className="fa-pop" aria-hidden="true" />
                  ) : isWriting ? (
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  ) : (
                    SHORT[name].slice(0, 2).toUpperCase()
                  )}
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
