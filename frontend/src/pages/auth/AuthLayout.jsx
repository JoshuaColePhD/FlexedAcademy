import { Link } from 'react-router-dom'
import { CalendarDays, FileCheck2, Quote } from 'lucide-react'

/* The frame both sign-in and sign-up render into.
 *
 * The claims panel was worth extracting rather than duplicating: it is the only
 * marketing surface in the product, and a teacher who lands on /signup from a
 * colleague's link should get the same argument as one who lands on /login.
 *
 * They are deliberately the things that are true and unusual — standards quoted
 * rather than recalled, the real school calendar, the district's own template —
 * not generic SaaS copy. An earlier version claimed "Instant slide decks",
 * which this app does not do.
 */

const CLAIMS = [
  {
    icon: Quote,
    title: 'Standards quoted, not recalled',
    body: 'Every code in a plan is retrieved from the Alabama Course of Study and links back to the page it came from.',
  },
  {
    icon: CalendarDays,
    title: 'Knows your calendar',
    body: 'Weeks come from your school calendar, so Fall Break never gets five days of lessons.',
  },
  {
    icon: FileCheck2,
    title: 'The district’s own template',
    body: 'Plans come out as the Florence City Schools .docx, ready to hand in without reformatting.',
  },
]

export const authInputClass =
  'block w-full rounded-lg border border-edge bg-paper-raised px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent'

export function AuthLayout({ title, subtitle, children, footer }) {
  return (
    // h-app, not min-h-app: index.html's <body> is overflow-hidden — every
    // other screen in the app manages its own scroll region instead of
    // relying on the page to scroll, and this is the one screen that didn't.
    // The card below is that region now.
    <div className="flex h-app w-full items-center justify-center bg-paper p-gutter">
      {/* overflow-y-auto + max-h-full, not the old plain overflow-hidden: on
          the stacked mobile layout (claims panel THEN the form, both full
          width below md) the card ran taller than the viewport with no
          scroll container anywhere in its ancestry — the sign-in button was
          there, just permanently below the fold. overflow-x stays hidden so
          the rounded corners still clip the left panel's own background the
          way plain overflow-hidden did. */}
      <div className="grid max-h-full w-full max-w-4xl overflow-y-auto overflow-x-hidden rounded-2xl border border-edge bg-paper-raised shadow-lg md:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col justify-center gap-7 border-b border-edge bg-paper-sunken p-8 md:border-b-0 md:border-r md:p-10">
          {/* The way back. Once you clicked "Start a week free" there was no
              route to the landing page except the browser's own back button —
              the wordmark is where everyone looks for it, and it was inert. */}
          <Link
            to="/"
            className="flex w-fit items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
            aria-label="Flexed Academy — back to the home page"
          >
            <span className="text-sm font-semibold tracking-tight text-ink">Flexed Academy</span>
          </Link>

          <h1 className="text-2xl font-semibold leading-snug tracking-tight text-ink">
            A week of lesson plans,
            <br />
            grounded in the real standards.
          </h1>

          <ul className="flex flex-col gap-5">
            {CLAIMS.map(({ icon: Icon, title: t, body }) => (
              <li className="flex items-start gap-3" key={t}>
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-paper-raised text-ink-soft"
                >
                  <Icon size={16} />
                </span>
                <span>
                  <span className="block text-sm font-medium text-ink">{t}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col justify-center p-8 md:p-10">
          {/* Sticky, because the card itself is what scrolls now (see above) —
              on a long mobile form (Google button, divider, two fields, the
              submit button, the "Forgot your password?" disclosure) "Sign in"
              or "Create an account" would otherwise scroll away first, and a
              teacher scrolled halfway down loses which form they're in. The
              negative margins bleed it back out to the panel's own edges so
              the sticky background covers corner-to-corner instead of leaving
              the panel's side padding see-through above it. */}
          <div className="sticky top-0 z-10 -mx-8 -mt-8 bg-paper-raised px-8 pb-3 pt-8 md:-mx-10 md:-mt-10 md:px-10 md:pt-10">
            <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
            {subtitle ? <p className="mt-1 text-sm text-ink-muted">{subtitle}</p> : null}
          </div>
          {children}
          {footer ? <div className="mt-6 text-center text-sm text-ink-muted">{footer}</div> : null}
        </div>
      </div>
    </div>
  )
}
