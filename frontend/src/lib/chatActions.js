// Explicit typed actions take precedence; older voice events retain their route.
export function planOperation(result, activePlanId, { voice = false } = {}) {
  if (!result?.toolCalled) return null
  const action = result.planAction
  if (!action) {
    if (voice) return { action: activePlanId ? 'revise_week' : 'create' }
    throw new Error('The plan action was incomplete. Please try again.')
  }
  if (!['create', 'revise_week', 'revise_days'].includes(action.action)) {
    throw new Error('The plan action was not recognized. Please try again.')
  }
  if (action.action !== 'create') {
    // The model often copies a stale target_plan_id from earlier in the
    // chat. A confirmation like "yes" still means the open week — bind to
    // that instead of failing because the id drifted mid-turn.
    if (!activePlanId) {
      throw new Error('The active plan changed. Open the intended plan and try again.')
    }
    if (action.target_plan_id !== activePlanId) {
      return { ...action, target_plan_id: activePlanId }
    }
  }
  return action
}

/** Whole-day REST rewrites often hit the browser timeout. Stream a patch instead. */
export function shouldStreamPlanRevision(action) {
  if (!action) return false
  if (action.action === 'revise_week') return true
  return action.action === 'revise_days' && !action.field
}

export function revisionDayIndices(plan, names) {
  return names.map((name) => {
    const index = plan.days.findIndex((day) => day.name === name)
    if (index < 0) throw new Error(`The active plan has no ${name}.`)
    return index
  })
}

/** Prefer the model's target, then the quiz the teacher is looking at. */
export function quizRevisionId(requested, viewingQuiz) {
  if (!requested?.revisesCurrent) return null
  return requested.targetQuizId || viewingQuiz?.id || null
}

// Include card questions in subsequent turns as well as after a reload, when
// persistence has already flattened them into the assistant's text.
export function chatMessageText(message) {
  const text = message.content || message.planLabel || message.weekLabel || ''
  const questions = (message.questions || []).map((question) =>
    `${question.text}${question.options?.length ? ` (${question.options.join(' / ')})` : ''}`)
  return [text, ...questions].filter(Boolean).join('\n')
}

// Optional follow-ups cost no model round trip and never mutate on display.
// Each choice is an ordinary teacher request, handled by the same chat policy.
export function completionSuggestions(kind, artifact) {
  if (kind === 'quiz') return [{
    id: 'optional_quiz_followup',
    text: `Optional next step for ${artifact?.title || 'this quiz'}`,
    options: ['Review whether these questions measure the learning goal.', 'Suggest how to reteach based on students’ answers.'],
  }]
  return [{
    id: 'optional_plan_followup',
    text: 'Optional next step for this lesson plan',
    options: ['Review the pacing and flag anything unrealistic.', 'Suggest scaffolding for students who need more support.'],
  }]
}

// Versioned metadata in the existing message text envelope keeps old clients
// compatible; workflow state never depends on the visible completion wording.
export function quizReceipt(quiz, content) {
  return `<!--flexed:quiz:${JSON.stringify({ id: quiz.id, planId: quiz.plan_id || null })}-->\n${content}`
}

export function readQuizReceipt(content) {
  const text = String(content || '')
  const match = text.match(/^<!--flexed:quiz:(\{[^\n]*\})-->\n?/)
  if (!match) return { content: text, quiz: null }
  try {
    const quiz = JSON.parse(match[1])
    if (typeof quiz.id !== 'string' || !/^[\w-]{1,64}$/.test(quiz.id)
      || (quiz.planId != null && (typeof quiz.planId !== 'string' || !/^[\w-]{1,64}$/.test(quiz.planId)))) return { content: text, quiz: null }
    return { content: text.slice(match[0].length), quiz }
  } catch {
    return { content: text, quiz: null }
  }
}
