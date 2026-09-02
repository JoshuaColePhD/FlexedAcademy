import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, Lock, Mail, X } from 'lucide-react'
import { useAuth } from '../lib/authContext'
import { api } from '../lib/api'
import { GoogleAuthButton } from './GoogleAuthButton'

/* This form's own explicit palette, not the app's ink/paper/accent tokens —
 * a deliberate exception. Both places this renders (the landing page's
 * popover, wrapped in .neo-world; /login, wrapped in .auth-ground.neo-world)
 * silently override those tokens to the cream/rose emboss world, which is
 * WHY the previous version looked washed out here regardless of what colors
 * this file asked for: neo-world's own primitives are declared later in
 * base.css than either wrapper's attempt to pin them back to blue, so
 * neo-world always won the cascade. Hardcoding real colors is what makes
 * this form look the same — crisp, high-contrast, actually blue — no matter
 * which world it's dropped into, instead of inheriting whatever that world
 * has decided "ink" and "accent" mean today.
 */
const fieldClass =
  'block w-full rounded-xl border border-slate-200 bg-white py-3 pl-11 text-sm text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15'

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
  const { login, loginDemo, loginWithGoogle } = useAuth()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [resetEmail, setResetEmail] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [resetError, setResetError] = useState(null)
  const [resetLoading, setResetLoading] = useState(false)
  const [verificationNeeded, setVerificationNeeded] = useState(false)
  const [verificationSent, setVerificationSent] = useState(false)
  const [verificationLoading, setVerificationLoading] = useState(false)
  const [demoEnabled, setDemoEnabled] = useState(false)
  const [demoLoading, setDemoLoading] = useState(false)

  useEffect(() => {
    let active = true
    api.demoAvailability().then((result) => {
      if (active) setDemoEnabled(Boolean(result?.enabled))
    }).catch(() => {})
    return () => { active = false }
  }, [])

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
    setVerificationNeeded(false)
    setVerificationSent(false)
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err.message || 'That email and password didn’t match an account.')
      setVerificationNeeded(err?.code === 'email_not_verified')
    } finally {
      setLoading(false)
    }
  }

  const handleResendVerification = async () => {
    setVerificationLoading(true)
    try {
      await api.resendVerification(email)
      setVerificationSent(true)
    } catch (err) {
      setError(err?.message || 'Could not resend the verification email.')
    } finally {
      setVerificationLoading(false)
    }
  }

  const handleForgotPassword = async (e) => {
    e.preventDefault()
    if (!resetEmail) return
    setResetLoading(true)
    setResetError(null)
    try {
      await api.forgotPassword(resetEmail)
      setResetSent(true)
    } catch (err) {
      /* setResetSent(true) used to live in `finally`, so the form was replaced
         by "we've sent a link to reset its password" even when the request had
         failed — and resetSent was never set back, so the input was gone and
         there was no way to retry a typo or a failed send without reloading.
         The old comment argued nothing more was worth clicking. What actually
         reaches this catch is a 20s timeout against a ~50s cold start, a
         network error, or a 429 from the route's 5/minute limit — and in every
         one of those "click again" is exactly the right next move. */
      setResetError(err?.hint || err?.message || 'Could not send that link. Try again.')
    } finally {
      setResetLoading(false)
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

  const handleDemoLogin = async () => {
    setError(null)
    setDemoLoading(true)
    try {
      await loginDemo()
    } catch (err) {
      setError(err.message || 'The demo is temporarily unavailable.')
    } finally {
      setDemoLoading(false)
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
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-xl font-bold text-slate-900">Welcome back</h3>
            <p className="mt-0.5 text-sm text-slate-500">Sign in to keep planning.</p>
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            >
              <X size={18} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      {demoEnabled ? (
        <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-3 text-sm text-blue-900">
          <div className="font-semibold">Explore demo</div>
          <p className="mt-0.5 text-blue-800">See the product with seeded plans, citations, and exports—no payment or local setup required.</p>
          <button
            type="button"
            onClick={handleDemoLogin}
            disabled={demoLoading || loading}
            className="mt-2 min-h-touch w-full rounded-lg bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {demoLoading ? 'Opening demo…' : 'Explore demo (read-only)'}
          </button>
        </div>
      ) : null}

      <div className="flex justify-center">
        <GoogleAuthButton
          onSuccess={handleGoogleSuccess}
          onError={() => setError('Google sign-in didn’t complete. Try again.')}
          size={compact ? 'medium' : 'large'}
          text="continue_with"
        />
      </div>

      <div className={`flex items-center gap-3 ${compact ? 'my-5' : 'my-6'}`}>
        <span className="h-px flex-1 bg-slate-200" />
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">or</span>
        <span className="h-px flex-1 bg-slate-200" />
      </div>

      <form onSubmit={handleEmailLogin} className="flex flex-col gap-3">
        {error ? (
          <p
            role="alert"
            className="fa-rise rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
        {verificationNeeded ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
            {verificationSent ? 'A new verification link is on its way.' : (
              <button type="button" className="font-medium underline underline-offset-2" disabled={verificationLoading} onClick={handleResendVerification}>
                {verificationLoading ? 'Sending…' : 'Send the verification email again'}
              </button>
            )}
          </div>
        ) : null}

        <div className="relative">
          <label className="visually-hidden" htmlFor={`${idPrefix}email`}>Email address</label>
          <Mail
            size={18}
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            id={`${idPrefix}email`}
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            className={`${fieldClass} pr-3.5`}
          />
        </div>
        <div className="relative">
          <label className="visually-hidden" htmlFor={`${idPrefix}password`}>Password</label>
          <Lock
            size={18}
            aria-hidden="true"
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            id={`${idPrefix}password`}
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className={`${fieldClass} pr-11`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            title={showPassword ? 'Hide password' : 'Show password'}
            className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </button>
        </div>

        {/* Solid blue + white label — the app's own tokens forbid this
            EXACT pairing elsewhere because their --accent used to be an
            orange that failed contrast as a fill (see base.css's
            .btn-primary comment); this is a plain, explicit blue chosen
            for this form alone, verified against white at a real 6:1+. */}
        <button
          type="submit"
          disabled={loading}
          className="mt-1 min-h-touch w-full rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
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
        <summary className="cursor-pointer text-slate-500 underline decoration-slate-300 underline-offset-4 hover:text-slate-900">
          Forgot your password?
        </summary>
        <div className="fa-rise mt-3 flex flex-col gap-2 rounded-xl bg-slate-50 p-3 text-slate-600">
          <p>
            If your email is a Google account — including a school one —{' '}
            <strong className="font-semibold text-slate-900">Continue with Google</strong> above will
            sign you into the same account, password or not. Everything you’ve built is still there.
          </p>
          {resetSent ? (
            <p className="fa-rise">
              If <strong className="font-semibold text-slate-900">{resetEmail}</strong> has an
              account, we’ve sent a link to reset its password. It works for one hour.
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
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    id={`${idPrefix}reset-email`}
                    type="email"
                    required
                    autoComplete="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    placeholder="Email address"
                    className="block w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-sm text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15"
                  />
                </div>
                <button
                  type="submit"
                  disabled={resetLoading}
                  className="shrink-0 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resetLoading ? 'Sending…' : 'Send link'}
                </button>
              </div>
              {/* The form stays on screen with the address still in it, so a
                  failed send is one more click rather than a page reload. */}
              {resetError ? (
                <p role="alert" className="text-sm text-red-600">
                  {resetError}
                </p>
              ) : null}
            </form>
          )}
        </div>
      </details>

      <p className="mt-4 text-center text-sm text-slate-500">
        New here?{' '}
        <Link to={signupHref} className="font-semibold text-blue-600 underline underline-offset-4 hover:text-blue-700">
          Create an account
        </Link>
      </p>
    </div>
  )
}
