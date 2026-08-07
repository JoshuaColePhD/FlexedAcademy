import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { GoogleLogin } from '@react-oauth/google'
import { useAuth } from '../../lib/authContext'
import { AuthLayout, authInputClass } from './AuthLayout'

export default function LoginPage() {
  const { login, loginWithGoogle } = useAuth()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

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
    <AuthLayout
      title="Sign in"
      subtitle="Use your school Google account or an email."
      footer={
        <>
          New here?{' '}
          <Link to={signupHref} className="font-medium text-accent-text underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
    >
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
          <p role="alert" className="rounded-lg border border-mark/25 bg-mark-tint px-3 py-2 text-sm text-mark">
            {error}
          </p>
        ) : null}

        <div>
          <label className="visually-hidden" htmlFor="email">Email address</label>
          <input
            id="email"
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
          <label className="visually-hidden" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className={authInputClass}
          />
        </div>

        {/* --ink, not --accent: a filled accent button with a white label is the
            one pairing the token rules forbid outright. */}
        <button
          type="submit"
          disabled={loading}
          className="mt-1 min-h-touch w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {/* There is no self-serve password reset — the backend cannot send email,
          so there is no link to deliver. Without this block a teacher who
          forgot their password had no "Forgot password?" to click, no
          explanation, and no route back into their own plans.

          The first paragraph is a REAL recovery path, not a consolation:
          routes/auth.py's /google handler looks the account up by EMAIL and
          signs you into it whether or not it has a password_hash. So any
          address that is a Google account — which for teachers usually means
          their school Workspace one — recovers itself through the button
          directly above. That covers most of the cases this page was silently
          failing, and it needs no email infrastructure at all.

          Deliberately no contact address here. This page is public, and a
          personal inbox published on it is spam bait and hard to take back.
          When there is a real support alias, or a token flow to deliver, that
          is what belongs in the second paragraph. */}
      <details className="mt-5 text-sm">
        <summary className="cursor-pointer text-ink-muted underline underline-offset-4 hover:text-ink">
          Forgot your password?
        </summary>
        <div className="mt-2.5 flex flex-col gap-2 rounded-lg bg-paper-sunken p-3 text-ink-soft">
          <p>
            If your email is a Google account — including a school one —{' '}
            <strong className="font-medium text-ink">Continue with Google</strong> above will sign
            you into the same account, password or not. Everything you’ve built is still there.
          </p>
          <p>
            If it isn’t, there’s no self-serve reset yet. Nothing has been lost — your plans stay
            on your account until you can get back into it.
          </p>
        </div>
      </details>
    </AuthLayout>
  )
}
