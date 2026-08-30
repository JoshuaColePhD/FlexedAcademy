import { lazy, Suspense, useEffect } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from 'react-router-dom'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'framer-motion'
import { onboardingDeferred } from './lib/onboardingWizardBus'
import { ToastProvider } from './components/ToastProvider'
import { ConfirmProvider } from './components/ConfirmProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthProvider } from './components/AuthProvider'
import { BillingProvider } from './components/BillingProvider'
import { VoiceProvider } from './components/VoiceProvider'
import { useAuth, EXPLICIT_SIGNOUT_KEY, KNOWN_AUTHED_KEY } from './lib/authContext'
import { safeReturnTo, withReturnTo } from './lib/returnTo'
import { readAccountStorage, writeAccountStorage } from './lib/accountStorage'
import { BootScreen } from './components/BootScreen'
import { AppShell } from './components/AppShell'
import { CommandPalette } from './components/CommandPalette'
import { ClassPage } from './pages/ClassPage.jsx'
import { PlansPage } from './pages/PlansPage.jsx'
import { StandardsPage } from './pages/StandardsPage.jsx'
import { useClasses } from './hooks/useAppData'
import './styles/base.css'

const lazyNamed = (loader, name) => lazy(() => loader().then((module) => ({ default: module[name] })))
const ChatPage = lazyNamed(() => import('./pages/ChatPage.jsx'), 'ChatPage')
const SettingsPage = lazyNamed(() => import('./pages/SettingsPage.jsx'), 'SettingsPage')
const HistoryPage = lazyNamed(() => import('./pages/HistoryPage.jsx'), 'HistoryPage')
const WelcomePage = lazyNamed(() => import('./pages/onboarding/WelcomePage.jsx'), 'WelcomePage')
const OnboardingSetupPage = lazyNamed(() => import('./pages/onboarding/OnboardingSetupPage.jsx'), 'OnboardingSetupPage')
const AdminPage = lazyNamed(() => import('./pages/AdminPage.jsx'), 'AdminPage')
const LandingPage = lazyNamed(() => import('./pages/LandingPage.jsx'), 'LandingPage')
const LoginPage = lazy(() => import('./pages/auth/LoginPage.jsx'))
const SignupPage = lazy(() => import('./pages/auth/SignupPage.jsx'))
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage.jsx'))
const PrivacyPolicyPage = lazyNamed(() => import('./pages/legal/PrivacyPolicyPage.jsx'), 'PrivacyPolicyPage')
const TermsPage = lazyNamed(() => import('./pages/legal/TermsPage.jsx'), 'TermsPage')
const BetaPage = lazyNamed(() => import('./pages/legal/BetaPage.jsx'), 'BetaPage')
const SharedPlanPage = lazyNamed(() => import('./pages/SharedPlanPage.jsx'), 'SharedPlanPage')
const NotFoundPage = lazyNamed(() => import('./pages/NotFoundPage.jsx'), 'NotFoundPage')

const LAST_CLASS_KEY = 'aplang.lastClassId'

/* Shell() is gone.
 *
 * It held chats, classes, settings, activeClassId, currentChatId and collapsed,
 * and prop-drilled a 15-key `shell` object into every page. Every one of those
 * was either a question about what the server says — now a query, see
 * hooks/useAppData.js — or a question about what the teacher is looking at, now
 * the URL. Nothing was left over, which is why no store replaced it.
 *
 * The class is a path segment because `activeClassId` was a localStorage global
 * with two writers (the sidebar switcher and a radio on My Class). In the URL it
 * has one writer, it is linkable, and the back button undoes a class switch.
 */

/** Where "/" goes.
 *
 *  The last class is a hint read ONCE, here, and never during render — which is
 *  the difference between a hint and the old localStorage global. If it names a
 *  class that no longer exists, the first class wins rather than the app
 *  rendering an empty year for a deleted prep. */
function RootRedirect() {
  const { data: classes = [], isLoading, isError } = useClasses()
  const { user } = useAuth()

  if (isLoading) return <BootScreen />
  /* "The request failed" is not "you have no classes". useClasses has
     retry: false, so a single blip left `data` undefined, which read as zero
     classes and sent a teacher with five preps into "Let's set up your year"
     and asked them to create their first class. */
  if (isError) {
    return (
      <div className="flex min-h-app w-full items-center justify-center bg-paper p-gutter">
        <div className="flex max-w-measure-form flex-col gap-3 text-center">
          <h1 className="text-lg font-semibold text-ink">Couldn’t load your classes</h1>
          <p className="note">
            The server didn’t answer. Your classes and plans are safe — this is just this screen.
          </p>
          <button
            type="button"
            className="btn mx-auto"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
  if (!classes.length) return <Navigate to="/welcome" replace />

  const hint = readAccountStorage(LAST_CLASS_KEY, user?.id)
  const target = classes.find((c) => c.id === hint) || classes[0]
  return <Navigate to={`/c/${target.id}`} replace />
}

/** Remembers the class you were last in, for the next cold load. Writing it in
 *  an effect rather than during render keeps it a hint: nothing reads it except
 *  RootRedirect, once. */
function RememberClass() {
  const { classId } = useParams()
  const { user } = useAuth()
  useEffect(() => {
    if (!classId || !user?.id) return
    writeAccountStorage(LAST_CLASS_KEY, user.id, '', classId)
  }, [classId, user?.id])
  return null
}

/** Plain full-page routes — no modal-over-chat trick. Settings and Account
 *  used to open as dialogs (react-router's "background location" pattern);
 *  replaced on request with a different shape: clicking the account trigger
 *  slides the rail shut (AppShell.jsx, keyed on the route itself) and the
 *  chat pane is replaced by a full, well-organized page instead — same
 *  "drill in, then come back" feel as a mobile settings screen, not a
 *  popover or an overlay. */
function ClassRoutes() {
  const { user } = useAuth()
  const { classId } = useParams()
  // First run, enforced here rather than trusted to whichever page linked in:
  // WelcomePage sends a brand-new account straight to .../onboarding, but
  // RootRedirect and AfterAuthRedirect both land on plain `/c/:classId` for
  // an *existing* account with classes — including one that dismissed the
  // wizard mid-flow last time and still has onboarding_seen_at unset. This
  // is the one place every path into a class passes through, so it's the one
  // place that has to hold the line: no account with onboarding still
  // outstanding ever sees the app shell behind it.
  // onboardingDeferred(): this teacher already tried to finish or skip the
  // wizard and the server would not record it (offline, 500). Without this
  // the redirect fires again immediately and there is no way into the app —
  // see deferOnboarding() in lib/onboardingWizardBus.js. Session-scoped, so
  // the wizard still returns next login; it is not a way to opt out.
  if (user && !user.onboarding_seen_at && !onboardingDeferred(user.id)) {
    return <Navigate to={`/c/${classId}/onboarding`} replace />
  }
  return (
    <>
      <RememberClass />
      <AppShell>
        <RouteTransition>
          <Suspense fallback={<BootScreen label="Loading workspace…" />}>
            {/* Let the nested router read the current location from context.
                Passing the parent render's location here became stale while
                RouteTransition kept the previous class screen mounted for
                its exit animation, which made React Router reject a pathname
                from the old class under the new class match. */}
            <Routes>
          {/* A new plan IS the home screen. There is no calendar route: the
              school calendar still shapes every generation, from
              backend/schoolcal.py, it just doesn't need a screen to do it. */}
          <Route index element={<ErrorBoundary scope="chat" compact><ChatPage /></ErrorBoundary>} />
          <Route path="chat/:chatId" element={<ErrorBoundary scope="chat" compact><ChatPage /></ErrorBoundary>} />
          <Route path="plans" element={<ErrorBoundary scope="plans" compact><PlansPage /></ErrorBoundary>} />
          <Route path="history" element={<ErrorBoundary scope="history" compact><HistoryPage /></ErrorBoundary>} />
          <Route path="class" element={<ErrorBoundary scope="class-settings" compact><ClassPage /></ErrorBoundary>} />
          <Route path="standards" element={<ErrorBoundary scope="standards" compact><StandardsPage /></ErrorBoundary>} />
          <Route path="settings" element={<ErrorBoundary scope="settings" compact><SettingsPage /></ErrorBoundary>} />
          <Route path="admin" element={<ErrorBoundary scope="admin" compact><AdminPage /></ErrorBoundary>} />
            <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </RouteTransition>
      </AppShell>
    </>
  )
}

/* One transition around the outlet gives every destination the same calm
 * handoff while leaving the persistent shell and sidebar in place. */
function RouteTransition({ children }) {
  const location = useLocation()
  const prefersReducedMotion = useReducedMotion()
  /* A new chat is a state change inside the same working surface, not a new
     page. Keying the transition on the raw pathname unmounted ChatPage when
     submit() navigated from `/c/:classId` to `/c/:classId/chat/:id`, which
     could discard the live turn during its first response. Normalize those
     two routes to one transition key while keeping genuine destinations
     (plans, settings, standards) animated normally. */
  const transitionKey = location.pathname
    .replace(/\/chat(?:\/[^/]+)?$/, '/chat')
    .replace(/^(\/c\/[^/]+)$/, '$1/chat')
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={transitionKey}
        className="route-stage"
        initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -2 }}
        transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 0.8, 0.24, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}

/** Public vs private, as a route split rather than a ternary.
 *
 *  `?next=` matters now that weeks are linkable: a teacher opening a bookmarked
 *  /c/x/week/12 with an expired cookie should land back on that week, not at the
 *  top of the app. */
function Gate() {
  const { status } = useAuth()
  const location = useLocation()
  /* Cleared in an effect keyed on `status`, not read-and-cleared inline: a
     removeItem during render would make the render depend on its own prior
     call, and StrictMode double-invokes this function body every commit —
     the second call would see the first call's clear and lose the flag
     before Gate ever returns. Reading it is a plain get, safe to repeat;
     removeItem is idempotent, safe to repeat too — so the effect just clears
     it once real per transition into 'anon' and the double-invoke is a
     non-issue either way. */
  useEffect(() => {
    if (status !== 'anon') return
    try {
      sessionStorage.removeItem(EXPLICIT_SIGNOUT_KEY)
    } catch {
      /* not available */
    }
  }, [status])

  if (status === 'loading') {
    let knownAuthed = false
    try {
      knownAuthed = localStorage.getItem(KNOWN_AUTHED_KEY) === '1'
    } catch {
      /* ignore */
    }
    if (knownAuthed) return <BootScreen />
    if (location.pathname === '/') {
      /* The landing page's own ground, held for the frame before it mounts.
         Two things had gone wrong here. --neo-dark is not a token — base.css
         defines --neo-dark-RGB (a channel triplet for the neumorphic shadow
         pair) and nothing defines the bare name, so this rule was invalid and
         painted nothing at all; the div fell through to body's var(--paper),
         which on a system-dark visitor is #1f1d1b. And the comment's premise
         expired when .land was recoloured from deep violet to white
         (--brand-rgb: 255 255 255) — so the flash it was written to prevent
         had inverted into a near-black one on exactly the page a first-time
         visitor arrives at. Literal, like index.html's own pre-paint
         theme-color for the same reason: this has to match .land's ground
         regardless of what data-theme the rest of the app is in. */
      return <div className="flex h-app w-full" style={{ backgroundColor: '#ffffff' }} />
    }
    return <div className="flex h-app w-full bg-paper" />
  }

  if (status === 'anon') {
    const here = location.pathname + location.search
    const isAuthRoute =
      location.pathname === '/login' ||
      location.pathname === '/signup' ||
      location.pathname === '/reset-password'
    /* Explicit sign-out lands on the homepage, not back at a password field —
       AuthProvider.logout() sets this right before the status flip that gets
       us here. Anything else that reaches status==='anon' off an app URL (an
       expired cookie mid-use) still gets `next=` so it round-trips back. */
    let explicitSignout = false
    try {
      explicitSignout = sessionStorage.getItem(EXPLICIT_SIGNOUT_KEY) === '1'
    } catch {
      /* not available */
    }
    return (
      <Suspense fallback={<div className="flex h-app w-full bg-paper" />}>
        <RouteTransition>
        <Routes>
          {/* The public front door. There wasn't one: every anonymous visitor,
              including someone arriving from a link who had never seen the
              product, was redirected straight to a password field. `/` is the
              landing page when signed OUT and RootRedirect when signed in, which
              is why it is declared in both trees. */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        {/* Public regardless of sign-in state — a signed-in teacher can
            read these too, so they're declared identically in both trees
            rather than gated like /login et al. */}
        <Route path="/privacy" element={<PrivacyPolicyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/beta" element={<BetaPage />} />
        <Route path="/shared/:id" element={<SharedPlanPage />} />
        {/* A deep link still round-trips through sign-in and comes back. */}
        <Route
          path="*"
          element={
            <Navigate
              to={
                explicitSignout
                  ? '/'
                  : isAuthRoute
                    ? '/login'
                    : withReturnTo('/login', here)
              }
              replace
            />
          }
        />
        </Routes>
        </RouteTransition>
      </Suspense>
    )
  }

  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/welcome" element={<WelcomePage />} />
      {/* Already signed in — bounce off the auth pages rather than showing a
          sign-in form to someone who is signed in. */}
      <Route path="/login" element={<AfterAuthRedirect />} />
      <Route path="/signup" element={<AfterAuthRedirect />} />
      {/* Renders even when signed in, unlike /login and /signup above.
          The old comment here read "the emailed link's job (log them in) is
          already done, and change-password now lives in settings" — the first
          half is true and the second half is the trap. Settings' change-password
          requires the CURRENT password, which is the thing a teacher following a
          reset link has forgotten. The session cookie lasts 30 days, so clicking
          that link on the laptop she is already signed in on is the likely case,
          and it silently redirected her into the app (or to /welcome, which
          reads as an unrelated malfunction) while the still-valid token expired
          unused. ResetPasswordPage works signed in or out by design — the token
          in the URL is the credential, not the cookie. */}
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/privacy" element={<PrivacyPolicyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/beta" element={<BetaPage />} />
      <Route path="/shared/:id" element={<SharedPlanPage />} />
      {/* Outside ClassRoutes/AppShell on purpose — see the guard in
          ClassRoutes above. A first-run account must never see the sidebar
          rail behind this, even for a frame. */}
      <Route path="/c/:classId/onboarding" element={<OnboardingSetupPage />} />
      <Route path="/c/:classId/*" element={<ClassRoutes />} />
      {/* Gated again server-side by every request the page makes — reaching
          this route with a non-admin session gets the page shell and then a
          403 from /api/admin/accounts, not real data. */}
      
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

/** Honours ?next= after a successful sign-in — but only once we know the
 *  account isn't brand-new. next is almost always a class-scoped URL (a
 *  colleague clicking a shared plan/week link IS how someone new to the
 *  product signs up), and a zero-class account can neither own nor do
 *  anything useful with whatever class that path names. Without this check,
 *  that signup landed straight in ClassRoutes with no class ever created —
 *  RootRedirect's own "no classes -> /welcome" only runs for a bare "/"
 *  visit, and login/signup/reset-password all funnel here instead, so the
 *  one path a brand-new teacher is actually likely to arrive by (a shared
 *  link) was exactly the one that skipped onboarding entirely. */
function AfterAuthRedirect() {
  const location = useLocation()
  const { data: classes = [], isLoading, isError } = useClasses()

  if (isLoading) return <BootScreen />
  // isError, not just "classes.length === 0": a failed request must not be
  // mistaken for zero classes — see RootRedirect's identical guard and the
  // bug it cites (a single blip once sent a five-class teacher to "Let's set
  // up your year"). On error, fall through to the ordinary next/'/' redirect
  // below rather than guessing either way.
  const next = safeReturnTo(new URLSearchParams(location.search).get('next'))
  // A brand-new recipient still needs to create a class and complete setup.
  // Carry the shared destination through both first-run screens so the link
  // remains useful after onboarding instead of silently disappearing.
  if (!isError && !classes.length) return <Navigate to={withReturnTo('/welcome', next)} replace />
  return <Navigate to={next || '/'} replace />
}

// Replaced by CommandPalette


const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 is handled globally by api.js dispatching aplang:unauthorized;
      // retrying it three times first just delays the login screen.
      retry: (count, err) => err?.status !== 401 && err?.status !== 404 && count < 2,
      refetchOnWindowFocus: false,
      /* Was unset, i.e. staleTime: 0 — every query refetched on EVERY mount.
         Measured on one page navigation: /api/auth/me six times, /api/classes
         four. Components like Greeting mount and unmount as the chat empties
         and fills, and each remount was a fresh round trip for data that had
         not changed. /api/auth/me in particular is one of the most expensive
         endpoints in the app (backend/routes/auth.py's _public_user computes
         the whole entitlement), so paying for it six times dominated the
         latency of a page load.

         30s is well under how often any of this actually changes server-side,
         and every mutation that DOES change something already invalidates or
         seeds its own key — so this only suppresses the redundant refetches,
         not real updates. Individual queries still override it where they
         want something longer (useClasses, useCalendar) or shorter. */
      staleTime: 30_000,
    },
  },
})

/* Motion has to degrade as a system, not one component at a time. Coarse
 * touch hardware pays the highest price for nested backdrop filters, animated
 * shadows, and ambient gradient repaints; flag it once so CSS can retain
 * meaningful transform motion while dropping that decorative work. */
function MotionProfile() {
  useEffect(() => {
    const coarse = window.matchMedia('(hover: none) and (pointer: coarse)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => {
      const constrained = reduced.matches || coarse.matches || navigator.connection?.saveData || (navigator.hardwareConcurrency || 8) <= 4
      document.documentElement.dataset.motion = constrained ? 'lite' : 'full'
    }
    update()
    coarse.addEventListener('change', update)
    reduced.addEventListener('change', update)
    return () => {
      coarse.removeEventListener('change', update)
      reduced.removeEventListener('change', update)
    }
  }, [])
  return null
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <MotionConfig reducedMotion="user">
        <MotionProfile />
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter basename={window.__previewBase || undefined}>
              <ToastProvider>
                <ConfirmProvider>
                  <AuthProvider>
                    {/* Inside AuthProvider: the entitlement rides on the user. */}
                    <BillingProvider>
                      <VoiceProvider>
                        <div className="app-texture neo-world flex h-app w-full overflow-hidden bg-paper-sunken font-sans text-ink relative">
                          <div className="app-blob absolute inset-0 z-0" aria-hidden="true" />
                          <Suspense fallback={<BootScreen />}>
                            <CommandPalette />
                            <Gate />
                          </Suspense>
                        </div>
                      </VoiceProvider>
                    </BillingProvider>
                  </AuthProvider>
                </ConfirmProvider>
              </ToastProvider>
            </BrowserRouter>
          </QueryClientProvider>
        </ErrorBoundary>
      </MotionConfig>
    </GoogleOAuthProvider>
  )
}
