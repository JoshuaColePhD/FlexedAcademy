export const DEFAULT_WORK_STEPS = [
  { key: 'context', label: 'Preparing class context' },
  { key: 'retrieval', label: 'Retrieving grounded standards' },
  { key: 'planning', label: 'Choosing the next action' },
  { key: 'building', label: 'Building the lesson plan' },
  { key: 'validation', label: 'Checking citations and template' },
  { key: 'saving', label: 'Saving your work' },
]

export const WORK_ACTIVITY_MESSAGES = {
  plan: 'Working through the five-day sequence now.',
  revision: 'Tightening up that lesson-plan update now.',
  quiz: 'Cooking up the quiz now.',
  research: 'Digging through the sources now.',
}

const STEP_ORDER = ['context', 'retrieval', 'planning', 'building', 'validation', 'saving']
const STEP_LABELS = Object.fromEntries(DEFAULT_WORK_STEPS.map((step) => [step.key, step.label]))

function normalizedSteps(activity) {
  const supplied = Array.isArray(activity?.steps) ? activity.steps : []
  const byKey = new Map(supplied.map((step) => [step.key, step]))
  return DEFAULT_WORK_STEPS.map((step) => ({ ...step, ...byKey.get(step.key) }))
}

export function createWorkActivity({ requestId, anchorId, kind = 'plan', title = 'Working on your request' }) {
  return {
    requestId,
    anchorId,
    kind,
    title,
    status: 'active',
    activeStep: 'context',
    steps: DEFAULT_WORK_STEPS.map((step, index) => ({ ...step, state: index === 0 ? 'active' : 'pending' })),
    details: [],
    artifactType: kind === 'quiz' ? 'quiz' : kind === 'research' ? 'research' : 'lesson_plan',
  }
}

export function updateWorkActivity(activity, event = {}) {
  if (!activity) return activity
  const next = { ...activity }
  const status = event.status || event.code || ''
  const step = event.step || (
    {
      accepted: 'context',
      preparing_context: 'context',
      retrieving: 'retrieval',
      research_ready: 'retrieval',
      context_ready: 'planning',
      thinking: 'planning',
      tool_call: 'planning',
      writing: 'building',
      building: 'building',
      validation: 'validation',
      saving: 'saving',
      complete: 'saving',
    }[status]
  ) || activity.activeStep

  if (step && STEP_ORDER.includes(step)) {
    const currentIndex = STEP_ORDER.indexOf(step)
    next.steps = normalizedSteps(activity).map((item, index) => ({
      ...item,
      state: index < currentIndex ? 'complete' : index === currentIndex ? 'active' : 'pending',
    }))
    next.activeStep = step
  }

  if (event.label) next.currentLabel = event.label
  if (event.detail) next.details = [...(activity.details || []).slice(-3), event.detail]
  if (event.artifact_type) next.artifactType = event.artifact_type
  if (event.tool) next.tool = event.tool
  if (event.attempt != null) next.attempt = event.attempt
  if (event.research_sources) next.researchSources = event.research_sources
  if (event.dayNames) next.dayNames = event.dayNames
  if (event.previewDays) next.previewDays = event.previewDays

  if (status === 'error' || event.error) {
    next.status = 'error'
    next.error = event.error || event.label || 'The request could not be completed.'
    next.steps = normalizedSteps(next).map((item) => (
      item.key === next.activeStep ? { ...item, state: 'error' } : item
    ))
  } else if (status === 'cancelled') {
    next.status = 'cancelled'
  } else if (status === 'complete' || event.done) {
    next.status = 'complete'
    next.steps = normalizedSteps(next).map((item) => ({ ...item, state: 'complete' }))
  }

  return next
}

export function workActivityStepLabel(step) {
  return STEP_LABELS[step] || 'Working…'
}
