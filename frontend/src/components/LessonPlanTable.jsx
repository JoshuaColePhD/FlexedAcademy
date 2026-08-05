import { useState } from 'react'
import { ArrowUp, Sparkles, X, ThumbsUp, ThumbsDown } from 'lucide-react'
import { CitedText } from './Citation'
import { SkeletonText } from './Skeleton'

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

/* What to render for a weekday the plan has no entry for. Three states, not two,
   and the distinction matters more than it looks:

     'no_school'  — a real, correct, final answer. There is no class that day.
     'pending'    — the model hasn't written it yet. Provisional; about to change.
     'incomplete' — generation stopped before it arrived. A gap to act on.

   A boolean `streaming` prop is NOT sufficient. isStreaming flips false in
   useLessonStream's `finally` the instant Stop is pressed, while plan.days is
   still partial — so a boolean would flip un-arrived days straight to "No School"
   one second later, which is the same misreport with better timing. */
export function LessonPlanTable({
  plan,
  groundedCodes,
  onReviseDay,
  busy,
  missingDays = 'no_school',
}) {
  const [openDay, setOpenDay] = useState(null)
  const [drafts, setDrafts] = useState({})
  const [feedbackSent, setFeedbackSent] = useState(false)
  const [revisingWholePlan, setRevisingWholePlan] = useState(false)

  const handleFeedback = async (isGood) => {
    if (!plan?.id || feedbackSent) return
    setFeedbackSent(true)
    try {
      await fetch(`/api/plans/${plan.id}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_good: isGood })
      })
    } catch (e) {
      console.error('Failed to submit feedback', e)
    }
  }

  const handleReviseWholePlan = async () => {
    if (!plan?.id || revisingWholePlan) return
    setRevisingWholePlan(true)
    try {
      const res = await fetch(`/api/plans/${plan.id}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      if (!res.ok) throw new Error('Revise failed')
      const updated = await res.json()
      // Note: In a real app we'd trigger a re-fetch of the plan here or bubble up an event.
      // Since this is a self-contained component, we rely on the parent to poll or reload.
      alert('AI Revision complete! Please refresh the page to see the new plan.')
    } catch (e) {
      console.error('Failed to revise whole plan', e)
      alert('Failed to revise the plan.')
    } finally {
      setRevisingWholePlan(false)
    }
  }

  if (!plan?.days?.length) return null

  const byName = new Map(plan.days.map((d) => [d.name, d]))
  const fallback =
    missingDays === 'pending'
      ? { pending: true }
      : missingDays === 'incomplete'
        ? { incomplete: true }
        : { no_school: true }
  const ordered = DAYS.map((name) => byName.get(name) || { name, ...fallback })

  const submit = (index, day) => {
    const feedback = (drafts[day.name] || '').trim()
    if (!feedback) return
    onReviseDay?.(index, day, feedback)
    setOpenDay(null)
    setDrafts((d) => ({ ...d, [day.name]: '' }))
  }

  return (
    <div className="plan-doc">
      <div className="plan-meta" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>{plan.week_of || 'Untitled week'}</h2>
        {plan.id && (
          <div className="plan-feedback" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              className="btn"
              disabled={revisingWholePlan}
              onClick={handleReviseWholePlan}
            >
              {revisingWholePlan ? 'Revising...' : 'AI Review & Revise'}
            </button>
            <button 
              className="btn-icon" 
              disabled={feedbackSent} 
              onClick={() => handleFeedback(true)}
              title="Good plan"
            >
              <ThumbsUp size={16} />
            </button>
            <button 
              className="btn-icon" 
              disabled={feedbackSent} 
              onClick={() => handleFeedback(false)}
              title="Bad plan"
            >
              <ThumbsDown size={16} />
            </button>
          </div>
        )}
      </div>
      <div className="plan-meta">
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

      {/* tabIndex + role + label are not polish: a scroll container that only
          responds to pointer drag is a keyboard-access failure (WCAG 2.1.1). */}
      <div
        className="plan-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Weekly lesson plan — scrolls horizontally on small screens"
      >
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
                if (day.pending) {
                  // Same single-stamp shape as No School, so the column doesn't
                  // shift when the real content replaces it.
                  return row.key === 'learning_targets' ? (
                    <td key={day.name} className="is-pending" rowSpan={ROWS.length}>
                      <SkeletonText lines={3} />
                      <span className="visually-hidden">
                        {day.name} hasn’t been written yet
                      </span>
                    </td>
                  ) : null
                }
                if (day.incomplete) {
                  return row.key === 'learning_targets' ? (
                    <td key={day.name} className="is-incomplete" rowSpan={ROWS.length}>
                      Not generated
                      <span className="visually-hidden">
                        {' '}
                        — generation stopped before {day.name} was written
                      </span>
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
                /* pending/incomplete included: a live "Revise Tuesday" for a day
                   that hasn't arrived would post a day_index the backend can't
                   revise. */
                day.no_school || day.pending || day.incomplete ? (
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
      </div>

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
