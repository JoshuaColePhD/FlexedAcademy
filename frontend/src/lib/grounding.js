import { findCodes, groundedSet, normalizeCode } from './codes'
import { ROWS, orderedDays } from './planShape'

/* What the plan cites, and where.
 *
 * With the document closed by default, the chat message has to carry the proof
 * — five days, which codes were retrieved, and which one wasn't. That is what
 * this computes. It also answers the question the marginalia note needs to be
 * actionable: WHICH CELL cites the bad code, so clicking the warning can open
 * the tweak on the cell that caused it rather than just restating the problem.
 */

/* Only two fields in the plan shape carry a standard code. Read from ROWS
 * rather than restated, so adding a cited row to the document adds it here. */
const CITED_FIELDS = ROWS.filter((r) => r.cited && r.key).map((r) => r.key)

/**
 * @returns {{
 *   grounded: string[],
 *   ungrounded: Array<{code: string, dayIndex: number, dayName: string, field: string}>,
 *   checking: boolean,
 * }}
 *
 * `checking` is false when no grounding information came back at all (a plan
 * loaded from storage, say). Every code is then reported as grounded rather
 * than every code being branded as invented — that is the only safe direction
 * for this particular error to fail in.
 */
export function scanGrounding(plan, retrievedCodes) {
  const known = groundedSet(retrievedCodes)
  const checking = known.size > 0
  const days = orderedDays(plan, 'no_school')

  const grounded = []
  const groundedSeen = new Set()
  const ungrounded = []
  const ungroundedSeen = new Set()

  days.forEach((day, dayIndex) => {
    if (day.no_school || day.pending || day.incomplete) return
    for (const field of CITED_FIELDS) {
      for (const code of findCodes(day[field])) {
        const key = normalizeCode(code)
        if (!checking || known.has(key)) {
          if (!groundedSeen.has(key)) {
            groundedSeen.add(key)
            grounded.push(code)
          }
        } else if (!ungroundedSeen.has(key)) {
          ungroundedSeen.add(key)
          // First citing cell wins — it is where the fix belongs.
          ungrounded.push({ code, dayIndex, dayName: day.name, field })
        }
      }
    }
  })

  return { grounded, ungrounded, checking }
}

/** Where a given code is cited, so a marginalia warning can open that cell. */
export function locateCode(plan, retrievedCodes, code) {
  const key = normalizeCode(code)
  const { ungrounded } = scanGrounding(plan, retrievedCodes)
  return ungrounded.find((u) => normalizeCode(u.code) === key) || null
}
