/* The two pieces of auth logic that decide whether anyone can use the app,
 * pulled out of AuthProvider so they can be tested directly.
 *
 * Both exist because of a real outage. AuthProvider used to keep `user` in
 * plain useState; moving it onto the qk.me query made these two rules subtle
 * enough to get wrong, and getting them wrong showed every logged-out visitor
 * a permanent blank boot screen — no landing page, no sign-in form. Nothing
 * threw, so error tracking never saw it, and REQUIRE_LOGIN=false in local dev
 * meant the path could not even be reached in development.
 *
 * They live here, not inline, so scripts/test-auth-state.mjs can exercise the
 * SAME functions the app runs rather than a copy of them that can drift.
 */

/** qk.me's three states, and what each means for the app shell.
 *
 *  undefined -> we do not know yet (first fetch in flight, or a transport
 *               failure used up its retry) -> hold, do NOT log anyone out
 *  null      -> definitively signed out                       -> 'anon'
 *  object    -> signed in                                     -> 'authed'
 *
 *  The undefined/null split is the load-bearing part. Collapsing them treats a
 *  timeout as a logout, which is what used to drop teachers at the sign-in
 *  form mid-session on a cold Render instance. See AuthProvider's fetchMe: a
 *  401 becomes null, everything else rethrows so react-query retries.
 */
export function deriveAuthStatus(me) {
  if (me === undefined) return 'loading'
  return me ? 'authed' : 'anon'
}

/** Swap the cache over to a new identity: seed qk.me, drop everything else.
 *
 *  MUST NOT be queryClient.clear(). clear() removes every query — qk.me
 *  included — and AuthProvider is subscribed to that one. Removing a query out
 *  from under its own live observer leaves the observer reporting
 *  `data: undefined`, which deriveAuthStatus reads as 'loading', and nothing
 *  ever re-attaches it. That is the blank-boot-screen outage above: an
 *  ordinary logged-out visit 401s, api.js dispatches aplang:unauthorized, this
 *  runs, and the app hangs.
 *
 *  Removing the OTHER queries still matters and is not optional: the cache
 *  survives a login/logout that doesn't reload the page, and none of
 *  qk.classes/qk.calendar/etc are keyed by user id — so without this, signing
 *  out of one account and into another shows the previous teacher's classes
 *  under the new person's name.
 *
 *  Seeding first also means qk.me is never momentarily absent.
 */
export function applyIdentityToCache(queryClient, user, meKey) {
  queryClient.setQueryData(meKey, user ?? null)
  queryClient.removeQueries({ predicate: (query) => query.queryKey?.[0] !== meKey[0] })
  return user
}
