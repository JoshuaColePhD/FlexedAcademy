/* Every cache key in one file.
 *
 * The point is not tidiness — it's that the week board is read by four surfaces
 * (the calendar grid, the queue card, the week page, the "N of M planned"
 * counter) and invalidated by six mutations (a finished generation, a day
 * revise, a whole-plan revise, a plan PATCH, a plan delete, and switching
 * class). With four independent fetches you get four requests and four
 * divergent copies of the same year, and the first time a teacher generates
 * week 12 and the calendar behind still says "Not planned" someone adds a
 * refresh callback — which is exactly how the old Shell object grew a
 * `refreshChats` prop that every page had to be handed.
 *
 * A key typo silently creates a second cache entry rather than failing, so they
 * are built here and nowhere else.
 */
export const qk = {
  me: ['me'],
  classes: ['classes'],
  settings: (subject) => ['settings', subject ?? null],
  frameworks: ['frameworks'],
  /** Whitelisted schools for the settings page dropdown — fixed lookup, not
   *  account data, so it isn't invalidated by anything account-related. */
  schools: ['schools'],
  /** Connected/not for the signed-in teacher — same status ShareDialog's own
   *  fetch checks, just also readable from Settings' proactive connect row. */
  driveStatus: ['drive-status'],
  /** Site-wide weekly token usage for the admin panel's trend chart —
   *  its own key, not nested under admin accounts, since it's invalidated
   *  on a totally different cadence (never, from the UI) than the accounts
   *  list (every comp/cap change). */
  adminUsageTrend: ['admin', 'usage-trend'],

  /** The year for one class. THE most-shared entry in the app. */
  calendar: (classId) => ['calendar', classId ?? null],

  /* Per class: the sidebar shows one prep's conversations, so two classes are
     two different lists and must not share a cache entry. */
  chats: (classId) => ['chats', classId ?? null],
  chat: (id) => ['chat', id],

  plan: (id) => ['plan', id],
  /** Every quiz built for one plan — its own key, not folded into plan(id),
   *  so a quiz finishing building doesn't have to re-fetch the whole plan. */
  quizzes: (planId) => ['quizzes', planId ?? null],
  /* The Library's grouped-by-week view, per class — same reasoning as chats
   *  above. */
  planWeeks: (classId) => ['plan-weeks', classId ?? null],
  curriculumProgress: (classId) => ['curriculum-progress', classId ?? null],
  classDocuments: (classId) => ['class-documents', classId],
}
