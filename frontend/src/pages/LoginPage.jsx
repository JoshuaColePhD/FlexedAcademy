import { useState } from 'react'
import { GoogleLogin } from '@react-oauth/google'
import { CalendarDays, FileCheck2, Quote } from 'lucide-react'
import { useAuth } from '../lib/authContext'

/* The first screen a teacher sees.
 *
 * It was built in a palette of its own — indigo-600, purple-50, gray-900, all
 * raw Tailwind — so it ignored the design tokens and dark mode entirely and read
 * as a different product from the app behind it. Everything here now goes
 * through the tokens, which means it follows the theme and the district blue
 * like every other surface.
 *
 * The three claims were also generic SaaS copy, one of which ("Instant slide
 * decks") this app does not do. They are now the things that are actually true
 * and actually unusual: standards quoted rather than recalled, the real school
 * calendar, and the district's own template.
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
    body: 'Weeks come from the Florence City Schools calendar, so Fall Break never gets five days of lessons.',
  },
  {
    icon: FileCheck2,
    title: 'The district’s own template',
    body: 'Plans come out as the Florence City Schools .docx, ready to hand in without reformatting.',
  },
]

const inputClass =
  'block w-full rounded-lg border border-edge bg-paper-raised px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent'

export default function LoginPage() {
  const { login, loginWithGoogle } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleEmailLogin = async (e) => {
    e.preventDefault()
    if (!email || !password) {
      setError('Enter your email and password.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err.message || 'That email and password didn’t match an account.')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleSuccess = async (credentialResponse) => {
    setError(null)
    setLoading(true)
    try {
      await loginWithGoogle(credentialResponse.credential)
    } catch (err) {
      setError(err.message || 'Google sign-in didn’t complete.')
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-paper p-5">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-edge bg-paper-raised shadow-lg md:grid-cols-[1.1fr_1fr]">
        {/* ── what this is ─────────────────────────────────────────────── */}
        <div className="flex flex-col justify-center gap-7 border-b border-edge bg-paper-sunken p-8 md:border-b-0 md:border-r md:p-10">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid h-7 w-7 place-items-center rounded-md bg-accent text-[0.8125rem] font-bold text-ink-inverse"
            >
              F
            </span>
            <span className="text-sm font-semibold tracking-tight text-ink">Flexed Academy</span>
          </div>

          <h1 className="text-2xl font-semibold leading-snug tracking-tight text-ink">
            A week of lesson plans,
            <br />
            grounded in the real standards.
          </h1>

          <ul className="flex flex-col gap-5">
            {CLAIMS.map(({ icon: Icon, title, body }) => (
              <li className="flex items-start gap-3" key={title}>
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-paper-raised text-accent"
                >
                  <Icon size={16} />
                </span>
                <span>
                  <span className="block text-sm font-medium text-ink">{title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* ── sign in ──────────────────────────────────────────────────── */}
        <div className="flex flex-col justify-center p-8 md:p-10">
          <h2 className="text-lg font-semibold tracking-tight text-ink">Sign in</h2>
          <p className="mt-1 text-sm text-ink-muted">Use your school Google account or an email.</p>

          <div className="mt-6 flex justify-center">
            <GoogleLogin
              onSuccess={handleGoogleSuccess}
              onError={() => setError('Google sign-in didn’t complete. Try again.')}
              theme="outline"
              size="large"
              width="100%"
              text="continue_with"
              shape="rectangular"
            />
          </div>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-edge" />
            <span className="text-xs text-ink-muted">or</span>
            <span className="h-px flex-1 bg-edge" />
          </div>

          <form onSubmit={handleEmailLogin} className="flex flex-col gap-3">
            {error ? (
              <p
                role="alert"
                className="rounded-lg border border-mark/25 bg-mark-tint px-3 py-2 text-sm text-mark"
              >
                {error}
              </p>
            ) : null}

            <div>
              <label className="visually-hidden" htmlFor="email">
                Email address
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                className={inputClass}
              />
            </div>
            <div>
              <label className="visually-hidden" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className={inputClass}
              />
            </div>

            {/* --ink, not --accent: a filled accent button with a white label
                is the one pairing the token rules forbid outright. */}
            <button
              type="submit"
              disabled={loading}
              className="mt-1 w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
