/* The four things every plan-building conversation has to settle, regardless
 * of what the finished week ends up looking like — independent of
 * schema.py's DAY_JSON_SCHEMA, which varies day to day and isn't what this
 * tracks. backend/llm.py's extract_decisions has no fixed schema either (see
 * its own docstring) — it freely writes a 1-3 word label per decision it
 * finds — so these are matched against whatever it returns by a loose
 * keyword test, not an exact key. Anything settled that doesn't match one of
 * the four still shows as its own card in DecisionStack: a real decision the
 * model surfaced that isn't one of the regulars (a constraint, a rubric
 * detail), not something dropped for not fitting the mold.
 *
 * Lives here, not inlined in DecisionStack.jsx, so VoiceModePanel's own "N of
 * 4 decided" progress badge can read the exact same split instead of
 * re-implementing (and risking drifting from) this matching — and so
 * exporting it doesn't trip DecisionStack.jsx's own "only export components"
 * fast-refresh lint rule.
 */
const CORE_CHECKLIST = [
  { key: 'week', label: 'Week', match: /week/i },
  { key: 'anchor', label: 'Anchor text', match: /anchor|text/i },
  { key: 'skill', label: 'Skill focus', match: /skill|focus/i },
  { key: 'assessment', label: 'Assessment', match: /assess/i },
]

export function splitDecisions(decisions) {
  const usedIdx = new Set()
  const checklist = CORE_CHECKLIST.map((slot) => {
    const idx = decisions.findIndex((d, i) => !usedIdx.has(i) && slot.match.test(d.label))
    if (idx >= 0) usedIdx.add(idx)
    const found = idx >= 0 ? decisions[idx] : null
    return { key: slot.key, label: slot.label, value: found?.value ?? null }
  })
  const extra = decisions
    .map((d, i) => ({ key: `extra:${i}`, label: d.label, value: d.value }))
    .filter((_, i) => !usedIdx.has(i))
  return { checklist, extra }
}
