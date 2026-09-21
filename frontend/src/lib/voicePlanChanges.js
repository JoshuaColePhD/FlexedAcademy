const fields = ['learning_targets', 'standards', 'act_alignment', 'engagement_strategy', 'do_now', 'during', 'assessment', 'vocabulary', 'reteach_small_groups', 'cross_curricular_connection']
const normalize = (value) => Array.isArray(value) ? value.map(normalize)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value
export const samePlan = (left, right) => JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))

export function describePlanChanges(before, after) {
  const names = []
  const keys = []
  for (const [index, day] of (after?.days || []).entries()) {
    const previous = before?.days?.find((item) => item.name === day.name)
    if (samePlan(previous, day)) continue
    names.push(day.name)
    for (const field of fields) if (!samePlan(previous?.[field], day[field])) keys.push(`${index}:${field}`)
  }
  for (const day of before?.days || []) if (!after?.days?.some((item) => item.name === day.name)) names.push(day.name)
  return { keys, label: names.length === 1 ? `${names[0]} updated` : names.length === 2 ? `${names.join(' and ')} updated` : names.length > 2 ? `${names.length} days updated` : 'Lesson updated' }
}

export function undoVersion(versions, before, after) {
  const [current, previous] = versions || []
  if (!current || !previous || !samePlan(current.plan_json, after) || !samePlan(previous.plan_json, before)) {
    throw new Error('The saved lesson has changed again. Reopen it before undoing this edit.')
  }
  return { revision: previous.revision, expectedRevision: current.revision }
}
