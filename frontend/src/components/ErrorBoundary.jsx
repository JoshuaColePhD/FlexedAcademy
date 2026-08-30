import { Component } from 'react'
import { RotateCcw } from 'lucide-react'
import * as Sentry from '@sentry/react'

const CHUNK_RELOAD_KEY = 'flexed.chunk-reload'
const CHUNK_ERROR_RE = /failed to fetch dynamically imported module|imported module|loading (?:chunk|css chunk)|chunkloaderror/i

/* A deploy replaces Vite's hashed route files. A tab that was open during the
 * deploy can still have the old app shell in memory, so its next navigation
 * asks the new server for a chunk that no longer exists. One automatic reload
 * gets a fresh index and matching asset map; the session flag prevents a real
 * network or code error from turning into an infinite reload loop. */
function reloadForStaleChunk(error) {
  if (typeof window === 'undefined' || !CHUNK_ERROR_RE.test(String(error?.message || error))) {
    return false
  }

  try {
    const previous = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY))
    if (Number.isFinite(previous) && Date.now() - previous < 10000) {
      window.sessionStorage.removeItem(CHUNK_RELOAD_KEY)
      return false
    }
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
  } catch {
    // If storage is unavailable, leave the normal error UI as the safe fallback.
    return false
  }

  window.location.reload()
  return true
}

/* There was no error boundary, so any render-time throw blanked the page with no
   way back — and a corrupt localStorage entry could put it in that state
   permanently. Offers a reset that clears local state, since that's the usual
   cause. */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    if (reloadForStaleChunk(error)) return
    console.error('Unhandled UI error:', error, info)
    // A thrown value can include an API response or lesson text. Observability
    // needs the failure shape, not a teacher's content, so report a stable,
    // content-free event rather than serialising the exception or component
    // stack to a third party.
    Sentry.captureMessage('UI section crashed', {
      level: 'error',
      tags: { scope: this.props.scope || 'application' },
    })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className={this.props.compact ? 'crash crash-compact' : 'crash'}>
        <div className="crash-card">
          <h1>Something broke in the interface</h1>
          <p>
            Your plans are stored on the server, so nothing has been lost. Reloading usually clears
            it.
          </p>
          {/* The message is useful; a raw stack trace is not something to put in
              front of a teacher as the first thing they read. It stays available
              — collapsed — so a bug report is still possible. */}
          <p className="crash-message">{String(this.state.error?.message || this.state.error)}</p>
          <details className="crash-details">
            <summary>Technical details</summary>
            <pre>{String(this.state.error?.stack || this.state.error)}</pre>
          </details>
          <div className="crash-actions">
            <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>
              <RotateCcw size={14} aria-hidden="true" /> Try this section again
            </button>
            <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
              <RotateCcw size={14} aria-hidden="true" /> Reload
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                const text = String(this.state.error?.stack || this.state.error)
                navigator.clipboard?.writeText(text).catch(() => {})
              }}
            >
              Copy details
            </button>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => {
                try {
                  localStorage.clear()
                } catch {
                  /* nothing to clear */
                }
                location.reload()
              }}
            >
              Clear local settings and reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
