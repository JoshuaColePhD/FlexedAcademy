import { useMemo, useState } from 'react'
import { Check, ChevronDown, Circle, Loader2, RotateCcw, Sparkle, Square, TriangleAlert } from 'lucide-react'
import { DEFAULT_WORK_STEPS, WORK_ACTIVITY_MESSAGES, workActivityStepLabel } from '../lib/workActivity'

function StepIcon({ state }) {
  if (state === 'complete') return <Check size={13} aria-hidden="true" />
  if (state === 'active') return <Loader2 size={13} className="animate-spin" aria-hidden="true" />
  if (state === 'error') return <TriangleAlert size={13} aria-hidden="true" />
  return <Circle size={9} aria-hidden="true" />
}

function normalizedSteps(activity) {
  const supplied = Array.isArray(activity?.steps) ? activity.steps : []
  const byKey = new Map(supplied.map((step) => [step.key, step]))
  return DEFAULT_WORK_STEPS.map((step) => ({ ...step, ...byKey.get(step.key) }))
}

export function WorkActivityCard({
  activity,
  onStop,
  onRetry,
  onViewPlan,
  onViewSources,
  onUndo,
  compact = false,
}) {
  const [expanded, setExpanded] = useState(false)
  const steps = useMemo(() => normalizedSteps(activity), [activity])
  if (!activity) return null

  const active = activity.status === 'active'
  const failed = activity.status === 'error'
  const cancelled = activity.status === 'cancelled'
  const complete = activity.status === 'complete'
  const title = complete
    ? activity.kind === 'quiz' ? 'Quiz ready' : activity.kind === 'research' ? 'Research ready' : 'Plan ready'
    : failed ? 'Couldn’t finish this request' : cancelled ? 'Request stopped' : activity.title
  const summary = complete
    ? activity.summary || 'The result was saved and checked.'
    : failed ? activity.error : cancelled ? activity.summary || 'Nothing was saved.' : activity.currentLabel || workActivityStepLabel(activity.activeStep)

  if (compact) {
    const compactSummary = active ? WORK_ACTIVITY_MESSAGES[activity.kind] || 'Working through the update now.' : summary
    return (
      <div className={`work-activity-card is-compact${failed ? ' is-error' : ''}`} aria-busy={active}>
        <span className="work-activity-mark" aria-hidden="true">
          {active ? <Sparkle size={18} className="fa-activity-icon" fill="currentColor" strokeWidth={1.8} /> : <TriangleAlert size={14} />}
        </span>
        <span className="work-activity-compact-copy" role="status" aria-live="polite">{compactSummary}</span>
        {failed && onRetry ? (
          <button type="button" className="work-activity-inline-action fa-press" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <section
      className={`work-activity-card${compact ? ' is-compact' : ''}${complete ? ' is-complete' : ''}${failed ? ' is-error' : ''}${cancelled ? ' is-cancelled' : ''}`}
      aria-label={title}
      aria-busy={active}
    >
      <div className="work-activity-header">
        <span className="work-activity-mark" aria-hidden="true">
          {active ? <Loader2 size={14} className="animate-spin" /> : failed ? <TriangleAlert size={14} /> : <Check size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <strong className="work-activity-title">{title}</strong>
          <span className="work-activity-summary">{summary}</span>
        </div>
        {active && onStop ? (
          <button type="button" className="work-activity-stop fa-press" onClick={onStop} aria-label="Stop this request">
            <Square size={12} fill="currentColor" aria-hidden="true" />
            <span>Stop</span>
          </button>
        ) : null}
        {failed && onRetry ? (
          <button type="button" className="work-activity-action fa-press" onClick={onRetry}>
            <RotateCcw size={13} aria-hidden="true" /> Retry
          </button>
        ) : null}
      </div>

      {active || failed ? (
        <ol className={`work-activity-steps${compact ? ' is-horizontal' : ''}`}>
          {steps.map((step) => (
            <li key={step.key} className={`work-activity-step is-${step.state}`} aria-label={`${step.label}: ${step.state}`}>
              <span className="work-activity-step-icon"><StepIcon state={step.state} /></span>
              <span>{step.label}</span>
              {step.key === activity.activeStep && activity.previewDays?.length ? (
                <span className="work-activity-step-detail">{activity.previewDays.length} days</span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {complete ? (
        <div className="work-activity-actions">
          {onViewPlan ? <button type="button" className="work-activity-action fa-press" onClick={onViewPlan}>View plan</button> : null}
          {onViewSources ? <button type="button" className="work-activity-action fa-press" onClick={onViewSources}>Show sources</button> : null}
          {onUndo ? <button type="button" className="work-activity-action fa-press" onClick={onUndo}>Undo</button> : null}
        </div>
      ) : null}

      {(activity.details?.length || activity.researchSources?.length) ? (
        <>
          <button
            type="button"
            className="work-activity-details-toggle fa-press"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            Details <ChevronDown size={13} className={expanded ? 'rotate-180' : ''} aria-hidden="true" />
          </button>
          {expanded ? (
            <div className="work-activity-details">
              {activity.details?.map((detail, index) => <p key={`${detail}-${index}`}>{detail}</p>)}
              {activity.researchSources?.length ? <p>{activity.researchSources.length} research sources ready.</p> : null}
            </div>
          ) : null}
        </>
      ) : null}

      <p className="visually-hidden" role="status" aria-live="polite">{summary}</p>
    </section>
  )
}
