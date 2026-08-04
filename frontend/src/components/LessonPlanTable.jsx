import { useState } from 'react'
import { ArrowUp, Sparkles, X } from 'lucide-react'
import { CitedText } from './Citation'

/* Mirrors template florence-docx-v2 — the table the district actually gets.

   Rows: Learning Targets, Standards, ACT Alignment, Engagement Strategy, Lesson
   (with bold Do Now / During / Assessment sub-blocks). There is no
   Curriculum/Resources row and no "What will learning look like?" row; those
   belong to the retired v1 template still described in the workspace CLAUDE.md.

   A no-school day matches the builder exactly: "No School" centred in the first
   content row, the rest of that column blank and unshaded, and no revise button. */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

const ROWS = [
  { label: 'Learning Targets', key: 'learning_targets' },
  { label: 'Standards', key: 'standards', cited: true },
  { label: 'ACT Alignment', key: 'act_alignment', cited: true },
  { label: 'Engagement Strategy', key: 'engagement_strategy', tags: true },
  { label: 'Lesson', key: null },
]

const LESSON_PARTS = [
  ['Do Now', 'do_now'],
  ['During', 'during'],
  ['Assessment', 'assessment'],
]

function LessonCell({ day }) {
  return (
    <>
      {LESSON_PARTS.map(([label, key]) =>
        day[key] ? (
          <div className="plan-lesson-part" key={key}>
            <b>{label}:</b>
            {day[key]}
          </div>
        ) : null
      )}
    </>
  )
}

export function LessonPlanTable({ plan, groundedCodes, onReviseDay, busy, streaming }) {
  const [openDay, setOpenDay] = useState(null)
  // Per-day draft, so text typed for Monday cannot leak into Tuesday's box —
  // the old version shared one useState across every day.
  const [drafts, setDrafts] = useState({})

  if (!plan?.days?.length) return null

  const byName = new Map(plan.days.map((d) => [d.name, d]))
  // While streaming, a day that hasn't arrived yet is PENDING, not a holiday —
  // rendering it as "No School" would misreport the plan mid-flight.
  const ordered = DAYS.map(
    (name) => byName.get(name) || (streaming ? { name, pending: true } : { name, no_school: true })
  )

  const submit = (index, day) => {
    const feedback = (drafts[day.name] || '').trim()
    if (!feedback) return
    onReviseDay?.(index, day, feedback)
    setOpenDay(null)
    setDrafts((d) => ({ ...d, [day.name]: '' }))
  }

  return (
    <div className="plan-doc">
      <div className="plan-meta">
        <h2>{plan.week_of || 'Untitled week'}</h2>
        {plan.teacher ? (
          <span className="plan-meta-item">
            <strong>Teacher</strong> {plan.teacher}
          </span>
        ) : null}
        {plan.course ? (
          <span className="plan-meta-item">
            <strong>Course</strong> {plan.course}
          </span>
        ) : null}
        {plan.period ? (
          <span className="plan-meta-item">
            <strong>Period</strong> {plan.period}
          </span>
        ) : null}
      </div>

      <table className="plan-table">
        <caption className="visually-hidden">
          Weekly lesson plan, Monday to Friday, in the Florence City Schools template
        </caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Lesson plan component</span>
            </th>
            {ordered.map((d) => (
              <th scope="col" key={d.name}>
                {d.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {ordered.map((day) => {
                if (day.no_school) {
                  // Only the first content row carries the stamp, matching the builder.
                  return row.key === 'learning_targets' ? (
                    <td key={day.name} className="is-no-school" rowSpan={ROWS.length}>
                      No School
                    </td>
                  ) : null
                }
                if (row.key === null) {
                  return (
                    <td key={day.name}>
                      <LessonCell day={day} />
                    </td>
                  )
                }
                if (row.tags) {
                  const list = Array.isArray(day[row.key]) ? day[row.key] : []
                  return (
                    <td key={day.name}>
                      <div className="strategy-tags">
                        {list.map((s) => (
                          <span className="strategy-tag" key={s}>
                            {s}
                          </span>
                        ))}
                      </div>
                    </td>
                  )
                }
                return (
                  <td key={day.name}>
                    {row.cited ? (
                      <CitedText text={day[row.key]} groundedCodes={groundedCodes} />
                    ) : (
                      day[row.key]
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
          {onReviseDay ? (
            <tr>
              <th scope="row">Revise</th>
              {ordered.map((day) =>
                day.no_school ? (
                  <td key={day.name} />
                ) : (
                  <td key={day.name}>
                    <div className="plan-day-actions">
                      <button
                        type="button"
                        className="btn-icon"
                        disabled={busy}
                        aria-label={`Revise ${day.name}`}
                        aria-expanded={openDay === day.name}
                        onClick={() => setOpenDay(openDay === day.name ? null : day.name)}
                      >
                        <Sparkles size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                )
              )}
            </tr>
          ) : null}
        </tbody>
      </table>

      {openDay
        ? (() => {
            const index = ordered.findIndex((d) => d.name === openDay)
            const day = ordered[index]
            return (
              <div className="revise-box">
                <label className="visually-hidden" htmlFor="revise-input">
                  What should change about {openDay}?
                </label>
                <input
                  id="revise-input"
                  className="input"
                  autoFocus
                  placeholder={`Change ${openDay} — e.g. make the Do Now a group activity`}
                  value={drafts[openDay] || ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [openDay]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit(index, day)
                    if (e.key === 'Escape') setOpenDay(null)
                  }}
                />
                <button
                  type="button"
                  className="btn-send"
                  disabled={busy || !(drafts[openDay] || '').trim()}
                  onClick={() => submit(index, day)}
                  aria-label={`Rewrite ${openDay}`}
                >
                  <ArrowUp size={15} strokeWidth={2.5} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  onClick={() => setOpenDay(null)}
                  aria-label="Cancel revision"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
            )
          })()
        : null}
    </div>
  )
}
