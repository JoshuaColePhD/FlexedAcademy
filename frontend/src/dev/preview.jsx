/* TEMPORARY design-verification entry. Delete with mockApi.js and preview.html. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installMockApi } from './mockApi'
import App from '../App.jsx'

installMockApi()
/* Start on the class root — the greeting — so the new-chat path is the first
   thing under test. Append ?at=/c/c1/chat/chat1 to land somewhere else. */
const at = new URLSearchParams(window.location.search).get('at')
window.history.replaceState({}, '', at || '/c/c1')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
