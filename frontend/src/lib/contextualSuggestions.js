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

const planningLanguage = /\b(?:lesson|plan|planning|teach|teaching|week|unit|chapter|novel|text|standard|students?|assessment|class|rhetoric|essay|reading|activity)\b/i

function lastTeacherPrompt(messages) {
  return [...(messages || [])].reverse().find((message) => message?.role === 'user' && String(message.content || '').trim())
}

function topicFromPrompt(content) {
  const clean = String(content || '')
    .replace(/---[^\n]+---/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return ''

  // Prefer the phrase the teacher supplied after a natural topic marker. It
  // makes the completion feel like a continuation of their own sentence,
  // rather than a new generic prompt pasted into the box.
  const marked = clean.match(/\b(?:about|on|around|focused on|using|through)\s+(.+?)(?:[.!?]|$)/i)?.[1]
  const topic = (marked || clean)
    .replace(/^(?:help me|can you|please|i need|make|create|build|generate|design|prepare|let's|lets)\s+/i, '')
    // A previously accepted ghost completion can come back through the
    // message history as the latest user turn. Strip its conversational
    // wrapper before extracting the subject, or the next completion becomes
    // "Let's keep building the keep building the …".
    .replace(/^(?:keep|continue)\s+building(?:\s+(?:the|this))?\s+/i, '')
    .replace(/^(?:revise|review|finish)\s+(?:the\s+)?(?:plan|lesson plan)(?:\s+(?:for|about|on))?\s*/i, '')
    .replace(/^(?:a|an|the)\s+(?:lesson\s+)?plan\s+(?:for|on|about)\s+/i, '')
    .replace(/\b(?:for|in)\s+week\s+\d+\b/gi, '')
    .replace(/[.!?]+$/, '')
    .trim()

  // Question-card copy is context, not a stable subject to repeat in the
  // next prompt. Falling back to the generic lesson-plan continuation keeps
  // the completion useful without echoing a long or truncated question.
  if (/^(?:which|what|how|why|when|where)\b/i.test(topic)) return ''
  return topic.length > 72 ? `${topic.slice(0, 69).trimEnd()}…` : topic
}

function followUpSuggestion(messages, artifact, targetWeek, activeClass, classCount) {
  const previous = lastTeacherPrompt(messages)
  const content = previous?.content || ''
  if (!previous || !planningLanguage.test(content)) return null
  const topic = topicFromPrompt(content)
  const week = targetWeek ? weekLabel(targetWeek) : 'this week'
  const focus = topic ? `the ${topic}` : 'this lesson plan'
  const revisionFocus = topic ? `${focus} plan` : focus
  return makeSuggestion({
    id: `follow-up:${previous.id || content}`,
    label: artifact ? 'Revise this direction' : 'Keep building this plan',
    prompt: artifact
      ? `Let's revise ${revisionFocus}.`
      : `Let's keep building ${focus}.`,
    reason: `Continues from your last message about ${week}.`,
    priority: 1,
    context: 'conversation-follow-up',
    action: 'send-prompt',
    contextLabel: weekContextLabel(targetWeek, activeClass, classCount),
  })
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

  // Once the teacher has sent something, the next Tab completion should feel
  // like the next line in this conversation. It is intentionally
  // deterministic and local: the composer never waits for an LLM request just
  // to decide what ghost text belongs under the teacher's last message.
  const followUp = followUpSuggestion(messages, artifact, targetWeek, activeClass, classCount)
  if (followUp) suggestions.push(followUp)

  // These two only ever reach the screen via the Greeting's own empty-state
  // hint (ChatPage's emptyStateHint) — the composer has no sentence to type
  // or send for "go upload a file," so once there are messages it filters
  // any 'open-settings' suggestion straight out. Emitting one anyway used to
  // burn the single MAX_SUGGESTIONS=1 slot on a suggestion nothing could
  // display, leaving the composer with nothing at all — not even the next,
  // real suggestion (review-current-plan, continue-draft, ...) waiting
  // behind it at a lower priority.
  if (!messages.length && calendar && calendar.has_calendar === false && weeks.length === 0) {
    suggestions.push(makeSuggestion({
      id: 'add-school-calendar',
      label: 'Add school calendar',
      prompt: 'Help me add my school calendar.',
      reason: 'Nothing else can be scheduled until FlexedAcademy knows your teaching weeks.',
      priority: 1,
      context: 'setup',
      action: 'open-settings',
    }))
  }

  if (!messages.length && hasPacingGuide === false) {
    suggestions.push(makeSuggestion({
      id: 'add-pacing-guide',
      label: 'Add a pacing guide',
      prompt: `Help me add my pacing guide${className}.`,
      reason: 'Plans default to generic pacing without one.',
      priority: 1,
      context: 'setup',
      action: 'open-settings',
    }))
  }

  if (targetWeek && isOpenTeachingWeek(targetWeek) && !hasPlan(targetWeek)) {
    const label = weekLabel(targetWeek)
    const partial = Boolean(targetWeek.closures && targetWeek.notes)
    suggestions.push(makeSuggestion({
      id: 'plan-current-week',
      label: `Plan ${label}`,
      prompt: `Help me plan ${label}${className}.`,
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
      prompt: `I want to revise the plan for ${label}.`,
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
        ? `Let's finish the plan for ${weekLabel(targetWeek)}.`
        : 'Let\'s pick up where we left off.',
      reason: age ? `Last touched ${age}.` : 'This conversation is still open with no plan finished yet.',
      priority: 3,
      context: 'recent-chat',
      action: 'open-chat',
      chatId: activeChat?.id,
      weekNumber: targetWeek ? weekNumber(targetWeek) : null,
      contextLabel: weekContextLabel(targetWeek, activeClass, classCount),
    }))
  }

  const nextDecision = decisions.find((decision) => decision.value == null)
  if (nextDecision && !artifact) {
    const openCount = decisions.filter((decision) => decision.value == null).length
    const wk = targetWeek ? weekLabel(targetWeek) : 'this week'
    // Straight apostrophes throughout — matching every other prompt in this
    // file (and what a teacher's own keyboard actually produces by
    // default), so suggestionCompletion's prefix match isn't left to depend
    // on which of these templates happened to get picked.
    const prompts = {
      week: targetWeek ? `Let's plan ${weekLabel(targetWeek)}.` : "Let's decide which week to plan.",
      anchor: `Let's choose the anchor text or topic for ${wk}.`,
      skill: `Let's choose the skill focus for ${wk}.`,
      assessment: `Let's choose an assessment for ${wk}.`,
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
      weekNumber: targetWeek ? weekNumber(targetWeek) : null,
      contextLabel: weekContextLabel(targetWeek, activeClass, classCount),
    }))
  }

  if (artifact) {
    const wk = targetWeek ? weekLabel(targetWeek) : null
    suggestions.push(makeSuggestion({
      id: 'review-current-plan',
      label: wk ? `Review ${wk}’s plan` : 'Review this plan',
      prompt: `Let's review ${wk ? `${wk}'s` : 'this'} plan.`,
      reason: 'Built and ready for a second pass.',
      priority: 5,
      context: 'plan',
      action: 'review-plan',
      chatId: activeChat?.id,
      weekNumber: targetWeek ? weekNumber(targetWeek) : null,
      contextLabel: weekContextLabel(targetWeek, activeClass, classCount),
    }))
  }

  if (nextUnplanned && (!targetWeek || hasPlan(targetWeek) || artifact)) {
    const label = weekLabel(nextUnplanned)
    suggestions.push(makeSuggestion({
      id: 'prepare-next-week',
      label: `Prepare ${label}`,
      prompt: `Let's start planning ${label}.`,
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
      prompt: 'Help me plan what to teach next.',
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

// Quote style is inconsistent across the suggestion templates above (compare
// line 157's straight "Let's" to line 174's curly "Let's") — not something a
// teacher typing their own straight-quote apostrophe (what every keyboard
// and most autocorrect produce by default) should have to match by luck.
// Also covers the ONE suggestion whose `prompt` isn't a template at all —
// ChatPage.jsx's groundableSuggestion swaps in an LLM-written `prompt`
// (llm.py's generate_week_suggestion) with no punctuation-style constraint
// at all, and this codebase's own prompt-writing style leans on em dashes
// constantly (backend/prompts.py alone uses one 47 times) — exactly the
// kind of house style a model primed by nearby examples tends to pick up,
// and exactly what a teacher's own keyboard would never produce typing
// toward it. 1:1 character substitution only, never collapsing/removing
// anything (an ellipsis "…" → "..." would NOT be 1:1 and is deliberately
// left alone) — suggestionCompletion slices the ORIGINAL prompt at
// `prefix.length`, which only stays a valid offset if normalizing can't
// change string length.
const normalizeQuotes = (s) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[—–]/g, '-')

/** Return only the part of a suggestion that remains after a typed prefix.
 *  Matching is on a normalized (lowercase, straight-quoted) form so a minor
 *  typographic difference — curly vs straight apostrophe, most commonly —
 *  doesn't make an otherwise-correct continuation look like a mismatch and
 *  silently drop the ghost text a teacher is plainly still typing toward. */
export function suggestionCompletion(value = '', suggestion) {
  if (!suggestion?.prompt) return ''
  const prefix = String(value)
  if (!prefix) return suggestion.prompt
  const normalizedPrompt = normalizeQuotes(suggestion.prompt).toLocaleLowerCase()
  const normalizedPrefix = normalizeQuotes(prefix).toLocaleLowerCase()
  if (!normalizedPrompt.startsWith(normalizedPrefix)) return ''
  return suggestion.prompt.slice(prefix.length)
}

export { MAX_SUGGESTIONS }
