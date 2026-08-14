/* Mirrors backend/schema.py's QUESTION_TYPES. One copy, not the three
 * (ArtifactRail, ArtifactDetailPanel, and now ChatPage's own build
 * acknowledgment) that were about to each maintain their own — the first
 * two had already drifted slightly ("True/false" vs "True / False").
 */
export const QUESTION_TYPE_LABELS = {
  multiple_choice: 'Multiple choice',
  true_false: 'True/false',
  short_answer: 'Short answer',
  matching: 'Matching',
}

/** "Multiple choice, True/false" — the rail's own sub-line and the detail
 *  panel's header both want exactly this, title-cased. */
export function questionTypesLabel(types = []) {
  return types.map((t) => QUESTION_TYPE_LABELS[t] || t).join(', ')
}

/** "multiple choice and true/false" — a natural-sentence join for the one
 *  caller (ChatPage's quiz-build acknowledgment) writing prose instead of a
 *  label: lowercased first word, "and" instead of a bare comma before the
 *  last item. */
export function questionTypesProse(types = []) {
  const labels = types.map((t) => (QUESTION_TYPE_LABELS[t] || t).toLowerCase())
  if (labels.length <= 1) return labels[0] || 'mixed'
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}
