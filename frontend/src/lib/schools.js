/* The one name for "this teacher hasn't told us where they teach."
 *
 * `generic` is deliberately NOT a row in the `schools` table — it's the
 * dateless fallback a teacher lands on when their school isn't listed yet
 * (backend/schoolcal.py's NO_CALENDAR_SCHOOL_ID, and WelcomePage's own
 * comment on it). users.school DEFAULTs to it (db.py migration ~34), so
 * every brand-new account already holds it before anyone has been asked
 * anything.
 *
 * That combination is a trap, and it cost the onboarding wizard its school
 * step: code that asks "does this account have a school?" with a bare
 * truthiness check gets `true` for an account that has never chosen one,
 * while a lookup into `schools` for the same value gets `undefined`. Both
 * halves read as "nothing to do here" and the step silently disappears.
 *
 * Hence hasChosenSchool(): one predicate, in one place, that both callers
 * can share instead of each re-deriving the rule and getting it wrong.
 */
export const GENERIC_SCHOOL = 'generic'

/** True only when the teacher has actually picked a real school.
 *  `generic` is a placeholder, not an answer — see above. */
export function hasChosenSchool(school) {
  return Boolean(school) && school !== GENERIC_SCHOOL
}
