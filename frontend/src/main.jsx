import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { installBrowserDiagnostics } from './lib/performanceMetrics'
import { installPressFeedback } from './lib/haptics'
import { startMonitoring } from './lib/monitoringClient'

installBrowserDiagnostics()
installPressFeedback()

// Inert until VITE_SENTRY_DSN is set at build time — a dev machine shouldn't
// report its own console errors to a shared project.
startMonitoring()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)
