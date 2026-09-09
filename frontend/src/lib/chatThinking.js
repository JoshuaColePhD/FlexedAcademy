/* Status copy while a chat reply is on the way. This is a colleague pausing,
 * not a progress bar and not a five-day generate. Stable for a given prompt
 * so the line does not flicker mid-wait. */

const CASUAL = ['Hey — one sec', 'Right with you', 'Give me a beat']
const PLANNING = ['Lining up the week', 'Sketching the days', 'Putting the week on paper']
const RESEARCH = ['Poking through sources', 'Checking what we have']
const SUB_PLAN = ['Drafting it for a sub', 'Writing it so a sub can run it']
const DEFAULT = ['Let me sit with that', 'Hmm, okay', 'One sec', 'Thinking it through']

export function isCasualTurn(prompt) {
  const text = String(prompt || '').trim()
  if (!text) return false
  return /^(hi+|hello|hey there|hey|yo|sup|good (morning|afternoon|evening)|thanks|thank you|thx|ok|okay|cool)[\s!?.]*$/i.test(text)
}

function pick(seed, options) {
  const source = String(seed || '')
  let hash = 0
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0
  }
  return options[hash % options.length]
}

export function chatThinkingLabel(mode, { planning, prompt } = {}) {
  if (isCasualTurn(prompt)) return pick(prompt, CASUAL)
  if (planning) return pick(prompt, PLANNING)
  if (mode === 'research') return pick(prompt, RESEARCH)
  if (mode === 'sub_plan') return pick(prompt, SUB_PLAN)
  return pick(prompt || mode, DEFAULT)
}
