import { Link } from 'react-router-dom'

/* Shared shell for /privacy and /terms — plain, light, public-facing, same
 * "no neo-world" register the landing/auth pages already use (see
 * AuthLayout.jsx's own comment on why: these are doors into the app, not
 * the app itself). A long legal document is read, not glanced at, so this
 * is deliberately closer to a plain article than anything else in the
 * product — a fixed max-width measure, real line-height, no cards or
 * embossing competing with the text.
 */
export function LegalLayout({ title, updated, children }) {
  return (
    <div className="legal-page min-h-app w-full bg-paper">
      <header className="legal-topbar">
        <div className="legal-topbar-inner">
        <Link
          to="/"
          className="legal-brand"
        >
          <span className="legal-brand-mark" aria-hidden="true">✓</span>
          FlexEd Academy
        </Link>
        <nav className="legal-nav" aria-label="Legal pages">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy" aria-current={title === 'Privacy Policy' ? 'page' : undefined}>Privacy</Link>
          <Link to="/" className="legal-nav-back">Back to app</Link>
        </nav>
        </div>
      </header>
      <main className="legal-main">
        <div className="legal-hero">
          <p className="legal-kicker">FlexEd Academy · Legal</p>
          <h1 className="legal-title">{title}</h1>
          <p className="legal-updated">Last updated {updated}</p>
        </div>
        <div className="legal-content">
          {children}
        </div>
        <p className="legal-footer">
          <Link to="/" className="text-accent-text hover:underline">
            Back to FlexEd Academy
          </Link>
        </p>
      </main>
    </div>
  )
}
