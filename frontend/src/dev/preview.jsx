/* TEMPORARY design-verification entry. Delete with mockApi.js and preview.html. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installMockApi } from './mockApi'
import App from '../App.jsx'

installMockApi()
window.history.replaceState({}, '', '/c/c1/chat/chat1')

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
