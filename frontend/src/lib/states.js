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
 * This used to be a hardcoded Set here, updated by hand as each state's
 * ingest went live. That drifts the moment ingestion outpaces a code
 * change — GA/TN/MS/FL standards can be sitting in Supabase, verified and
 * ready, while the frontend still says "not ready yet" because nobody
 * remembered to edit this file. GET /api/standards/active-states now reads
 * the real ingest manifest (public.standards_frameworks) instead, so this
 * export is only the fallback for the moment before that fetch resolves
 * (or if it fails) — it should stay whatever's true today without anyone
 * having to touch it again for a state going live from here on.
 */
export const INGESTED_STANDARDS_STATES = new Set(['AL'])

/** True when this state's standards are ingested and can ground a plan.
 *  Pass the live Set from GET /api/standards/active-states as `activeStates`
 *  once it's loaded; omitted (or still loading), this falls back to the
 *  static list above rather than saying every state is ready. */
export function isStandardsReady(code, activeStates) {
  return (activeStates ?? INGESTED_STANDARDS_STATES).has(code)
}
