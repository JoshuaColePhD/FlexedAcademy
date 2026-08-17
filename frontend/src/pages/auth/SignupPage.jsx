import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../lib/authContext'
import { AuthLayout, authInputClass } from './AuthLayout'
import { GoogleAuthButton } from '../../components/GoogleAuthButton'

/* POST /api/auth/signup has existed since the multi-tenant work, api.signup has
 * existed, AuthProvider.signup has existed — and nothing called any of them.
 * There was no way to create an account in a product whose whole pivot was
 * "other teachers can use this". */
export default function SignupPage() {
  const { signup, loginWithGoogle } = useAuth()
  const [params] = useSearchParams()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const next = params.get('next')
  const loginHref = next ? `/login?next=${encodeURIComponent(next)}` : '/login'

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (password.length < 8) {
      setError('Use at least 8 characters for the password.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      await signup(name.trim(), email.trim(), password)
    } catch (err) {
      setError(err.message || 'Could not create that account.')
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleSuccess = async (credentialResponse) => {
    setError(null)
    setLoading(true)
    try {
      // /api/auth/google creates the user if the email is new, so Google is
      // both the sign-in and the sign-up path — no separate branch needed.
      await loginWithGoogle(credentialResponse.credential)
    } catch (err) {
      setError(err.message || 'Google sign-in didn’t complete.')
      setLoading(false)
    }
  }

  return (
    <AuthLayout
      title="Create an account"
      subtitle="Then set up your first class — it takes two picks."
      footer={
        <>
          Already have an account?{' '}
          <Link to={loginHref} className="font-medium text-accent-text underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      {/* GoogleAuthButton — same reasoning as SignInForm's own version:
          neo-raised frame to match this page's embossed world (AuthLayout
          wears .neo-world), and a real measured pixel width handed to
          Google instead of the "100%" that doesn't mean anything to its
          own API. */}
      <div className="mt-6 flex justify-center">
        <GoogleAuthButton
          onSuccess={handleGoogleSuccess}
          onError={() => setError('Google sign-in didn’t complete. Try again.')}
          size="large"
          text="signup_with"
        />
      </div>

      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-edge" />
        <span className="text-xs text-ink-muted">or</span>
        <span className="h-px flex-1 bg-edge" />
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {error ? (
          <p
            role="alert"
            className="fa-rise rounded-lg border border-mark/25 bg-mark-tint px-3 py-2 text-sm text-mark"
          >
            {error}
          </p>
        ) : null}

        <div>
          <label className="visually-hidden" htmlFor="name">Your name</label>
          <input
            id="name"
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            className={authInputClass}
          />
        </div>
        <div>
          <label className="visually-hidden" htmlFor="signup-email">Email address</label>
          <input
            id="signup-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            className={authInputClass}
          />
        </div>
        <div>
          <label className="visually-hidden" htmlFor="signup-password">Password</label>
          <input
            id="signup-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (8 characters or more)"
            className={authInputClass}
          />
        </div>

        <p className="text-xs text-ink-muted">
          By creating an account, you agree to our{' '}
          <Link to="/terms" className="text-accent-text hover:underline">
            Terms
          </Link>{' '}
          and{' '}
          <Link to="/privacy" className="text-accent-text hover:underline">
            Privacy Policy
          </Link>
          .
        </p>

        <button
          type="submit"
          disabled={loading}
          className="mt-1 min-h-touch w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  )
}
