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

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const SHORT = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri' }

/** @param {{days?: Array, writing?: boolean, compact?: boolean}} props
 *  `days` is the plan's own day objects; anything absent is treated as unwritten. */
export function WeekStrip({ days, writing = false, compact = false, className = '' }) {
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
                <span className="week-day-note">No school</span>
              ) : day ? (
                !compact && day.learning_targets ? (
                  <span className="week-day-note line-clamp-2">{day.learning_targets}</span>
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
