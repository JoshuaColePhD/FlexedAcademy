/* Fast, deterministic suggestions for the places teachers already work.
 * These are deliberately not LLM-generated: the composer must never wait on a
 * network request just to decide what its Tab completion should be. */

const MAX_SUGGESTIONS = 3

const weekNumber = (week) => week?.week ?? week?.week_number ?? null

const weekLabel = (week) => {
  const number = weekNumber(week)
  return number == null ? 'the current week' : `Week ${number}`
}

const hasPlan = (week) => Boolean(week?.has_plan || week?.plan_id || week?.planId || week?.status === 'built')

const isOpenTeachingWeek = (week) => Boolean(week && !week.no_school && !week.closed && !week.is_closed)

const makeSuggestion = (suggestion) => ({
  priority: 99,
  context: 'chat',
  action: 'send-prompt',
  ...suggestion,
})

const hasRecentChat = (activeChat, messages) => {
  if (!activeChat && !messages?.length) return false
  if (messages?.length) return true
  if (!activeChat?.updated_at) return false
  const age = Date.now() - new Date(activeChat.updated_at).getTime()
  return Number.isFinite(age) && age < 14 * 24 * 60 * 60 * 1000
}

export function getContextualSuggestions(context = {}) {
  const {
    activeClass,
    activeChat,
    conversationWeek,
    effectiveWeek,
    calendar,
    messages = [],
    artifact,
    decisions = [],
    pendingQuestions,
    busy = false,
    voiceOpen = false,
    attachments = [],
    hasPacingGuide = true,
  } = context

  if (busy || voiceOpen || pendingQuestions) return []

  const weeks = calendar?.weeks || []
  const currentWeek = weeks.find((week) => week.is_current) || null
  const selectedWeek = weeks.find((week) => weekNumber(week) === conversationWeek) || null
  const targetWeek = selectedWeek || currentWeek || weeks.find((week) => weekNumber(week) === effectiveWeek) || null
  const nextUnplanned = weeks.find((week) => isOpenTeachingWeek(week) && !week.is_past && !hasPlan(week)) || null
  const className = activeClass?.name ? ` for ${activeClass.name}` : ''
  const suggestions = []

  if (calendar && calendar.has_calendar === false && weeks.length === 0) {
    suggestions.push(makeSuggestion({
      id: 'add-school-calendar',
      label: 'Add school calendar',
      prompt: 'Help me add my school calendar so the plan follows the right teaching weeks.',
      reason: 'The calendar is needed to place plans on real teaching weeks.',
      priority: 1,
      context: 'setup',
      action: 'open-settings',
      contextLabel: 'Finish the setup',
    }))
  }

  if (hasPacingGuide === false) {
    suggestions.push(makeSuggestion({
      id: 'add-pacing-guide',
      label: 'Add a pacing guide',
      prompt: 'Help me add the pacing guide for this class.',
      reason: 'A pacing guide gives the plan its sequence, unit names, and skill context.',
      priority: 1,
      context: 'setup',
      action: 'open-settings',
      contextLabel: 'Add the class context',
    }))
  }

  if (targetWeek && isOpenTeachingWeek(targetWeek) && !hasPlan(targetWeek)) {
    const label = weekLabel(targetWeek)
    suggestions.push(makeSuggestion({
      id: 'plan-current-week',
      label: `Plan ${label}`,
      prompt: `Help me plan ${label}${className} using my pacing guide and the skill focus we have discussed.`,
      reason: `${label} is the current unplanned teaching week.`,
      priority: 2,
      context: 'new-chat',
      action: 'open-plan',
      weekNumber: weekNumber(targetWeek),
      contextLabel: `Planning ${label}`,
    }))
  }

  if (hasRecentChat(activeChat, messages) && !artifact) {
    suggestions.push(makeSuggestion({
      id: 'continue-draft',
      label: 'Continue planning',
      prompt: 'Continue where we left off and help me finish this week.',
      reason: 'You were working on this conversation recently.',
      priority: 3,
      context: 'recent-chat',
      action: 'open-chat',
      chatId: activeChat?.id,
      contextLabel: 'Continue where you left off',
    }))
  }

  const nextDecision = decisions.find((decision) => decision.value == null)
  if (nextDecision && !artifact) {
    const prompts = {
      week: targetWeek ? `Let's plan ${weekLabel(targetWeek)}.` : 'Let’s decide which week to plan.',
      anchor: 'Let’s choose the anchor text or topic for this week.',
      skill: 'Let’s choose the skill focus for this week.',
      assessment: 'Let’s choose an assessment for this week.',
    }
    suggestions.push(makeSuggestion({
      id: `resolve-${nextDecision.key}`,
      label: `Choose ${nextDecision.label.toLowerCase()}`,
      prompt: prompts[nextDecision.key] || `Let's settle the ${nextDecision.label.toLowerCase()} for this week.`,
      reason: `${nextDecision.label} is the next open planning decision.`,
      priority: 4,
      context: 'decision',
      action: 'send-prompt',
      contextLabel: `Choosing ${nextDecision.label.toLowerCase()}`,
    }))
  }

  if (artifact) {
    suggestions.push(makeSuggestion({
      id: 'review-current-plan',
      label: 'Review this plan',
      prompt: 'Review this week’s plan and point out anything that needs attention.',
      reason: 'Your current plan is ready to review or revise.',
      priority: 5,
      context: 'plan',
      action: 'review-plan',
      chatId: activeChat?.id,
      contextLabel: 'Reviewing the current plan',
    }))
    suggestions.push(makeSuggestion({
      id: 'create-quiz',
      label: 'Create a quiz',
      prompt: 'Create a multiple-choice quiz from this week’s plan.',
      reason: 'A supporting assessment has not been created for this plan.',
      priority: 6,
      context: 'artifact',
      action: 'send-prompt',
      contextLabel: 'Working from the current plan',
    }))
  }

  if (nextUnplanned && (!targetWeek || hasPlan(targetWeek) || artifact)) {
    suggestions.push(makeSuggestion({
      id: 'prepare-next-week',
      label: `Prepare ${weekLabel(nextUnplanned)}`,
      prompt: `Help me prepare ${weekLabel(nextUnplanned)} using my pacing guide.`,
      reason: `${weekLabel(nextUnplanned)} is the next unplanned teaching week.`,
      priority: 7,
      context: 'upcoming',
      action: 'open-plan',
      weekNumber: weekNumber(nextUnplanned),
      contextLabel: `Preparing ${weekLabel(nextUnplanned)}`,
    }))
  }

  if (attachments.length > 0 && !hasPacingGuide) {
    suggestions.push(makeSuggestion({
      id: 'use-attachment',
      label: 'Use the attached guide',
      prompt: 'Use the attached pacing guide to shape this week’s plan.',
      reason: 'A reference file is ready to add context to the conversation.',
      priority: 7,
      context: 'attachment',
      action: 'send-prompt',
      contextLabel: 'Using the attached context',
    }))
  }

  if (!suggestions.length) {
    suggestions.push(makeSuggestion({
      id: 'start-planning',
      label: 'Start planning',
      prompt: 'Help me think through what to teach next.',
      reason: 'Start with an idea, text, skill, or week and we’ll shape it together.',
      priority: 8,
      context: 'default',
      action: 'send-prompt',
      contextLabel: 'Start with an idea',
    }))
  }

  return suggestions
    .sort((a, b) => a.priority - b.priority)
    .filter((suggestion, index, all) => all.findIndex((item) => item.id === suggestion.id) === index)
    .slice(0, MAX_SUGGESTIONS)
}

export function suggestionContextLabel(suggestions = []) {
  return suggestions[0]?.contextLabel || ''
}

/** Return only the part of a suggestion that remains after a typed prefix. */
export function suggestionCompletion(value = '', suggestion) {
  if (!suggestion?.prompt) return ''
  const prefix = String(value)
  if (!prefix) return suggestion.prompt
  if (!suggestion.prompt.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) return ''
  return suggestion.prompt.slice(prefix.length)
}

export { MAX_SUGGESTIONS }
