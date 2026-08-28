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

export const GROUP_ENGLISH = 'English / Language Arts'
export const GROUP_MATH = 'Mathematics'
export const GROUP_SCIENCE = 'Science'
export const GROUP_HISTORY = 'History / Social Studies'
export const GROUP_WORLD_LANG = 'World Languages'
export const GROUP_ARTS = 'Arts'
export const GROUP_PE_HEALTH = 'PE & Health'
export const GROUP_CS = 'Computer Science'
export const GROUP_SPECIAL_ED = 'Special Education'
export const GROUP_OTHER = 'Other'

const GROUP_ORDER = [
  GROUP_ENGLISH,
  GROUP_MATH,
  GROUP_SCIENCE,
  GROUP_HISTORY,
  GROUP_WORLD_LANG,
  GROUP_ARTS,
  GROUP_PE_HEALTH,
  GROUP_CS,
  GROUP_SPECIAL_ED,
  GROUP_OTHER
]

function group(fw) {
  const text = `${fw.id} ${fw.label}`.toLowerCase()
  
  if (/(world language|spanish|french|german|latin|chinese|japanese|italian)/.test(text)) return GROUP_WORLD_LANG
  if (/(english|lang\b|ela\b|literature|composition|reading|writing|literacy)/.test(text)) return GROUP_ENGLISH
  if (/(math|calculus|algebra|geometry|statistics|precalculus)/.test(text)) return GROUP_MATH
  if (/(science|biology|chemistry|physics|environmental)/.test(text) && !/(computer|political)/.test(text)) return GROUP_SCIENCE
  if (/(history|social studies|government|geography|economics|psychology|macroeconomics|microeconomics)/.test(text)) return GROUP_HISTORY
  if (/(art\b|arts\b|music|theater|drama|drawing|2-d|3-d)/.test(text) && !/(language arts|liberal arts)/.test(text)) return GROUP_ARTS
  if (/(physical education|health|pe\b)/.test(text)) return GROUP_PE_HEALTH
  if (/(computer|digital|programming)/.test(text)) return GROUP_CS
  if (/(special education|collaborative)/.test(text)) return GROUP_SPECIAL_ED
  
  return GROUP_OTHER
}

/** Groups frameworks for display. Within a group, they are sorted alphabetically 
 *  so teachers can easily scroll and find their specific course. (The old chunk-based 
 *  sorting is no longer needed since the database is clean of fragments). */
export function groupFrameworks(frameworks = []) {
  const buckets = new Map(GROUP_ORDER.map((g) => [g, []]))
  for (const fw of frameworks) buckets.get(group(fw)).push(fw)
  return GROUP_ORDER.map((name) => ({
    name,
    items: buckets.get(name).sort((a, b) => (a.label || '').localeCompare(b.label || '')),
  })).filter((g) => g.items.length > 0)
}

/** Grade-band words a teacher actually thinks in, mapped to the numeric
 *  grades they cover (see grades.js — K is 0). Same reasoning as the numeric
 *  case below: "elementary" is never IN a framework's label (a state's
 *  "English Language Arts (2021)" spans K-12 in one framework and never
 *  spells out a level), even though its `grades` list is exactly how a
 *  teacher who teaches "elementary" would recognize it. Keys are checked as
 *  prefixes so partial typing ("elemen") matches before the whole word is
 *  in. */
const LEVEL_BANDS = [
  { keys: ['kindergarten', 'kinder'], grades: [0] },
  { keys: ['elementary', 'elem'], grades: [0, 1, 2, 3, 4, 5] },
  { keys: ['middle'], grades: [6, 7, 8] },
  { keys: ['high'], grades: [9, 10, 11, 12] },
]

function matchesLevelBand(word, fw) {
  if (word.length < 3) return false
  const band = LEVEL_BANDS.find((b) => b.keys.some((k) => k.startsWith(word) || word.startsWith(k)))
  return !!band && band.grades.some((g) => fw.grades?.includes(g))
}

/** Case- and separator-insensitive, and matched word by word rather than as
 *  one glued-together string — "world lang", "World_Languages" and
 *  "worldlanguages" all still find the same row (every word has to appear
 *  *somewhere* in the label/id, not necessarily touching), but so does
 *  "english 11", which the old single-substring version couldn't: a
 *  teacher's own grade number is rarely IN a framework's name (Alabama's
 *  "English Language Arts (2021)" covers K-12 in one framework and never
 *  spells out "11" anywhere in its label), even though 11 is right there in
 *  its own `grades` list. A purely-numeric word matches against `grades`
 *  too for exactly that reason, so a teacher searching by the grade they
 *  actually teach finds the general framework that covers it, not just the
 *  AP courses whose names happen to contain "English".
 *
 *  "school" is dropped as a bare word — it only ever shows up glued to a
 *  level band ("elementary school", "middle school") and never means
 *  anything on its own, so requiring it to also appear in the label would
 *  just make the level-band match above pointless. */
export function matchesFramework(fw, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).filter((w) => w !== 'school')
  if (!words.length) return true
  const hay = `${fw.label || ''} ${fw.id || ''}`.toLowerCase().replace(/[\s_-]+/g, '')
  return words.every((word) => {
    const normalized = word.replace(/[\s_-]+/g, '')
    if (/^\d+$/.test(normalized) && fw.grades?.includes(Number(normalized))) return true
    if (matchesLevelBand(normalized, fw)) return true
    return hay.includes(normalized)
  })
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
