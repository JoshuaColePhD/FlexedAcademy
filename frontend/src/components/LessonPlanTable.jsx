import { useEffect, useState } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../lib/toastContext'
import { useLayoutMode } from '../hooks/useMediaQuery'
import { LESSON_PARTS, ROWS, dayState, orderedDays } from '../lib/planShape'
import { CitedText } from './Citation'
import { PlanDayCards } from './PlanDayCards'
import { SkeletonText } from './Skeleton'
import { cellKit } from './CellTweak'

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

/* ── in-cell revision ──────────────────────────────────────────────────────
   What this replaces: a "Revise" row of Sparkles buttons under the table plus
   one shared .revise-box below it. That worked, but every revision it could
   express was scoped to a WHOLE DAY — so "shorten the Do Now" regenerated
   Wednesday's standards and engagement tags too, and quietly re-decided the
   grounding audit the app exists to guarantee.

   Clicking the cell instead scopes the revision to a day AND a field, which is
   the contract backend/service.py's merge-one-key path now honours. This is a
   relocation of an existing feature, not a new one; the submit handler and the
   guards are the same. */

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
  onReviseDays,
  onPickStandard,
  onPlanRevised,
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
  // 'day' | 'week' — which days a tweak's instruction targets. Lives beside
  // draft for the same reason: one open cell, one in-flight choice, reset
  // together whenever a different cell opens.
  const [scope, setScope] = useState('day')
  // null = not sent yet; true/false = which thumb was actually clicked, not
  // just "sent" — disabling both buttons on a plain boolean left no visible
  // trace of which one you'd picked, only a toast that had already faded.
  const [feedbackSent, setFeedbackSent] = useState(null)
  const [revisingWholePlan, setRevisingWholePlan] = useState(false)
  // code -> full standard record (description, source, verbatim_ok), for the
  // Standards/ACT Alignment picker below — CitedText only ever needed the
  // codes themselves (groundedCodes), not what they say, so this is new.
  // Refetched whenever the retrieved set actually changes (a revision can
  // widen it), not on every render.
  const [standardsByCode, setStandardsByCode] = useState({})
  const mode = useLayoutMode()
  const toast = useToast()

  useEffect(() => {
    const codes = [...(groundedCodes || [])]
    if (!codes.length) {
      setStandardsByCode({})
      return
    }
    let cancelled = false
    const controller = new AbortController()
    api
      .getStandardsBatch(codes, { subject, signal: controller.signal })
      .then((byCode) => {
        if (!cancelled) setStandardsByCode(byCode || {})
      })
      .catch(() => {
        // Best-effort: the picker just falls back to bare codes with no
        // description if this fails, same as CitedText already does for an
        // unresolved code. Not worth a toast — nothing the teacher did failed.
      })
    return () => {
      cancelled = true
      controller.abort()
    }
    // groundedCodes is a fresh Set every render (ArtifactPanel builds it
    // inline) — join() gives this effect a stable string to depend on
    // instead of re-fetching every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [[...(groundedCodes || [])].sort().join(','), subject])

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

  const handleReviseWholePlan = async () => {
    if (!planId || revisingWholePlan) return
    setRevisingWholePlan(true)
    try {
      const row = await api.revisePlan(planId)
      // The endpoint returns the updated row. Handing it upward is what replaces
      // `alert('...please refresh the page')` — asking a teacher to reload as
      // part of a normal, successful action is not a loading state, it's a bug
      // with a dialog in front of it.
      onPlanRevised?.(row)
      toast.success('Revised', 'The week has been rewritten and the .docx rebuilt.')
    } catch (e) {
      toast.apiError("Couldn't revise the plan", e)
    } finally {
      setRevisingWholePlan(false)
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
  const canTweak = Boolean(onReviseDay)

  const openCell = (dayIndex, field) => {
    if (!canTweak) return
    setDraft('')
    setScope('day')
    setOpenTweak({ dayIndex, field })
  }

  const closeCell = () => {
    setDraft('')
    setScope('day')
    setOpenTweak(null)
  }

  /** The picker's own apply: an exact code, not typed feedback — see
   *  ChatPage's pickStandard for why this is a sibling of applyTweak
   *  rather than a call to it. */
  const pickStandard = (dayIndex, field, code) => {
    onPickStandard?.(dayIndex, ordered[dayIndex], field, code)
    closeCell()
  }

  // Every day actually taught this week — no_school/pending/incomplete days
  // have nothing in this field to rewrite, so "All N days" only ever targets
  // days that are really there, and N in its own label matches what happens.
  const weekDayIndices = ordered.reduce(
    (acc, d, i) => (dayState(d) === 'ok' ? [...acc, i] : acc),
    []
  )

  const applyTweak = () => {
    const feedback = draft.trim()
    if (!feedback || !openTweak) return
    const { dayIndex, field } = openTweak
    if (scope === 'week' && onReviseDays && weekDayIndices.length > 1) {
      onReviseDays(weekDayIndices, feedback, field)
    } else {
      onReviseDay(dayIndex, ordered[dayIndex], feedback, field)
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
              className="btn"
              disabled={revisingWholePlan || busy}
              onClick={handleReviseWholePlan}
            >
              {revisingWholePlan ? 'Revising…' : 'AI review & revise'}
            </button>
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
            applyTweak={applyTweak}
            pickStandard={onPickStandard ? pickStandard : null}
            standardsByCode={standardsByCode}
            draft={draft}
            setDraft={setDraft}
            scope={scope}
            setScope={setScope}
            weekDayCount={weekDayIndices.length}
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
            applyTweak={applyTweak}
            pickStandard={onPickStandard ? pickStandard : null}
            standardsByCode={standardsByCode}
            draft={draft}
            setDraft={setDraft}
            scope={scope}
            setScope={setScope}
            weekDayCount={weekDayIndices.length}
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
  pickStandard,
  standardsByCode,
  draft,
  setDraft,
  scope,
  setScope,
  weekDayCount,
}) {
  const { isOpen, flashed, editableProps, Trigger, tweakBody } = cellKit({
    busy,
    flashCells,
    canTweak,
    openTweak,
    openCell,
    closeCell,
    applyTweak,
    pickStandard,
    standardsByCode,
    draft,
    setDraft,
    scope,
    setScope,
    weekDayCount,
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
          {canTweak ? '. Click any cell to revise just that part of that day.' : ''}
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
                        {LESSON_PARTS.map(([label, key]) =>
                          isOpen(dayIndex, key) ? (
                            <div key={key}>{tweakBody(dayIndex, key, day[key])}</div>
                          ) : day[key] ? (
                            <div
                              className={`plan-lesson-part${
                                canTweak ? ' is-editable' : ''
                              }${flashed(dayIndex, key) ? ' fa-flash' : ''}`}
                              key={key}
                              onClick={canTweak ? () => openCell(dayIndex, key) : undefined}
                            >
                              <b>{label}:</b>
                              {day[key]}
                              <Trigger dayIndex={dayIndex} field={key} dayName={day.name} />
                            </div>
                          ) : null
                        )}
                      </td>
                    )
                  }

                  if (isOpen(dayIndex, row.key)) {
                    const current = row.tags
                      ? (Array.isArray(day[row.key]) ? day[row.key] : []).join(', ')
                      : day[row.key]
                    return (
                      <td key={day.name} className="is-tweaking">
                        {tweakBody(dayIndex, row.key, current)}
                      </td>
                    )
                  }

                  if (row.tags) {
                    const list = Array.isArray(day[row.key]) ? day[row.key] : []
                    return (
                      <td key={day.name} {...editableProps(dayIndex, row.key)}>
                        <div className="strategy-tags">
                          {list.map((s) => (
                            <span className="strategy-tag" key={s}>
                              {s}
                            </span>
                          ))}
                        </div>
                        <Trigger dayIndex={dayIndex} field={row.key} dayName={day.name} />
                      </td>
                    )
                  }

                  return (
                    <td key={day.name} {...editableProps(dayIndex, row.key)}>
                      {row.cited ? (
                        <CitedText text={day[row.key]} groundedCodes={groundedCodes} subject={subject} />
                      ) : (
                        day[row.key]
                      )}
                      <Trigger dayIndex={dayIndex} field={row.key} dayName={day.name} />
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

