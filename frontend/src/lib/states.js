/* The state value is stored as the two-letter postal code on each class. Keep
 * the label here so onboarding, class editing, and future standards catalogs
 * can share one vocabulary instead of each inventing its own select options. */
export const US_STATES = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
]

/* Which states the standards catalog can actually ground a plan in.
 *
 * Lived in OnboardingWizard.jsx, which made it wizard logic; it is state
 * vocabulary, and it belongs next to US_STATES so every consumer reads one
 * list and one predicate instead of re-deriving the rule. Add a code here when
 * its standards are ingested and the UI enables it automatically, in the same
 * alphabetical list.
 *
 * The full K-12 Alabama corpus is what's loaded today (backend/retrieval.py's
 * load_chunks reads five data/processed/*chunks.json files, ~33k records), and
 * GET /api/frameworks derives its course list FROM those chunks — so a course
 * is only ever offered when it is genuinely grounded. That is the argument for
 * gating honestly rather than hiding the gate: a Georgia teacher can still use
 * the calendar, the district format, and the planning itself. Only the
 * standards library is Alabama's for now.
 */
export const INGESTED_STANDARDS_STATES = new Set(['AL'])

/** True when this state's standards are ingested and can ground a plan. */
export function isStandardsReady(code) {
  return INGESTED_STANDARDS_STATES.has(code)
}
