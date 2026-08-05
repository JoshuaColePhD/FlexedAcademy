/* Grouping and search for /api/frameworks.
 *
 * The endpoint returns 72 frameworks. They were rendered as one flat <select>,
 * which is unusable for the audience this app is now for: a colleague opening it
 * for the first time has to scroll past "AP Biology Big Ideas" and
 * "AP US History Themes 2014-2015" to find "Mathematics (2019)", and the list
 * contains near-duplicates that are genuinely hard to tell apart —
 * "AP Language & Composition" (476 standards) sits nowhere near
 * "AP English Language and Composition" (37), and picking the wrong one gives
 * you a framework with almost nothing in it.
 *
 * So: two groups in the order a Florence teacher needs them, search across
 * label and id, and the standard count shown on every row so the thin
 * fragments are visible as thin rather than hidden. Nothing is filtered out —
 * a framework that is ingested stays selectable.
 */

export const GROUP_STATE = 'Alabama Course of Study'
export const GROUP_AP = 'AP & Pre-AP courses'
export const GROUP_OTHER = 'Other frameworks'

/* The state frameworks all carry an adoption year in their label —
 * "Science (2023)", "Mathematics (2019)". That is ALSDE's own convention and a
 * more reliable signal than an id allowlist, which would silently drop a
 * framework the next ingest adds. */
const YEAR_IN_LABEL = /\((?:\d{4})(?:-\d{2,4})?\)/

function group(fw) {
  if (YEAR_IN_LABEL.test(fw.label || '')) return GROUP_STATE
  if (/^(AP|Pre-?\s?AP|Advanced)\b/i.test(fw.id) || /^AP\b/i.test(fw.label)) return GROUP_AP
  return GROUP_OTHER
}

const GROUP_ORDER = [GROUP_STATE, GROUP_AP, GROUP_OTHER]

/** Groups frameworks for display. Within a group, the ones carrying the most
 *  standards come first — a teacher scanning for their subject wants the real
 *  framework above the 19-chunk fragment that shares its name. */
export function groupFrameworks(frameworks = []) {
  const buckets = new Map(GROUP_ORDER.map((g) => [g, []]))
  for (const fw of frameworks) buckets.get(group(fw)).push(fw)
  return GROUP_ORDER.map((name) => ({
    name,
    items: buckets.get(name).sort((a, b) => (b.chunks || 0) - (a.chunks || 0)),
  })).filter((g) => g.items.length > 0)
}

/** Case- and separator-insensitive substring match, so "world lang",
 *  "World_Languages" and "worldlanguages" all find the same row. */
export function matchesFramework(fw, query) {
  const q = query.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!q) return true
  const hay = `${fw.label || ''} ${fw.id || ''}`.toLowerCase().replace(/[\s_-]+/g, '')
  return hay.includes(q)
}

export function findFramework(frameworks, id) {
  return (frameworks || []).find((f) => f.id === id) || null
}

/** How much of a framework was verified word-for-word against the source PDF.
 *  Surfaced because it is not uniform — ELA is 100%, Physical Education is 61%
 *  — and a teacher choosing a framework should be able to see that before they
 *  trust a plan built on it. */
export function verifiedPct(fw) {
  if (!fw?.chunks) return null
  return Math.round(((fw.verbatim_ok || 0) / fw.chunks) * 100)
}
