import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AuthContext, EXPLICIT_SIGNOUT_KEY, KNOWN_AUTHED_KEY } from '../lib/authContext'
import { api } from '../lib/api'
import { qk } from '../lib/queryKeys'
import { applyIdentityToCache, deriveAuthStatus } from '../lib/authState'

function setAuthedState(val) {
  try {
    if (val) localStorage.setItem(KNOWN_AUTHED_KEY, '1')
    else localStorage.removeItem(KNOWN_AUTHED_KEY)
  } catch {
    // ignore
  }
}

/* The one fetch of the signed-in account, shared by this provider and every
 * qk.me reader in the app.
 *
 * A 401 is resolved as `null` rather than thrown, which is what lets the three
 * states below be read straight off `data` with no separate error branch:
 *
 *   undefined -> we do not know yet (still fetching, or a transport failure
 *                exhausted its retry) -> 'loading'
 *   null      -> definitively not signed in                -> 'anon'
 *   object    -> signed in                                 -> 'authed'
 *
 * Anything that is NOT a 401 is rethrown so react-query's own retry handles it.
 * That distinction is load-bearing, not tidiness — see the status derivation
 * below for the outage it prevents. */
async function fetchMe() {
  try {
    return await api.me()
  } catch (err) {
    if (err?.status === 401) return null
    throw err
  }
}

export function AuthProvider({ children }) {
  // None of qk.classes/qk.schools/qk.calendar(...)/etc (queryKeys.js) are
  // keyed by user id — they don't need to be, since only one account is ever
  // signed in at a time in a real page load. But react-query's cache
  // survives a login/logout that DOESN'T reload the page, so without this,
  // signing out of one account and into another leaves every one of those
  // queries answering with the FIRST account's data until something happens
  // to invalidate it — a real teacher testing a second account (or two
  // people sharing a machine) sees the previous person's classes and school
  // rendered under their own name. Cleared on every identity transition
  // below, not just logout, since login/signup/resetPassword each replace
  // *which* account "the" cache is supposed to belong to just as much.
  const queryClient = useQueryClient()

  /* The account, as ONE react-query entry (qk.me) rather than this provider's
     own useState plus an imperative api.me().

     It used to be both: `user` lived here in useState, while SettingsPage and
     others separately read a ['me'] query. Nothing synced the two, so writing
     to one left the other stale — selecting an avatar updated the settings
     picker and left the sidebar showing the old one until a full page reload
     (the bug this rewrite is for). OnboardingWizard's own comment already
     warned about this trap; three call sites had fallen into it anyway.
     One key means a mutation can seed the answer with setQueryData and every
     reader in the app — this provider included — sees it in the same tick. */
  const meQuery = useQuery({
    queryKey: qk.me,
    queryFn: fetchMe,
    /* Exactly one extra attempt, 1.5s apart — the same budget the hand-rolled
       retriedRef used to give it. Only reachable for non-401s, since fetchMe
       resolves a 401 as null rather than throwing. */
    retry: 1,
    retryDelay: 1500,
    /* The account does not change underneath a teacher who isn't editing it,
       and every mutation that DOES change it seeds this key directly. */
    staleTime: 60_000,
  })

  const { data: me, isFetched } = meQuery

  /* "The request failed" is not "you are signed out".
   *
   * These used to be collapsed together, and a 401 and a timeout are
   * indistinguishable once you throw the error away. api.js aborts every
   * request at 20 seconds; this app's own keepwarm/README.md records that the
   * free Render instance sleeps after 15 minutes idle and takes ~50s to wake,
   * and the pinger that hides that doesn't cover every hour. So the first
   * /api/auth/me of an evening or weekend load — exactly when a teacher plans
   * — reliably timed out, flipped to anon, and dropped her at the sign-in form
   * with a perfectly valid session. It also cleared KNOWN_AUTHED_KEY, so the
   * next cold load skipped BootScreen too and went straight to the login
   * redirect.
   *
   * Hence three states, not two: `undefined` (still fetching, or a transport
   * failure used up its retry) holds at 'loading' so the shell waits instead
   * of accusing anyone of being logged out. Only an actual 401 — which fetchMe
   * turns into `null` — is 'anon'. Same distinction RootRedirect and
   * AfterAuthRedirect in App.jsx already make, both citing this bug class. */
  // lib/authState.js, so scripts/test-auth-state.mjs pins the real rule rather
  // than a copy of it. See that module for why the undefined/null split is
  // load-bearing.
  const status = deriveAuthStatus(me)
  const user = me ?? null

  /* Mirrors the query's answer into the localStorage hint BootScreen reads on
     the next cold load. Deliberately not touched while `me` is undefined — a
     timeout must leave a previously-known-authed flag alone. */
  useEffect(() => {
    if (!isFetched || me === undefined) return
    setAuthedState(Boolean(me))
  }, [me, isFetched])

  /* Re-reads the account and hands back the FRESH answer — callers that need
     it (BillingProvider's return-from-checkout poll) can read the result
     without racing React state, same contract as before. fetchQuery rather
     than meQuery.refetch() so this callback stays referentially stable. */
  const refresh = useCallback(
    () => queryClient.fetchQuery({ queryKey: qk.me, queryFn: fetchMe, staleTime: 0 }),
    [queryClient]
  )

  /* Every identity transition funnels through here: seed qk.me with who we
     now are, then drop every OTHER account-scoped query.

     It must never be queryClient.clear(). clear() removes *every* query,
     including qk.me — which this provider is actively subscribed to via
     useQuery above. That leaves the observer holding a query object that is
     no longer in the cache, reporting `data: undefined`, and `undefined` is
     precisely the value `status` reads as 'loading'. Nothing re-attaches it,
     so the app hangs on the boot screen forever.

     That is not theoretical: it shipped. A logged-out visitor loads the site,
     some account-scoped request 401s, api.js dispatches aplang:unauthorized,
     this runs, clear() orphans the observer, and the landing page never
     renders — no sign-in, no marketing page, nothing. Every new visitor and
     everyone whose session had expired got a permanent blank boot screen.
     The old useState-backed version was immune by construction, because
     `status` did not live in the cache it was clearing.

     removeQueries with a predicate keeps the privacy guarantee that motivated
     the clear() in the first place — signing out of one account must not
     leave the next person looking at its classes — while leaving the one
     query that has a live observer alone. Seeding qk.me first also means
     there is no frame where it is momentarily absent. */
  const applyIdentity = useCallback(
    (u) => {
      applyIdentityToCache(queryClient, u, qk.me)
      setAuthedState(Boolean(u))
      return u
    },
    [queryClient]
  )

  // A session expiring mid-use surfaces as a 401 from whatever request hit it
  // first — api.js dispatches this once, globally, instead of every page
  // needing its own "you got logged out" handling.
  useEffect(() => {
    const onUnauthorized = () => applyIdentity(null)
    window.addEventListener('aplang:unauthorized', onUnauthorized)
    return () => window.removeEventListener('aplang:unauthorized', onUnauthorized)
  }, [applyIdentity])

  const login = useCallback(
    async (email, password) => applyIdentity(await api.login(email, password)),
    [applyIdentity]
  )

  const loginDemo = useCallback(
    async () => applyIdentity(await api.demoLogin()),
    [applyIdentity]
  )

  const loginWithGoogle = useCallback(
    async (credential) => applyIdentity(await api.loginWithGoogle(credential)),
    [applyIdentity]
  )

  const signup = useCallback(
    async (name, email, password, extra) => {
      const result = await api.signup(name, email, password, extra)
      return result?.verification_required ? result : applyIdentity(result)
    },
    [applyIdentity]
  )

  const verifyEmail = useCallback(
    async (token) => applyIdentity(await api.verifyEmail(token)),
    [applyIdentity]
  )

  // /api/auth/reset-password logs the account in directly (same cookie the
  // login route sets) — a reset link that dropped you into a second sign-in
  // form would be one more thing standing between "forgot password" and
  // actually building a plan.
  const resetPassword = useCallback(
    async (token, password) => applyIdentity(await api.resetPassword(token, password)),
    [applyIdentity]
  )

  const logout = useCallback(async () => {
    /* A flag, not a navigate() call: navigate() and the status flip below
       land in separate commits (the router's own location state and React's
       don't actually batch together), so Gate would render once with the new
       status but the OLD location, and its wildcard route already redirects
       to /login?next=<that old path> before the location update ever lands.
       Gate reads this flag itself once it sees status go anon — see Gate in
       App.jsx — which sidesteps the ordering question entirely. */
    try {
      sessionStorage.setItem(EXPLICIT_SIGNOUT_KEY, '1')
    } catch {
      /* Not available — worst case this falls back to the next-preserving
         redirect, same as a session that expired mid-use. */
    }
    try {
      await api.logout()
    } finally {
      applyIdentity(null)
    }
  }, [applyIdentity])

  /* Same shape as logout — this device's cookie stops working too (its "sv"
     no longer matches, per backend/deps.py), so it has to end up in the same
     anon state, not just "every OTHER device." */
  const signOutEverywhere = useCallback(async () => {
    try {
      sessionStorage.setItem(EXPLICIT_SIGNOUT_KEY, '1')
    } catch {
      /* Not available — same fallback as logout() above. */
    }
    try {
      await api.signOutEverywhere()
    } finally {
      applyIdentity(null)
    }
  }, [applyIdentity])

  /* NOT the same try/finally shape as logout/signOutEverywhere above — a
     wrong password must stay a normal thrown error with the account intact,
     not flip to anon regardless. Only a request that actually succeeded
     (the account is genuinely gone server-side) should end the session
     client-side, so the state flip happens after the await, not in a
     finally that runs either way. */
  const deleteAccount = useCallback(async (password) => {
    await api.deleteAccount(password)
    try {
      sessionStorage.setItem(EXPLICIT_SIGNOUT_KEY, '1')
    } catch {
      /* Not available — same fallback as logout() above. */
    }
    applyIdentity(null)
  }, [applyIdentity])

  /* Memoized: this provider sits above the entire app (App.jsx), so a fresh
     object literal here re-rendered every useAuth() consumer — plus
     BillingProvider and VoiceProvider — on any render of this component,
     regardless of whether the account actually changed. */
  const value = useMemo(
    () => ({
      status,
      user,
      login,
      loginDemo,
      loginWithGoogle,
      signup,
      verifyEmail,
      resetPassword,
      logout,
      signOutEverywhere,
      deleteAccount,
      refresh,
    }),
    [
      status,
      user,
      login,
      loginDemo,
      loginWithGoogle,
      signup,
      verifyEmail,
      resetPassword,
      logout,
      signOutEverywhere,
      deleteAccount,
      refresh,
    ]
  )

  return (
    <AuthContext.Provider
      value={value}
    >
      {children}
    </AuthContext.Provider>
  )
}
