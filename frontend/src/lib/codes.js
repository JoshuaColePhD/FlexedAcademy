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
/* Kept in the SAME ORDER as backend/retrieval.py's _CODE_RE, alternative for
   alternative, so the two can be diffed by eye.

   They had silently drifted. The frontend was missing four shapes the backend
   already audited, so an AP Lang plan citing RHS-2, CLE-4 and R.TST.701 showed
   ONE citation on screen — the lone `4.B` — and the rail said "1 standard" for
   a week grounded in six. Worse, an ungrounded RHS- code could not be marked,
   because the screen could not see it was a code at all. The backend was right
   the whole time; only the display was blind. */
const SOURCE =
  '(?<![\\w.])(' +
  [
    '[ERMSW]\\.[A-Z]{2,4}\\.\\d{3}', // ACT reporting category, e.g. R.TST.701
    '(?:LO|EK|EU|SP|KC)[\\s.]?\\d+(?:\\.[A-Za-z0-9]+)*', // College Board, e.g. LO.3.A.3.1
    // AP course skill. The trailing [A-Z] is AP Lang's essential-knowledge
    // codes — RHS-1A..RHS-1E, RHS-2A, RHS-2B — which the lookahead below
    // rejected, so `RHS-1` matched and `RHS-1A` did not. Seen in a live plan.
    '[A-Z]{2,4}-\\d+[A-Z]?(?:\\.[A-Za-z0-9]+)*',
    '[A-Z]{2,5}\\d{2}(?:\\.[A-Za-z0-9-]+){1,4}', // Alabama CASE, e.g. ELA21.11.R2
    'Grade\\d{1,2}-\\d{1,2}[a-c]?', // legacy ALCOS parse, e.g. Grade11-22a
    '(?:TOD|ORG|KLA|SST|USG|PUN|CLR|IKI)\\s?\\d{3}', // ACT English/Writing
    'R\\d{1,2}', // ACT recurring, e.g. R4
    '\\d+\\.\\d+(?:\\.[A-Za-z0-9]+)*', // numeric, e.g. 1.2.3
    '\\d\\.[A-C]', // AP Lang skill, e.g. 2.A
  ].join('|') +
  ')(?!\\.?\\w)'

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
