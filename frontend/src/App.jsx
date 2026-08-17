import { useEffect } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { api } from './lib/api'
import { useToast } from './lib/toastContext'
import { ToastProvider } from './components/ToastProvider'
import { ConfirmProvider } from './components/ConfirmProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AuthProvider } from './components/AuthProvider'
import { BillingProvider } from './components/BillingProvider'
import { VoiceProvider } from './components/VoiceProvider'
import { useAuth, EXPLICIT_SIGNOUT_KEY, KNOWN_AUTHED_KEY } from './lib/authContext'
import { BootScreen } from './components/BootScreen'
import { AppShell } from './components/AppShell'
import { CommandPalette } from './components/CommandPalette'
import { useClasses } from './hooks/useAppData'
import { ChatPage } from './pages/ChatPage'
import { ClassPage } from './pages/ClassPage'
import { SettingsPage } from './pages/SettingsPage'
import { PlansPage } from './pages/PlansPage'
import { HistoryPage } from './pages/HistoryPage'
import { WelcomePage } from './pages/onboarding/WelcomePage'
import { AdminPage } from './pages/AdminPage'
import { LandingPage } from './pages/LandingPage'
import LoginPage from './pages/auth/LoginPage'
import SignupPage from './pages/auth/SignupPage'
import ResetPasswordPage from './pages/auth/ResetPasswordPage'
import { PrivacyPolicyPage } from './pages/legal/PrivacyPolicyPage'
import { TermsPage } from './pages/legal/TermsPage'
import { NotFoundPage } from './pages/NotFoundPage'
import './styles/base.css'

const LEGACY_KEY = 'lesson_chats'
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

/** One-time migration of the old localStorage chats into the database.
 *  localStorage is cleared only after the import succeeds, so a failure is never
 *  data loss. */
function useLegacyImport() {
  const toast = useToast()
  useEffect(() => {
    let raw
    try {
      raw = localStorage.getItem(LEGACY_KEY)
    } catch {
      return
    }
    if (!raw) return

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      // A corrupt entry used to white-screen the app permanently on boot.
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        /* nothing more to do */
      }
      return
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        /* ignore */
      }
      return
    }

    api
      .importChats(parsed)
      .then((res) => {
        localStorage.removeItem(LEGACY_KEY)
        if (res.imported) {
          toast.success(
            `Moved ${res.imported} conversation${res.imported === 1 ? '' : 's'} to the server`,
            'They were only in this browser before.'
          )
        }
      })
      .catch(() => {
        // Leave localStorage intact and try again next load.
      })
  }, [toast])
}

/** Where "/" goes.
 *
 *  The last class is a hint read ONCE, here, and never during render — which is
 *  the difference between a hint and the old localStorage global. If it names a
 *  class that no longer exists, the first class wins rather than the app
 *  rendering an empty year for a deleted prep. */
function RootRedirect() {
  const { data: classes = [], isLoading, isError } = useClasses()
  useLegacyImport()

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

  let hint = null
  try {
    hint = localStorage.getItem(LAST_CLASS_KEY)
  } catch {
    /* not available */
  }
  const target = classes.find((c) => c.id === hint) || classes[0]
  return <Navigate to={`/c/${target.id}`} replace />
}

/** Remembers the class you were last in, for the next cold load. Writing it in
 *  an effect rather than during render keeps it a hint: nothing reads it except
 *  RootRedirect, once. */
function RememberClass() {
  const { classId } = useParams()
  useEffect(() => {
    if (!classId) return
    try {
      localStorage.setItem(LAST_CLASS_KEY, classId)
    } catch {
      /* not persisted */
    }
  }, [classId])
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
  return (
    <>
      <RememberClass />
      <AppShell>
        <Routes>
          {/* A new plan IS the home screen. There is no calendar route: the
              school calendar still shapes every generation, from
              backend/schoolcal.py, it just doesn't need a screen to do it. */}
          <Route index element={<ChatPage />} />
          <Route path="chat/:chatId" element={<ChatPage />} />
          <Route path="plans" element={<PlansPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="class" element={<ClassPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppShell>
    </>
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
      // Landing page is dark, auth routes are light. Prevent white flash or skeleton flash.
      return <div className="flex h-app w-full" style={{ backgroundColor: 'var(--neo-dark)' }} />
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
                    : `/login?next=${encodeURIComponent(here)}`
              }
              replace
            />
          }
        />
      </Routes>
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
      {/* Already signed in — the emailed link's job (log them in) is already
          done, and change-password now lives in settings. */}
      <Route path="/reset-password" element={<AfterAuthRedirect />} />
      <Route path="/privacy" element={<PrivacyPolicyPage />} />
      <Route path="/terms" element={<TermsPage />} />
      <Route path="/c/:classId/*" element={<ClassRoutes />} />
      {/* Gated again server-side by every request the page makes — reaching
          this route with a non-admin session gets the page shell and then a
          403 from /api/admin/accounts, not real data. */}
      <Route path="/admin" element={<AdminPage />} />
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
  if (!isError && !classes.length) return <Navigate to="/welcome" replace />

  const next = new URLSearchParams(location.search).get('next')
  // Only same-origin paths, so a crafted ?next=https://… can't turn the login
  // screen into an open redirect.
  const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  return <Navigate to={safe} replace />
}

// Replaced by CommandPalette


const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 is handled globally by api.js dispatching aplang:unauthorized;
      // retrying it three times first just delays the login screen.
      retry: (count, err) => err?.status !== 401 && err?.status !== 404 && count < 2,
      refetchOnWindowFocus: false,
    },
  },
})

export default function App() {
  return (
    <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <ToastProvider>
              <ConfirmProvider>
                <AuthProvider>
                  {/* Inside AuthProvider: the entitlement rides on the user. */}
                  <BillingProvider>
                    <VoiceProvider>
                      <CommandPalette />
                      <Gate />
                    </VoiceProvider>
                  </BillingProvider>
                </AuthProvider>
              </ConfirmProvider>
            </ToastProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ErrorBoundary>
    </GoogleOAuthProvider>
  )
}
