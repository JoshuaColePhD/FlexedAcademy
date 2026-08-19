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
    <div className="min-h-app w-full bg-paper">
      <header className="border-b border-edge px-gutter py-4">
        <Link
          to="/"
          className="inline-flex w-fit items-center gap-2.5 text-sm font-semibold tracking-tight text-ink transition-opacity hover:opacity-80"
        >
          FlexEd Academy
        </Link>
      </header>
      <main className="mx-auto w-full max-w-2xl px-gutter py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-sm text-ink-muted">Last updated {updated}</p>
        <div className="mt-8 flex flex-col gap-5 text-sm leading-relaxed text-ink-soft">
          {children}
        </div>
        <p className="mt-10 border-t border-edge pt-6 text-sm text-ink-muted">
          <Link to="/" className="text-accent-text hover:underline">
            Back to FlexEd Academy
          </Link>
        </p>
      </main>
    </div>
  )
}
