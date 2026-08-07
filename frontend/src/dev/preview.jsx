/* TEMPORARY design-verification entry. Delete with mockApi.js and preview.html. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installMockApi } from './mockApi'
import App from '../App.jsx'

installMockApi()
/* ?anon=1 boots signed out, which is the only way to see the landing page —
   /api/auth/me must 401 for Gate to take the anon branch. */
if (new URLSearchParams(window.location.search).has('anon')) {
  const mocked = window.fetch
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/api/auth/me')) return Promise.resolve(new Response('{}', { status: 401 }))
    return mocked(input, init)
  }
}
/* Start on the class root — the greeting — so the new-chat path is the first
   thing under test. Append ?at=/c/c1/chat/chat1 to land somewhere else. */
const at = new URLSearchParams(window.location.search).get('at')
window.history.replaceState({}, '', at || '/c/c1')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
