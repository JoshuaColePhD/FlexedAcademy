import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, Lock, Mail, X } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { api } from '../lib/api'
import { GoogleAuthButton } from './GoogleAuthButton'

/* Local to this form, not a variant of the shared authInputClass (used
   as-is by SignupPage/ResetPasswordPage — this redesign is scoped to
   sign-in, not every auth form) — and built with explicit pl/pr rather
   than overriding authInputClass's own px-3.5 with a bolted-on pl-10.
   Tailwind resolves two classes touching the same property (px-3.5 and
   pl-10) by which one the generated stylesheet happens to place last, not
   by which comes last in the className string — a real footgun, not a
   style preference, so this just never creates the conflict. */
const iconInputClass =
  'block w-full rounded-lg border border-edge bg-paper-raised py-2.5 pl-10 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-accent neo-inset'

/* The actual sign-in mechanics — Google button, divider, email/password
 * form, the "forgot password" disclosure and the "create an account" link —
 * shared between the full /login page and the landing page's inline
 * popover. One place that calls login()/loginWithGoogle() rather than two
 * copies that drift the moment one of them gets a fix the other doesn't.
 *
 * `idPrefix` keeps the email/password <label htmlFor> pairs unique when
 * this renders twice in the same document (the popover can mount while
 * /login's own form is, in theory, also in the tree via back/forward cache).
 * `compact` only tightens vertical spacing — the popover has less room than
 * a full page — never drops a field or a link; a "quick" sign-in that's
 * secretly missing "Forgot your password?" is a support ticket waiting to
 * happen.
 *
 * `onClose`: only meaningful (and only rendered as a button) when compact —
 * the full /login page has no "close" concept, it's a whole page, and
 * AuthLayout already gives it a way back (the wordmark link). The popover
 * had no way to dismiss it besides Escape, an outside click, or tabbing
 * past the last field — real but undiscoverable; a visible close button is
 * the same affordance every other dismissible panel in this app has.
 */
export function SignInForm({ compact = false, idPrefix = '', onClose }) {
  const { login, loginWithGoogle } = useAuth()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)

  // Preserved across the round trip so a bookmarked /c/x/week/12 with an expired
  // cookie lands back on that week instead of dumping the teacher at the top.
  const next = params.get('next')
  const signupHref = next ? `/signup?next=${encodeURIComponent(next)}` : '/signup'

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

  const handleForgotPassword = async (e) => {
    e.preventDefault()
    if (!resetEmail) return
    setResetLoading(true)
    try {
      await api.forgotPassword(resetEmail)
    } catch {
      // The backend already answers the same {ok:true} whether or not the
      // email has an account — a request-level failure (network, 500) is the
      // only thing that reaches here, and it isn't worth a different message
      // than the success one: either way there's nothing more to click.
    } finally {
      setResetLoading(false)
      setResetSent(true)
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
    <div className="flex flex-col">
      {/* Compact-only: the full /login page already has its own "Sign in"
          heading via AuthLayout's title prop, rendered above {children}
          (this form). Repeating it here would be two headings stacked for
          one form; the popover has neither, so it opened straight into a
          Google button with zero context. */}
      {compact ? (
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-ink">Welcome back</h3>
            <p className="text-xs text-ink-muted">Sign in to keep planning.</p>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="btn-icon -mr-1.5 -mt-1 shrink-0"
            >
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* GoogleAuthButton: filled_black + the same raised-shadow frame every
          other control in this world has, matching the "Sign in" button
          just below it instead of clashing with it as a plain white box —
          see that component's own comment for why it measures its own
          width instead of the "100%" this used to pass straight through. */}
      <div className="flex justify-center">
        <GoogleAuthButton
          onSuccess={handleGoogleSuccess}
          onError={() => setError('Google sign-in didn’t complete. Try again.')}
          size={compact ? 'medium' : 'large'}
          text="continue_with"
        />
      </div>

      <div className={`flex items-center gap-3 ${compact ? 'my-4' : 'my-6'}`}>
        <span className="h-px flex-1 bg-edge" />
        <span className="text-xs text-ink-muted">or</span>
        <span className="h-px flex-1 bg-edge" />
      </div>

      <form onSubmit={handleEmailLogin} className="flex flex-col gap-3">
        {error ? (
          <p
            role="alert"
            className="fa-rise rounded-lg border border-mark/25 bg-mark-tint px-3 py-2 text-sm text-mark"
          >
            {error}
          </p>
        ) : null}

        <div className="relative">
          <label className="visually-hidden" htmlFor={`${idPrefix}email`}>Email address</label>
          <Mail
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            id={`${idPrefix}email`}
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            className={`${iconInputClass} pr-3.5`}
          />
        </div>
        <div className="relative">
          <label className="visually-hidden" htmlFor={`${idPrefix}password`}>Password</label>
          <Lock
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            id={`${idPrefix}password`}
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className={`${iconInputClass} pr-10`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            title={showPassword ? 'Hide password' : 'Show password'}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-faint transition-colors hover:text-ink-soft"
          >
            {showPassword ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          </button>
        </div>

        {/* --ink, not --accent: a filled accent button with a white label is the
            one pairing the token rules forbid outright. */}
        <button
          type="submit"
          disabled={loading}
          className="neo-raised mt-1 min-h-touch w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {/* Two real recovery paths, not one consolation. The first paragraph:
          routes/auth.py's /google handler looks the account up by EMAIL and
          signs you into it whether or not it has a password_hash — any
          address that's a Google account (a school Workspace one, usually)
          recovers itself through the button above, no email required. The
          second is the actual reset link, via Resend — see backend/mail.py.

          Deliberately no contact address here. This form is public, and a
          personal inbox published on it is spam bait and hard to take back. */}
      <details className={compact ? 'mt-4 text-sm' : 'mt-5 text-sm'}>
        <summary className="cursor-pointer text-ink-muted underline underline-offset-4 hover:text-ink">
          Forgot your password?
        </summary>
        <div className="fa-rise mt-2.5 flex flex-col gap-2 rounded-lg bg-paper-sunken p-3 text-ink-soft">
          <p>
            If your email is a Google account — including a school one —{' '}
            <strong className="font-medium text-ink">Continue with Google</strong> above will sign
            you into the same account, password or not. Everything you’ve built is still there.
          </p>
          {resetSent ? (
            <p className="fa-rise">
              If <strong className="font-medium text-ink">{resetEmail}</strong> has an account,
              we’ve sent a link to reset its password. It works for one hour.
            </p>
          ) : (
            <form onSubmit={handleForgotPassword} className="flex flex-col gap-2">
              <p>Otherwise, get a reset link emailed to you:</p>
              <div className="flex gap-2">
                <label className="sr-only" htmlFor={`${idPrefix}reset-email`}>
                  Email address
                </label>
                <div className="relative min-w-0 flex-1">
                  <Mail
                    size={16}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-faint"
                  />
                  <input
                    id={`${idPrefix}reset-email`}
                    type="email"
                    required
                    autoComplete="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    placeholder="Email address"
                    className={`${iconInputClass} pr-3.5`}
                  />
                </div>
                <button
                  type="submit"
                  disabled={resetLoading}
                  className="neo-raised shrink-0 rounded-lg bg-ink px-3 text-sm font-medium text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resetLoading ? 'Sending…' : 'Send link'}
                </button>
              </div>
            </form>
          )}
        </div>
      </details>

      <p className="mt-4 text-center text-sm text-ink-muted">
        New here?{' '}
        <Link to={signupHref} className="font-medium text-accent-text underline underline-offset-4">
          Create an account
        </Link>
      </p>
    </div>
  )
}
