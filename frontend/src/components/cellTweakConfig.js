export const CHIPS = {
  learning_targets: ['Shorter', 'Lower the DOK', 'Make the verb measurable'],
  standards: ['Use a different standard', 'Add a second code'],
  act_alignment: ['Use a different ACT code', 'Leave it empty'],
  engagement_strategy: ['Something more active', 'Try a different strategy'],
  do_now: ['Shorter', 'More rigorous', 'Make it a quickwrite'],
  during: ['Shorter', 'More rigorous', 'Add a group activity'],
  assessment: ['Shorter', 'More rigorous', 'Make it written'],
}

export const cellKey = (dayIndex, field) => `${dayIndex}:${field}`

export const CODE_FIELDS = new Set(['standards', 'act_alignment'])
