/* Fixed Tab-completions for the chat composer. These are not contextual:
 * they never interpolate week numbers, day names, plan titles, or the last
 * teacher message. The overlay shows one at a time (empty field → first;
 * a typed prefix that matches another → that one). */
export const COMPOSER_GHOST_PROMPTS = [
  'Write a lesson for this week',
  "Revise this week's plan",
]

export const COMPOSER_GHOST_SUGGESTIONS = COMPOSER_GHOST_PROMPTS.map((prompt, index) => ({
  id: index === 0 ? 'boilerplate-write-week' : 'boilerplate-revise-week',
  label: prompt,
  prompt,
  reason: '',
  priority: index + 1,
  context: 'boilerplate',
  action: 'send-prompt',
}))

export function pickComposerGhost(value = '') {
  const query = String(value).trim().toLocaleLowerCase()
  if (!query) return COMPOSER_GHOST_SUGGESTIONS[0] || null
  return COMPOSER_GHOST_SUGGESTIONS.find((item) => (
    item.prompt.toLocaleLowerCase().startsWith(query)
  )) || null
}
