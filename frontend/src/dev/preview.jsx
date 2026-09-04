/* TEMPORARY design-verification entry. Delete with mockApi.js and preview.html. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installMockApi } from './mockApi'
import App from '../App.jsx'

installMockApi()

const params = new URLSearchParams(window.location.search)
/* ?anon=1 boots signed out, which is the only way to see the landing page —
   /api/auth/me must 401 for Gate to take the anon branch. */
if (params.has('anon')) {
  const mocked = window.fetch
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    // Keep the anonymous boot state until the mock login/signup handlers flip
    // state.authenticated. A permanent 401 here made it impossible to test a
    // real first-run handoff: the form could succeed, but AuthProvider was
    // immediately told the user was still signed out.
    if (url.includes('/api/auth/me') && !window.__mock?.state.authenticated) {
      return Promise.resolve(new Response('{}', { status: 401 }))
    }
    return mocked(input, init)
  }
}
/* ?fresh=1 boots as a teacher who has just signed up: no classes, no avatar,
   the account's default 'generic' school, and setup outstanding. That is the
   only state that shows the FIRST-RUN onboarding flow — profile, course
   (which creates the class), standards, school, calendar, format, materials —
   and it is otherwise unreachable here, because the fixtures deliberately
   describe an established account and RootRedirect sends anyone with a class
   straight into it.
   
   Mutating the fixture before render, rather than from the console: the app
   fetches /api/auth/me and /api/classes on mount, so by the time a console
   command lands React Query has already cached the established account and a
   client-side navigation just re-reads the cache. */
if (params.has('fresh')) {
  const st = window.__mock.state
  st.classes.length = 0
  st.me.onboarding_seen_at = null
  st.me.onboarding_state = 'not_started'
  st.me.onboarding_step = null
  st.me.avatar = null
  st.me.school = 'generic'
}

/* Start on the class root — the greeting — so the new-chat path is the first
   thing under test. Append ?at=/c/c1/chat/chat1 to land somewhere else.
   With ?fresh=1 the default is '/', so RootRedirect does the routing that a
   real new account gets rather than deep-linking past it. */
const at = params.get('at') || (params.has('fresh') ? '/' : null)
// Keep BrowserRouter inside this HTML entry. Without a basename, the first
// client-side navigation leaves /preview.html and Vite serves index.html,
// dropping the mock fetch installation exactly when a new chat is created.
window.__previewBase = '/preview.html'

/* Only seed the route when there ISN'T one already.
 *
 * This used to replaceState unconditionally, which meant a reload of a deep
 * link like /preview.html/onboarding was rewritten straight back to
 * /preview.html/c/c1 — so the vite middleware that makes those URLs
 * reloadable at all would have been undone one line later. An explicit ?at=
 * still wins, since that is someone asking for a specific screen. */
const current = window.location.pathname.slice(window.__previewBase.length)
if (at || !current || current === '/') {
  window.history.replaceState({}, '', `${window.__previewBase}${at || '/c/c1'}`)
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
