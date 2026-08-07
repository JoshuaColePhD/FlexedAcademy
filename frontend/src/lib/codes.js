/* Standard-code recognition, in one place.
 *
 * This regex used to live inside Citation.jsx, which was fine while the only
 * question anyone asked was "turn this string into citations". Three surfaces
 * now ask a second question — how many codes are in this plan, which ones were
 * never retrieved, and which cell cites the bad one — and a second copy of this
 * pattern is exactly how the screen and the backend audit would drift.
 *
 * Mirrors backend/retrieval.py's _CODE_RE, which the grounding audit uses. The
 * two should be changed together.
 */

/* The `[A-Z]{2,5}\d{2}(\.…)+` alternative matches the Alabama CASE codes as
   ALSDE publishes them — ELA21.11.R2, MA19.GDA.5, SS24.US2.4, SC23.CHEM.1e,
   CSC26.9-12.CD.3. Without it, every standard from the eleven Course of Study
   frameworks rendered as plain text: no citation, no popover, and no ungrounded
   mark — so the grounding apparatus was silently inert for every subject except
   AP Lang. */
const SOURCE =
  '(' +
  [
    '\\d\\.[A-C]', // AP Lang skill, e.g. 2.A
    'Grade\\d{1,2}-\\d{1,2}[a-c]?', // legacy ALCOS parse, e.g. Grade11-22a
    '[A-Z]{2,5}\\d{2}(?:\\.[A-Za-z0-9-]+){1,4}', // Alabama CASE, e.g. ELA21.11.R2
    'R\\d{1,2}', // ACT recurring, e.g. R4
    '(?:TOD|ORG|KLA|SST|USG|PUN|CLR|IKI)\\s?\\d{3}', // ACT English/Writing
  ].join('|') +
  ')'

/** A FRESH regex each time. A shared /g regex carries lastIndex between calls,
 *  so one matchAll would silently change what the next split returned. */
export const codeRe = () => new RegExp(SOURCE, 'g')

export function normalizeCode(code) {
  return String(code).replace(/\s+/g, ' ').trim().toUpperCase()
}

/** Every standard code in a string, in order, deduped. */
export function findCodes(text) {
  if (!text) return []
  const seen = new Set()
  const out = []
  for (const m of String(text).matchAll(codeRe())) {
    const key = normalizeCode(m[1])
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m[1])
  }
  return out
}

/** The retrieved set, normalized, as a Set — accepts an Array or a Set. */
export function groundedSet(codes) {
  return new Set([...(codes instanceof Set ? codes : codes || [])].map(normalizeCode))
}
