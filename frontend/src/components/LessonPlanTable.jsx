import { useState } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useLayoutMode } from '../hooks/useMediaQuery'
import { LESSON_PARTS, ROWS, orderedDays } from '../lib/planShape'
import { CitedText } from './Citation'
import { PlanDayCards } from './PlanDayCards'
import { SkeletonText } from './Skeleton'
import { cellKit } from './cellTweakKit'

/* Mirrors template florence-docx-v2 — the table the district actually gets.

   Rows: Learning Targets, Standards, ACT Alignment, Engagement Strategy, Lesson
   (with bold Do Now / During / Assessment sub-blocks). There is no
   Curriculum/Resources row and no "What will learning look like?" row; those
   belong to the retired v1 template still described in the workspace CLAUDE.md.

   A no-school day matches the builder exactly: "No School" centred in the first
   content row, the rest of that column blank and unshaded, and no revise button. */

/* DAYS, ROWS, LESSON_PARTS and the ordered-days fallback logic moved to
   lib/planShape.js so the table and the phone card deck read from one source.
   Duplicating the three-state no_school/pending/incomplete reasoning into a
   second view is exactly how the two would drift. */

/* ── in-cell editing ───────────────────────────────────────────────────────
   Cells are for quick, exact human edits. AI revisions stay in the global
   composer, where the teacher can see the whole plan and conversation. */

/* The plan document, in whichever form the screen can carry.
 *
 * Keeps its name and its props so nothing upstream changes: it is a router now.
 * Desktop gets the district table. Anything narrower gets the day-card deck,
 * with a toggle back to the real table — because the app's whole promise is that
 * the screen and the .docx agree, and a teacher must always be able to check
 * that, even sideways. */
export function LessonPlanTable({
  plan,
  planId,
  subject,
  groundedCodes,
  onReviseDay,
  onEditDay,
  busy,
  missingDays = 'no_school',
  /* 'days' | 'print'. The panel owns this now — see ArtifactPanel, which
     picks Days on a phone and Print everywhere else, with no control left
     to switch between them. */
  view = 'print',
  flashCells,
  openTweak,
  setOpenTweak,
}) {
  const [draft, setDraft] = useState('')
  // null = not sent yet; true/false = which thumb was actually clicked, not
  // just "sent" — disabling both buttons on a plain boolean left no visible
  // trace of which one you'd picked, only a toast that had already faded.
  const [feedbackSent, setFeedbackSent] = useState(null)
  const mode = useLayoutMode()
  const toast = useToast()

  /* Both of these used to be bare fetch() calls gated on `plan.id`. `plan` is
     plan_json, which has no id — the DB id arrives as `planId` — so the toolbar
     below was gated on undefined and never rendered. Fixing the gate is what
     makes the feature exist at all; routing through lib/api.js is what makes it
     send the session cookie, surface a {code,message,hint} error, and reach the
     global 401 handler. */
  const handleFeedback = async (isGood) => {
    if (!planId || feedbackSent !== null) return
    setFeedbackSent(isGood)
    try {
      await api.planFeedback(planId, isGood)
      toast.success(isGood ? 'Thanks — noted.' : 'Thanks. That helps tune the prompt.')
    } catch (e) {
      setFeedbackSent(null)
      toast.apiError("Couldn't send that", e)
    }
  }

  if (!plan?.days?.length) return null

  const ordered = orderedDays(plan, missingDays)

  /* Used to be desktop/tablet-only — decision 5 read "a phone is for reading
     the week and downloading it, not for asking an LLM to rewrite it." That
     drew the line at the wrong layer: a teacher fixing one word from her
     phone between classes shouldn't have to find a laptop for it. The DAYS
     deck (below) now carries the same tap-to-tweak affordance the table
     already had from 768px up — see PlanDayCards' own Field component. */
  const canTweak = Boolean(onEditDay || onReviseDay)

  const openCell = (dayIndex, field) => {
    if (!canTweak) return
    const current = ordered[dayIndex]?.[field]
    setDraft(Array.isArray(current) ? current.join('\n') : String(current || ''))
    setOpenTweak({ dayIndex, field })
  }

  const closeCell = () => {
    setDraft('')
    setOpenTweak(null)
  }

  const applyEdit = (nextContent = draft) => {
    const content = nextContent.trim()
    if (!content || !openTweak) return
    const { dayIndex, field } = openTweak
    if (onEditDay) {
      onEditDay(dayIndex, ordered[dayIndex], field, content)
    } else {
      onReviseDay?.(dayIndex, ordered[dayIndex], content, field)
    }
    closeCell()
  }

  return (
    <div className="plan-doc">
      <div className="plan-head">
        <h2>{plan.week_of || 'Untitled week'}</h2>
        {planId && mode !== 'phone' ? (
          <div className="plan-feedback">
            <button
              type="button"
              className={`btn-icon${feedbackSent === true ? ' is-good' : ''}`}
              disabled={feedbackSent !== null}
              onClick={() => handleFeedback(true)}
              aria-label="This plan is good"
              title="This plan is good"
            >
              <ThumbsUp size={16} className={feedbackSent === true ? 'fa-pop' : ''} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`btn-icon${feedbackSent === false ? ' is-bad' : ''}`}
              disabled={feedbackSent !== null}
              onClick={() => handleFeedback(false)}
              aria-label="This plan needs work"
              title="This plan needs work"
            >
              <ThumbsDown size={16} className={feedbackSent === false ? 'fa-pop' : ''} aria-hidden="true" />
            </button>
          </div>
        ) : null}
      </div>
      {/* The stamped header: Teacher / Course / Period above a district-blue
          rule, matching the .docx's own header. It is the moment a teacher
          recognises the thing they hand in — so it stays on every screen, and
          on a phone it is the only place that information appears. */}
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

      {/* TWO ways to read one week, picked by width alone now (see
          ArtifactPanel), not by a control a teacher had to choose from.

          DAYS  — one card per day. The phone shape: the district table has
                  a min-width no phone screen clears, and a teacher on one
                  reads a day at a time anyway.
          PRINT — the district table itself, 5x6 at 860px, the exact shape of
                  the .docx. The app's promise: a teacher must always be able
                  to hold the screen against the printed page. */}
      {/* key={view}, not just the conditional: guarantees a fresh mount (and
          so a replayed fa-rise) on every switch regardless of how React
          might otherwise choose to reconcile two different component types
          at the same position — this was a hard content swap with no
          transition before. */}
      <div key={view} className="fa-rise">
        {view === 'days' ? (
          <PlanDayCards
            plan={plan}
            subject={subject}
            groundedCodes={groundedCodes}
            missingDays={missingDays}
            busy={busy}
            flashCells={flashCells}
            canTweak={canTweak}
            openTweak={canTweak ? openTweak : null}
            openCell={openCell}
            closeCell={closeCell}
            applyTweak={applyEdit}
            draft={draft}
            setDraft={setDraft}
          />
        ) : (
          <PlanTable
            ordered={ordered}
            groundedCodes={groundedCodes}
            subject={subject}
            busy={busy}
            flashCells={flashCells}
            canTweak={canTweak}
            openTweak={canTweak ? openTweak : null}
            openCell={openCell}
            closeCell={closeCell}
            applyTweak={applyEdit}
            draft={draft}
            setDraft={setDraft}
          />
        )}
      </div>
    </div>
  )
}

/* The district table itself. It mirrors the .docx and its faithfulness is the
   product, so the only thing in-cell editing is allowed to change is what
   happens when you click — never the columns, the rows or the colours. */
function PlanTable({
  ordered,
  groundedCodes,
  subject,
  busy,
  flashCells,
  canTweak,
  openTweak,
  openCell,
  closeCell,
  applyTweak,
  draft,
  setDraft,
}) {
  const { isOpen, flashed, editableProps, tweakBody } = cellKit({
    busy,
    flashCells,
    canTweak,
    openTweak,
    openCell,
    closeCell,
    applyTweak,
    draft,
    setDraft,
  })

  return (
    /* tabIndex + role + label are not polish: a scroll container that only
       responds to pointer drag is a keyboard-access failure (WCAG 2.1.1). */
    <div
      className="plan-table-scroll"
      tabIndex={0}
      role="region"
      aria-label="Weekly lesson plan — scrolls horizontally on small screens"
    >
      <table className="plan-table">
        <caption className="visually-hidden">
          Weekly lesson plan, Monday to Friday, in the Florence City Schools template
          {canTweak ? '. Click any cell to edit that part of the day.' : ''}
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
          {ROWS.map((row) => {
            /* The row label goes accent-bordered too when a cell in this row is
               being tweaked — the two halves of the frame in the design. */
            const rowTweaking =
              openTweak &&
              (row.key === null
                ? LESSON_PARTS.some(([, key]) => key === openTweak.field)
                : row.key === openTweak.field)

            return (
              <tr key={row.label}>
                <th scope="row" className={rowTweaking ? 'is-tweaking' : undefined}>
                  {row.label}
                </th>
                {ordered.map((day, dayIndex) => {
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
                        <SkeletonText lines={3} static />
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

                  /* The Lesson cell holds three separately-revisable parts. Each
                     one is its own click target and its own field, so tweaking
                     the Do Now does not put the During through a model. */
                  if (row.key === null) {
                    const openPart = LESSON_PARTS.find(([, key]) => isOpen(dayIndex, key))
                    return (
                      <td key={day.name} className={openPart ? 'is-tweaking' : undefined}>
                        {LESSON_PARTS.map(([label, key]) => {
                          if (!day[key]) return null
                          const editing = isOpen(dayIndex, key)
                          return (
                            <div
                              className={`plan-lesson-part${
                                canTweak && !editing ? ' is-editable' : ''
                              }${flashed(dayIndex, key) ? ' fa-flash' : ''}${editing ? ' is-selected' : ''}`}
                              key={key}
                              onClick={canTweak && !editing ? () => openCell(dayIndex, key) : undefined}
                              onKeyDown={canTweak && !editing ? (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  openCell(dayIndex, key)
                                }
                              } : undefined}
                              tabIndex={canTweak && !editing ? 0 : undefined}
                              role={canTweak && !editing ? 'button' : undefined}
                              aria-label={canTweak && !editing ? `Edit ${day.name} ${label}` : undefined}
                            >
                              <b>{label}:</b>
                              {editing ? tweakBody(dayIndex, key, day.name) : day[key]}
                            </div>
                          )
                        })}
                      </td>
                    )
                  }

                  if (row.tags) {
                    const list = Array.isArray(day[row.key])
                      ? day[row.key]
                      : day[row.key]
                        ? [day[row.key]]
                        : []
                    const cellProps = editableProps(dayIndex, row.key)
                    const editing = isOpen(dayIndex, row.key)
                    return (
                      <td
                        key={day.name}
                        {...(editing ? {} : cellProps)}
                        className={`${editing ? 'is-selected' : cellProps.className || ''}`}
                      >
                        {editing ? tweakBody(dayIndex, row.key, day.name) : (
                          <div className="strategy-tags">
                            {list.slice(0, 2).map((s) => (
                              <span className="strategy-tag" key={s}>
                                {s}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    )
                  }

                  const cellProps = editableProps(dayIndex, row.key)
                  const editing = isOpen(dayIndex, row.key)
                  return (
                    <td
                      key={day.name}
                      {...(editing ? {} : cellProps)}
                      className={`${editing ? 'is-selected' : cellProps.className || ''}`}
                    >
                      {editing ? tweakBody(dayIndex, row.key, day.name) : row.cited ? (
                        <CitedText text={day[row.key]} groundedCodes={groundedCodes} subject={subject} />
                      ) : (
                        day[row.key]
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
