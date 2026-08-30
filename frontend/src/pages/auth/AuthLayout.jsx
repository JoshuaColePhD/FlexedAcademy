import { Link, useNavigate } from 'react-router-dom'
import { handleViewTransitionNavigation } from '../../lib/viewTransitions'

/* The frame both sign-in and sign-up render into.
 *
 * Used to carry a claims panel (standards quoted, the real school calendar,
 * the district's own template) as the product's one marketing surface. Cut
 * entirely: this app plans for many schools and districts, not just
 * Florence City Schools, and a door meant for any of them shouldn't lead
 * with one district's specifics — it should just get a teacher signed in.
 *
 * `auth-ground` (base.css) puts this on the landing page's fixed dark brand
 * ground instead of the app's own light paper — a deliberate second break
 * from data-theme, so the door and the form you sign into read as one place.
 *
 * `neo-world` layered on top of that (on request, once the rest of the app
 * went neomorphic): its own primitives are declared LATER in base.css than
 * auth-ground's, so they win the cascade outright rather than blending with
 * it — the door now opens onto the same cream/rose embossed world as
 * everything past it, not a separate dark one. */

export const authInputClass =
  'block w-full rounded-lg border border-edge bg-paper-raised px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent neo-inset'

export function AuthLayout({ title, subtitle, children, footer }) {
  const navigate = useNavigate()

  return (
    // h-app, not min-h-app: index.html's <body> is overflow-hidden — every
    // other screen in the app manages its own scroll region instead of
    // relying on the page to scroll, and this is the one screen that didn't.
    // The card below is that region now.
    <div className="auth-ground neo-world flex h-app w-full items-center justify-center bg-paper p-gutter">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-edge bg-paper-raised p-8 shadow-lg md:p-10">
        {/* The way back. Once you clicked "Start a week free" there was no
            route to the landing page except the browser's own back button —
            the wordmark is where everyone looks for it, and it was inert. */}
        <Link
          to="/"
          className="auth-brand-link flex w-fit items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
          aria-label="FlexEd Academy — back to the home page"
          onClick={(event) => handleViewTransitionNavigation(event, navigate, '/')}
        >
          <span className="text-sm font-semibold tracking-tight text-ink">FlexEd Academy</span>
        </Link>

        <div className="mt-7">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-ink-muted">{subtitle}</p> : null}
        </div>
        {children}
        {footer ? <div className="mt-6 text-center text-sm text-ink-muted">{footer}</div> : null}
      </div>
    </div>
  )
}
