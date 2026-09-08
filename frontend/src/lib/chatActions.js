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
  if (action.action !== 'create' && (!activePlanId || action.target_plan_id !== activePlanId)) {
    throw new Error('The active plan changed. Open the intended plan and try again.')
  }
  return action
}

export function revisionDayIndices(plan, names) {
  return names.map((name) => {
    const index = plan.days.findIndex((day) => day.name === name)
    if (index < 0) throw new Error(`The active plan has no ${name}.`)
    return index
  })
}

// Include card questions in subsequent turns as well as after a reload, when
// persistence has already flattened them into the assistant's text.
export function chatMessageText(message) {
  const text = message.content || message.planLabel || message.weekLabel || ''
  const questions = (message.questions || []).map((question) =>
    `${question.text}${question.options?.length ? ` (${question.options.join(' / ')})` : ''}`)
  return [text, ...questions].filter(Boolean).join('\n')
}
