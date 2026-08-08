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
    <div className="flex min-h-app w-full items-center justify-center bg-paper p-gutter">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-edge bg-paper-raised shadow-lg md:grid-cols-[1.1fr_1fr]">
        <div className="flex flex-col justify-center gap-7 border-b border-edge bg-paper-sunken p-8 md:border-b-0 md:border-r md:p-10">
          {/* The way back. Once you clicked "Start a week free" there was no
              route to the landing page except the browser's own back button —
              the wordmark is where everyone looks for it, and it was inert. */}
          <Link
            to="/"
            className="flex w-fit items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
            aria-label="Flexed Academy — back to the home page"
          >
            {/* --ink, not --accent. Rule 4 reserves blue for "something is
                waiting for you"; a logo mark is not waiting for anything, and
                spending the accent here is what makes it stop meaning anything
                on the calendar. */}
            <span
              aria-hidden="true"
              className="grid h-7 w-7 place-items-center rounded-md bg-ink text-[0.8125rem] font-bold text-ink-inverse"
            >
              F
            </span>
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
          <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-ink-muted">{subtitle}</p> : null}
          {children}
          {footer ? <div className="mt-6 text-center text-sm text-ink-muted">{footer}</div> : null}
        </div>
      </div>
    </div>
  )
}
