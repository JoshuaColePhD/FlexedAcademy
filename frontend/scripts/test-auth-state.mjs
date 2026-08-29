/* Can a logged-out visitor get into the app?
 *
 * This exists because the answer was "no" in production, for every visitor,
 * and nothing caught it:
 *
 *   - It threw no error, so Sentry saw nothing. The app simply sat on the boot
 *     screen forever.
 *   - Local dev runs REQUIRE_LOGIN=false, so /api/auth/me never 401s and the
 *     entire logged-out path is unreachable in development.
 *   - Every HTTP check stayed green: / returned 200 and /api/health returned ok
 *     the whole time the site was blank.
 *
 * The mechanism was specific: AuthProvider subscribes to qk.me, and the
 * identity-transition helper called queryClient.clear(), which removes EVERY
 * query — including the one being observed. React Query leaves that observer
 * holding a query no longer in the cache, reporting `data: undefined`, which
 * deriveAuthStatus reads as 'loading'. Nothing re-attaches it.
 *
 * So this drives the real QueryClient with a real QueryObserver, the way
 * AuthProvider does, and imports the real helpers from lib/authState.js rather
 * than restating them — a copy would have drifted right past the bug.
 *
 * NOT a browser test: the landing page renders client-side, so asserting on
 * "Sign in" would need Postgres + pgvector service containers and a headless
 * browser. This pins the mechanism that actually broke, in the CI that already
 * exists. The browser-level check is still worth having later.
 */
import assert from 'node:assert/strict'
import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { applyIdentityToCache, deriveAuthStatus } from '../src/lib/authState.js'

const ME = ['me']
const OTHER = ['classes']

// ── the status rule ───────────────────────────────────────────────────────
// undefined and null must NOT collapse together: a timeout is not a logout.
assert.equal(deriveAuthStatus(undefined), 'loading', 'unknown holds, it does not log you out')
assert.equal(deriveAuthStatus(null), 'anon', 'a definitive 401 is signed out')
assert.equal(deriveAuthStatus({ id: 'u1' }), 'authed', 'a user object is signed in')

/** A live qk.me observer, exactly as AuthProvider subscribes to one.
 *
 *  `initialMe === undefined` means "qk.me has not resolved yet", which is the
 *  state a real first page load is in — and the state that made this bug an
 *  outage rather than a blip. Orphaning does NOT surface as data flipping to
 *  undefined; the observer simply FREEZES on whatever it last saw and never
 *  updates again. Frozen on a resolved value is survivable. Frozen before the
 *  first resolve is 'loading', forever, which is the blank boot screen.
 */
function mountAuth(initialMe) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (initialMe !== undefined) qc.setQueryData(ME, initialMe)
  qc.setQueryData(OTHER, [{ id: 'class-from-previous-account' }])
  const observer = new QueryObserver(qc, { queryKey: ME, enabled: false })
  const unsubscribe = observer.subscribe(() => {})
  return { qc, observer, unsubscribe, status: () => deriveAuthStatus(observer.getCurrentResult().data) }
}

// ── the regression, reproduced as it actually happened ────────────────────
// A logged-out visitor loads the site. qk.me is still in flight (undefined),
// and an account-scoped request 401s first — api.js dispatches
// aplang:unauthorized, which runs applyIdentity(null). The observer must come
// out of that reporting null, so Gate can send them to /login.
{
  const auth = mountAuth(undefined)
  assert.equal(auth.status(), 'loading', 'precondition: nothing resolved yet')

  applyIdentityToCache(auth.qc, null, ME)

  assert.equal(
    auth.status(),
    'anon',
    'THE OUTAGE: qk.me was removed out from under its own live observer, which ' +
      'froze it at undefined -> loading -> a permanent blank boot screen for ' +
      'every logged-out visitor. No error, no failing health check.'
  )
  auth.unsubscribe()
}

// Signing IN across the same transition must land authed, not stall.
{
  const auth = mountAuth(null)
  applyIdentityToCache(auth.qc, { id: 'u2', name: 'New Teacher' }, ME)
  assert.equal(auth.status(), 'authed', 'signing in must resolve immediately')
  assert.equal(auth.observer.getCurrentResult().data.id, 'u2')
  auth.unsubscribe()
}

// ── the privacy guarantee the clear() was there for ───────────────────────
// Everything that is NOT qk.me must still be dropped, or the next person to
// sign in on a shared machine sees the previous teacher's classes.
{
  const auth = mountAuth({ id: 'u1' })
  assert.ok(auth.qc.getQueryData(OTHER), 'precondition: previous account had cached data')

  applyIdentityToCache(auth.qc, { id: 'u2' }, ME)

  assert.equal(
    auth.qc.getQueryData(OTHER),
    undefined,
    "the previous account's cached data must not survive an identity change"
  )
  assert.equal(auth.qc.getQueryData(ME).id, 'u2', 'the new account is seeded')
  auth.unsubscribe()
}

// Logging out must clear other data too, not just on login.
{
  const auth = mountAuth({ id: 'u1' })
  applyIdentityToCache(auth.qc, null, ME)
  assert.equal(auth.qc.getQueryData(OTHER), undefined, 'logout drops the account cache')
  assert.equal(auth.status(), 'anon')
  auth.unsubscribe()
}

console.log('auth state tests passed')
