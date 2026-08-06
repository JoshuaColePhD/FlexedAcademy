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
import { useAuth } from './lib/authContext'
import { BootScreen } from './components/BootScreen'
import { AppShell } from './components/AppShell'
import { useCalendar, useClasses } from './hooks/useAppData'
import { firstUnplanned } from './lib/queue'
import { CalendarPage } from './pages/CalendarPage'
import { WeekPage } from './pages/WeekPage'
import { ChatPage } from './pages/ChatPage'
import { ClassPage } from './pages/ClassPage'
import { WelcomePage } from './pages/onboarding/WelcomePage'
import LoginPage from './pages/auth/LoginPage'
import SignupPage from './pages/auth/SignupPage'
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
  const { data: classes = [], isLoading } = useClasses()
  useLegacyImport()

  if (isLoading) return <BootScreen />
  if (!classes.length) return <Navigate to="/welcome" replace />

  let hint = null
  try {
    hint = localStorage.getItem(LAST_CLASS_KEY)
  } catch {
    /* not available */
  }
  const target = classes.find((c) => c.id === hint) || classes[0]
  return <Navigate to={`/c/${target.id}/calendar`} replace />
}

/** The canonical "plan the next thing" URL.
 *
 *  Exists as a redirect-only route so the queue card, ⌘K and any link a teacher
 *  bookmarks all funnel through one address instead of each computing the next
 *  unplanned week for themselves. */
function NextWeekRedirect() {
  const { classId } = useParams()
  const { data, isLoading } = useCalendar(classId)
  if (isLoading) return <BootScreen />
  const next = firstUnplanned(data?.weeks)
  return (
    <Navigate
      to={next ? `/c/${classId}/week/${next.week}` : `/c/${classId}/calendar`}
      replace
    />
  )
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

function ClassRoutes() {
  return (
    <>
      <RememberClass />
      <AppShell>
        <Routes>
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="week/next" element={<NextWeekRedirect />} />
          <Route path="week/:weekNo" element={<WeekPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="chat/:chatId" element={<ChatPage />} />
          <Route path="class" element={<ClassPage />} />
          <Route index element={<Navigate to="calendar" replace />} />
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

  if (status === 'loading') return <BootScreen />

  if (status === 'anon') {
    const here = location.pathname + location.search
    const isAuthRoute = location.pathname === '/login' || location.pathname === '/signup'
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route
          path="*"
          element={
            <Navigate
              to={isAuthRoute ? '/login' : `/login?next=${encodeURIComponent(here)}`}
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
      <Route path="/c/:classId/*" element={<ClassRoutes />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}

/** Honours ?next= after a successful sign-in. */
function AfterAuthRedirect() {
  const location = useLocation()
  const next = new URLSearchParams(location.search).get('next')
  // Only same-origin paths, so a crafted ?next=https://… can't turn the login
  // screen into an open redirect.
  const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  return <Navigate to={safe} replace />
}

/** ⌘K goes to the next week that needs planning — the one action the app is
 *  for. It used to open a blank chat. */
function CommandK() {
  const navigate = useNavigate()
  const location = useLocation()
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const m = location.pathname.match(/^\/c\/([^/]+)/)
        if (m) navigate(`/c/${m[1]}/week/next`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, location.pathname])
  return null
}

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
                  <CommandK />
                  <Gate />
                </AuthProvider>
              </ConfirmProvider>
            </ToastProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </ErrorBoundary>
    </GoogleOAuthProvider>
  )
}
