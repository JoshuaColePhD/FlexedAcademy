/* The grade list, once.
 *
 * There were three copies — WelcomePage's own GRADES, OnboardingWizard's
 * (whose comment noted the duplication and kept it anyway), and ClassPage's
 * numeric-only third variant. They agreed on the values, which is exactly
 * what made the one place they DIDN'T agree so expensive: WelcomePage sent
 * the LABEL ("11th") where every reader expects the VALUE ("11"), and the
 * copies gave that bug three separate places to hide.
 *
 * '0' is Kindergarten, matching the corpus's own convention
 * (grade_from_level() in scripts/01d_ingest_alcos_case.py) and the backend's
 * _auto_name, which special-cases 0 to "K" rather than printing "0th".
 */
export const GRADES = [
  { value: '0', label: 'K' },
  { value: '1', label: '1st' },
  { value: '2', label: '2nd' },
  { value: '3', label: '3rd' },
  { value: '4', label: '4th' },
  { value: '5', label: '5th' },
  { value: '6', label: '6th' },
  { value: '7', label: '7th' },
  { value: '8', label: '8th' },
  { value: '9', label: '9th' },
  { value: '10', label: '10th' },
  { value: '11', label: '11th' },
  { value: '12', label: '12th' },
]

export const DEFAULT_GRADE = '11'

/** "11th" -> "11", 11 -> "11", anything unrecognised -> null.
 *
 *  The mirror of db.normalize_grade (backend/db.py, migration 38). A <select>
 *  whose `value` matches no <option> does not render empty — it silently
 *  displays its FIRST option, so a class stored as "11th" showed up in the
 *  onboarding wizard and in ClassPage's edit panel as Kindergarten. Returning
 *  null for "no idea" lets each caller pick its own fallback rather than
 *  guessing a grade on the teacher's behalf.
 */
export function normalizeGrade(grade) {
  if (grade === 0) return '0'
  if (!grade && grade !== '0') return null
  const raw = String(grade).trim()
  const m = /^(\d{1,2})(?:st|nd|rd|th)?$/i.exec(raw)
  if (m) {
    const v = String(Number(m[1]))
    return GRADES.some((g) => g.value === v) ? v : null
  }
  if (/^k$/i.test(raw)) return '0'
  return null
}

/** What a <select> should show for a stored grade — never an option that
 *  isn't there, and never a silent fall-through to Kindergarten. */
export function gradeSelectValue(grade, fallback = DEFAULT_GRADE) {
  return normalizeGrade(grade) ?? fallback
}

/** "11" -> "11th", "0" -> "K", nothing recognisable -> ''. Used where a grade
 *  is being READ rather than picked, so an unset grade reads as absent rather
 *  than as some default the teacher never chose. */
export function gradeLabel(grade) {
  const v = normalizeGrade(grade)
  return GRADES.find((g) => g.value === v)?.label ?? ''
}
