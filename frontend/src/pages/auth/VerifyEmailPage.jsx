import { useEffect, useState } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../../lib/authContext'
import { AuthLayout } from './AuthLayout'

export default function VerifyEmailPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { verifyEmail } = useAuth()
  const [state, setState] = useState({ status: 'loading', error: '' })
  const token = params.get('token') || ''

  useEffect(() => {
    if (!token) {
      setState({ status: 'error', error: 'This verification link is missing its token.' })
      return
    }
    let active = true
    verifyEmail(token)
      .then(() => {
        if (active) {
          setState({ status: 'success', error: '' })
          navigate('/', { replace: true })
        }
      })
      .catch((error) => {
        if (active) setState({ status: 'error', error: [error?.message, error?.hint].filter(Boolean).join(' ') })
      })
    return () => { active = false }
  }, [navigate, token, verifyEmail])

  if (state.status === 'loading') {
    return <AuthLayout title="Verifying your email" subtitle="Starting your free week…"><p className="mt-6 text-sm text-ink-muted">One moment.</p></AuthLayout>
  }
  if (state.status === 'success') {
    return <AuthLayout title="Email verified"><p className="mt-6 text-sm text-ink-muted">You’re signed in. Taking you to FlexEd Academy…</p></AuthLayout>
  }
  return (
    <AuthLayout title="Verification link unavailable">
      <p className="mt-6 text-sm text-mark">{state.error || 'That link could not be verified.'}</p>
      <Link to="/signup" className="mt-5 inline-block text-sm font-medium text-accent-text underline">Create a new account</Link>
    </AuthLayout>
  )
}

