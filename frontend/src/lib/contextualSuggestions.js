/* Fast, deterministic suggestions for the places teachers already work.
 * These are deliberately not LLM-generated: the composer must never wait on a
 * network request just to decide what its Tab completion should be. */
import { shortRange } from './dates.js'

const MAX_SUGGESTIONS = 1

const weekNumber = (week) => week?.week ?? week?.week_number ?? null

const weekLabel = (week) => {
  const number = weekNumber(week)
  return number == null ? 'the current week' : `Week ${number}`
}

const hasPlan = (week) => Boolean(week?.has_plan || week?.plan_id || week?.planId || week?.status === 'built')

const isOpenTeachingWeek = (week) => Boolean(week && !week.no_school && !week.closed && !week.is_closed)

const weekDateRange = (week) => (week ? shortRange(week.start, week.end) : '')

/** Ambient truth for the tray header — which class, which dates — instead of
 *  a paraphrase of the suggestion's own title. Class name is only included
 *  when it actually disambiguates (more than one class, or caller doesn't
 *  say how many there are). */
function weekContextLabel(week, activeClass, classCount) {
  const range = weekDateRange(week)
  const showClass = Boolean(activeClass?.name) && (classCount == null || classCount > 1)
  const classPart = showClass ? activeClass.name : ''
  return classPart && range ? `${classPart} · ${range}` : classPart || range || ''
}

const relativeAge = (ms) => {
  if (!Number.isFinite(ms)) return null
  const days = Math.floor(ms / (24 * 60 * 60 * 1000))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

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
    hasPacingGuide = true,
    classCount,
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
      prompt: 'Help me add my school calendar so plans land on the right teaching weeks.',
      reason: 'Nothing else can be scheduled until FlexedAcademy knows your teaching weeks.',
      priority: 1,
      context: 'setup',
      action: 'open-settings',
    }))
  }

  if (hasPacingGuide === false) {
    suggestions.push(makeSuggestion({
      id: 'add-pacing-guide',
      label: 'Add a pacing guide',
      prompt: `Help me add the pacing guide${className} so plans follow your sequence.`,
      reason: 'Plans default to generic pacing without one.',
      priority: 1,
      context: 'setup',
      action: 'open-settings',
    }))
  }

  if (targetWeek && isOpenTeachingWeek(targetWeek) && !hasPlan(targetWeek)) {
    const label = weekLabel(targetWeek)
    const dateRange = weekDateRange(targetWeek)
    const partial = Boolean(targetWeek.closures && targetWeek.notes)
    suggestions.push(makeSuggestion({
      id: 'plan-current-week',
      label: `Plan ${label}`,
      prompt: `Help me plan ${label}${dateRange ? ` (${dateRange})` : ''}${className}${hasPacingGuide ? ' using my pacing guide and the skill focus we have discussed' : ''}.${partial ? ` Heads up: ${targetWeek.notes}.` : ''}`,
      reason: partial
        ? `A shortened, unplanned week (${targetWeek.notes}).`
        : `${label} is the current unplanned teaching week.`,
      priority: 2,
      context: 'new-chat',
      action: 'open-plan',
      weekNumber: weekNumber(targetWeek),
      contextLabel: weekContextLabel(targetWeek, activeClass, classCount),
    }))
  } else if (targetWeek && isOpenTeachingWeek(targetWeek) && hasPlan(targetWeek) && !artifact) {
    // targetWeek only lands here already-planned when the teacher explicitly
    // picked it (autoWeek/effectiveWeek's own default is always the next
    // UNplanned week — see firstUnplanned in ChatPage). Falling through to
    // the nextUnplanned suggestion below used to answer that deliberate pick
    // with an unrelated future week and no explanation.
    const label = weekLabel(targetWeek)
    suggestions.push(makeSuggestion({
      id: 'revise-planned-week',
      label: `Revise ${label}`,
      prompt: `Help me revise or rebuild the plan for ${label}${className}.`,
      reason: 'Pick up from there, or start over.',
      priority: 2,
      context: 'new-chat',
      action: 'send-prompt',
      weekNumber: weekNumber(targetWeek),
      contextLabel: `Revising ${label}`,
    }))
  }

  if (hasRecentChat(activeChat, messages) && !artifact) {
    const chatAge = activeChat?.updated_at ? Date.now() - new Date(activeChat.updated_at).getTime() : null
    const age = relativeAge(chatAge)
    suggestions.push(makeSuggestion({
      id: 'continue-draft',
      label: targetWeek ? `Continue ${weekLabel(targetWeek)}` : 'Continue planning',
      prompt: targetWeek
        ? `Continue ${weekLabel(targetWeek)} — let's finish the plan.`
        : 'Continue where we left off and help me finish this week.',
      reason: age ? `Last touched ${age}.` : 'This conversation is still open with no plan finished yet.',
      priority: 3,
      context: 'recent-chat',
      action: 'open-chat',
      chatId: activeChat?.id,
      contextLabel: weekContextLabel(targetWeek, activeClass, classCount),
    }))
  }

  const nextDecision = decisions.find((decision) => decision.value == null)
  if (nextDecision && !artifact) {
    const openCount = decisions.filter((decision) => decision.value == null).length
    const wk = targetWeek ? weekLabel(targetWeek) : 'this week'
    const prompts = {
      week: targetWeek ? `Let's plan ${weekLabel(targetWeek)}.` : 'Let’s decide which week to plan.',
      anchor: `Let’s choose the anchor text or topic for ${wk}.`,
      skill: `Let’s choose the skill focus for ${wk}.`,
      assessment: `Let’s choose an assessment for ${wk}.`,
    }
    suggestions.push(makeSuggestion({
      id: `resolve-${nextDecision.key}`,
      label: `Choose ${nextDecision.label.toLowerCase()}`,
      prompt: prompts[nextDecision.key] || `Let's settle the ${nextDecision.label.toLowerCase()} for ${wk}.`,
      reason: openCount > 1
        ? `${openCount} decisions are still open — starting with ${nextDecision.label.toLowerCase()}.`
        : 'The last open decision before this plan is ready.',
      priority: 4,
      context: 'decision',
      action: 'send-prompt',
      contextLabel: weekContextLabel(targetWeek, activeClass, classCount),
    }))
  }

  if (artifact) {
    const wk = targetWeek ? weekLabel(targetWeek) : null
    suggestions.push(makeSuggestion({
      id: 'review-current-plan',
      label: wk ? `Review ${wk}’s plan` : 'Review this plan',
      prompt: `Review ${wk ? `${wk}’s` : 'this week’s'} plan and point out anything that needs attention.`,
      reason: 'Built and ready for a second pass.',
      priority: 5,
      context: 'plan',
      action: 'review-plan',
      chatId: activeChat?.id,
      contextLabel: weekContextLabel(targetWeek, activeClass, classCount),
    }))
  }

  if (nextUnplanned && (!targetWeek || hasPlan(targetWeek) || artifact)) {
    const label = weekLabel(nextUnplanned)
    const dateRange = weekDateRange(nextUnplanned)
    suggestions.push(makeSuggestion({
      id: 'prepare-next-week',
      label: `Prepare ${label}`,
      prompt: `Help me prepare ${label}${dateRange ? ` (${dateRange})` : ''}${className}${hasPacingGuide ? ' using my pacing guide' : ''}.`,
      reason: targetWeek && hasPlan(targetWeek)
        ? 'Skip ahead — nothing’s planned here yet.'
        : 'The next open teaching week on your calendar.',
      priority: 7,
      context: 'upcoming',
      action: 'open-plan',
      weekNumber: weekNumber(nextUnplanned),
      contextLabel: weekContextLabel(nextUnplanned, activeClass, classCount),
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
