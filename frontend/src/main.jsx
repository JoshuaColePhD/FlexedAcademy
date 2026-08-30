import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import App from './App.jsx'
import { installBrowserDiagnostics } from './lib/performanceMetrics'

installBrowserDiagnostics()

// Inert until VITE_SENTRY_DSN is set at build time — a dev machine shouldn't
// report its own console errors to a shared project.
if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
