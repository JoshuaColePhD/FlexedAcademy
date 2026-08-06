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

  /** The year for one class. THE most-shared entry in the app. */
  calendar: (classId) => ['calendar', classId ?? null],

  chats: ['chats'],
  chat: (id) => ['chat', id],

  plan: (id) => ['plan', id],
  curriculumProgress: (classId) => ['curriculum-progress', classId ?? null],
  classDocuments: (classId) => ['class-documents', classId],
}
