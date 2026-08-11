import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../lib/authContext'
import { AuthLayout, authInputClass } from './AuthLayout'

/* Where the email link from SignInForm's "Send link" actually lands. The
 * token in the URL is the credential — there is no session yet, so this
 * page has to work fully signed out, and submitting logs the teacher
 * straight in (see AuthProvider.resetPassword / routes/auth.py's
 * /reset-password, which sets the same cookie /login does). */
export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') || ''
  const navigate = useNavigate()
  const { resetPassword } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (password.length < 8) {
      setError('Use at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Those two don’t match.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      await resetPassword(token, password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err.message || 'That link didn’t work.')
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Reset your password">
        <p className="mt-6 text-sm text-ink-soft">
          This link is missing its token — open the one from the email again, or{' '}
          <a href="/login" className="font-medium text-accent-text underline underline-offset-4">
            request a new one
          </a>
          .
        </p>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Set a new password" subtitle="This link works once, for one hour.">
      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        {error ? (
          <p
            role="alert"
            className="fa-rise rounded-lg border border-mark/25 bg-mark-tint px-3 py-2 text-sm text-mark"
          >
            {error}
          </p>
        ) : null}
        <div>
          <label className="visually-hidden" htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password"
            className={authInputClass}
          />
        </div>
        <div>
          <label className="visually-hidden" htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm new password"
            className={authInputClass}
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="mt-1 min-h-touch w-full rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-ink-inverse transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Saving…' : 'Set password and sign in'}
        </button>
      </form>
    </AuthLayout>
  )
}
