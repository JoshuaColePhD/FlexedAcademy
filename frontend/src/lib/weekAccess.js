import { firstUnplanned } from './queue.js'

/** A teaching week whose dates are already behind today. Closed weeks are
 *  never offered, past or not. */
export function isPastTeachingWeek(week) {
  return Boolean(week && week.is_past && !week.no_school)
}

/** A week a brand-new chat may be pinned to: teaching, not already behind. */
export function canPinNewChatToWeek(week) {
  return Boolean(week && !week.no_school && !week.is_past)
}

/** Weeks the header picker can *pin* a new (or still-unbuilt) chat to.
 *  Past weeks stay out — except the week this conversation is already on,
 *  so the selected option does not go blank. */
export function newChatWeekOptions(weeks, conversationWeek) {
  return (weeks || []).filter((week) => (
    !week.no_school && (canPinNewChatToWeek(week) || week.week === conversationWeek)
  ))
}

/** Past teaching weeks that already have a chat, so the picker can reopen
 *  that work instead of starting a new conversation on a finished week. */
export function priorWeeksWithWork(weeks, conversationWeek) {
  return (weeks || []).filter((week) => (
    isPastTeachingWeek(week)
    && week.week !== conversationWeek
    && Boolean(week.chat_id)
  ))
}

/** Resolve what a new chat should pin. An explicit upcoming pick wins;
 *  a past pick (or a missing week) falls back to the next unplanned
 *  teaching week on the calendar. */
export function pinWeekForNewChat(weeks, requestedWeek) {
  const list = weeks || []
  const requested = list.find((week) => week.week === requestedWeek)
  if (canPinNewChatToWeek(requested)) return requestedWeek ?? null
  return firstUnplanned(list)?.week ?? null
}

export function existingChatForWeek(week) {
  return week?.chat_id || null
}
