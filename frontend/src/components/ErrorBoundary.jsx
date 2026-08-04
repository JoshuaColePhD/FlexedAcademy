import { Component } from 'react'
import { RotateCcw } from 'lucide-react'

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
    console.error('Unhandled UI error:', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <div className="crash-card">
          <h1>Something broke in the interface</h1>
          <p style={{ color: 'var(--ink-muted)' }}>
            Your plans are stored on the server, so nothing has been lost. Reloading usually clears
            it.
          </p>
          <pre>{String(this.state.error?.stack || this.state.error)}</pre>
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
              <RotateCcw size={14} aria-hidden="true" /> Reload
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
