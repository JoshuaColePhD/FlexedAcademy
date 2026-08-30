import { Check, Loader2 } from 'lucide-react'
import { DAYS, SHORT_DAY, dayTitle } from '../lib/planShape'

/* Generation status stays above the composer as one compact line. It explains
 * the current day as it advances without opening a tall card or moving the
 * transcript out from under the teacher's cursor. */
export function LessonPlanProgressTray({ days, dayNames = DAYS, onStop }) {
  const byName = new Map((days || []).map((day) => [day.name, day]))
  const axis = dayNames?.length ? dayNames : DAYS
  const writtenCount = axis.filter((name) => byName.has(name)).length
  const nextName = axis.find((name) => !byName.has(name))
  const complete = writtenCount === axis.length
  const status = complete ? 'Formatting and saving…' : nextName ? `Writing ${nextName}…` : 'Getting your week ready…'
  const countLabel = `${writtenCount} of ${axis.length} days`

  return (
    <div className="lesson-plan-progress-tray" aria-label="Lesson plan generation progress" aria-busy="true">
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}. {countLabel} complete.
      </p>
      <div className="lesson-plan-progress-line">
        <span className="lesson-plan-progress-line-icon" aria-hidden="true">
          {complete ? <Check size={14} /> : <Loader2 size={14} className="animate-spin" />}
        </span>
        <span className="lesson-plan-progress-line-label">Building your lesson plan</span>
        <span className="lesson-plan-progress-line-status" aria-hidden="true">{status}</span>
        <span className="lesson-plan-progress-days" aria-hidden="true">
          {axis.map((name) => {
            const day = byName.get(name)
            const isWriting = !day && name === nextName && !complete
            const state = day ? 'complete' : isWriting ? 'writing' : 'pending'
            return (
              <span
                key={`${name}-${state}`}
                className={`lesson-plan-progress-day is-${state}`}
                title={day ? `${name}: ${day.no_school ? 'No school' : dayTitle(day) || 'Complete'}` : `${name}: ${isWriting ? 'Writing now' : 'Waiting'}`}
              >
                {state === 'complete' ? <Check size={11} /> : state === 'writing' ? <Loader2 size={11} className="animate-spin" /> : (SHORT_DAY[name] || name).slice(0, 2).toUpperCase()}
              </span>
            )
          })}
        </span>
        <span className="lesson-plan-progress-line-count">{countLabel}</span>
        {onStop ? (
          <button type="button" className="lesson-plan-progress-stop fa-press" onClick={onStop}>
            <span className="lesson-plan-progress-stop-icon" aria-hidden="true"><span /></span>
            Stop
          </button>
        ) : null}
      </div>
    </div>
  )
}
