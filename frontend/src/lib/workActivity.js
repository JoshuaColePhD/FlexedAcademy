export const DEFAULT_WORK_STEPS = [
  { key: 'context', label: 'Reading this week' },
  { key: 'standards', label: 'Matching standards' },
  { key: 'days', label: 'Building the days' },
]

export const WORK_ACTIVITY_MESSAGES = {
  plan: 'Lining up the week now.',
  revision: 'Tweaking that part now.',
  quiz: 'Writing the quiz now.',
  research: 'Poking through the sources now.',
}

const STEP_ORDER = ['context', 'standards', 'days']
const STEP_ALIASES = {
  context: 'context',
  retrieval: 'standards',
  standards: 'standards',
  planning: 'standards',
  building: 'days',
  days: 'days',
  validation: 'days',
  saving: 'days',
}
const STEP_LABELS = Object.fromEntries(DEFAULT_WORK_STEPS.map((step) => [step.key, step.label]))

function resolveStep(step) {
  return STEP_ALIASES[step] || null
}

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
  const mapped = resolveStep(event.step) || (
    {
      accepted: 'context',
      preparing_context: 'context',
      retrieving: 'standards',
      research_ready: 'standards',
      context_ready: 'standards',
      thinking: 'standards',
      tool_call: 'standards',
      writing: 'days',
      building: 'days',
      validation: 'days',
      saving: 'days',
      complete: 'days',
    }[status]
  ) || activity.activeStep

  const step = resolveStep(mapped) || mapped
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
    next.error = event.error || next.error || event.label || 'The request could not be completed.'
    next.steps = normalizedSteps(next).map((item) => (
      item.key === next.activeStep ? { ...item, state: 'error' } : item
    ))
  } else if (status === 'cancelled') {
    next.status = 'cancelled'
  } else if (event.done === true || event.finish === true) {
    // Chat conversation streams also emit status "complete" when the model
    // has finished talking — including the turn that only *decided* to
    // generate a week. That is not the plan being saved. Only an explicit
    // done/finish flag (lesson stream onDone, quiz/revision finish) means
    // the artifact exists.
    next.status = 'complete'
    next.steps = normalizedSteps(next).map((item) => ({ ...item, state: 'complete' }))
  }

  return next
}

export function workActivityStepLabel(step) {
  return STEP_LABELS[resolveStep(step) || step] || 'Working…'
}
