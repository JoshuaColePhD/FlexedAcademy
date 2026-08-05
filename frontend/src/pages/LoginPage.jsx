import { useState } from 'react'
import { GoogleLogin } from '@react-oauth/google'
import { BookOpen, Clock, LayoutDashboard } from 'lucide-react'
import { useAuth } from '../lib/authContext'

export default function LoginPage() {
  const { login, loginWithGoogle } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleEmailLogin = async (e) => {
    e.preventDefault()
    if (!email || !password) {
      setError('Please enter both email and password.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err.message || 'Login failed')
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
      setError(err.message || 'Google login failed')
      setLoading(false)
    }
  }

  const handleGoogleError = () => {
    setError('Google login was unsuccessful. Please try again.')
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-gradient-to-br from-indigo-50 via-white to-purple-50">
      <div className="mx-auto flex max-w-4xl overflow-hidden rounded-3xl bg-white shadow-2xl shadow-indigo-100/50 sm:flex-row flex-col">
        {/* Left Side: Value Propositions */}
        <div className="flex flex-col justify-center bg-indigo-50/50 p-12 sm:w-[480px]">
          <div className="mb-8 flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 font-bold text-white shadow-sm">
              F
            </div>
            <span className="text-xl font-bold tracking-tight text-gray-900">FlexedAcademy</span>
          </div>

          <h2 className="mb-8 text-3xl font-bold tracking-tight text-gray-900">
            Welcome to FlexedAcademy
          </h2>

          <div className="space-y-6">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Rigorous, standards-aligned</h3>
                <p className="text-sm text-gray-500">
                  Generate lesson plans perfectly mapped to state standards and pacing guides.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
                <Clock className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Save hours every week</h3>
                <p className="text-sm text-gray-500">
                  Automate the heavy lifting of curriculum planning so you can focus on teaching.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
                <LayoutDashboard className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900">Instant slide decks</h3>
                <p className="text-sm text-gray-500">
                  Turn any lesson plan into a complete, ready-to-present slide deck in seconds.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Login Form */}
        <div className="flex flex-col justify-center p-12 sm:w-[400px]">
          <div className="text-center">
            <h3 className="mb-2 text-2xl font-bold text-gray-900">Log in</h3>
            <p className="mb-8 text-sm text-gray-500">Sign in to your account to continue</p>
          </div>

          <div className="mb-6 flex justify-center">
            <GoogleLogin
              onSuccess={handleGoogleSuccess}
              onError={handleGoogleError}
              theme="outline"
              size="large"
              width="100%"
              text="continue_with"
              shape="rectangular"
            />
          </div>

          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-200"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-white px-2 text-gray-500">Or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleEmailLogin} className="space-y-4">
            {error && (
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">
                {error}
              </div>
            )}
            <div>
              <label className="sr-only" htmlFor="email">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                className="block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm placeholder-gray-400 outline-none transition-colors focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
              />
            </div>
            <div>
              <label className="sr-only" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                className="block w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm placeholder-gray-400 outline-none transition-colors focus:border-indigo-600 focus:ring-1 focus:ring-indigo-600"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="mt-2 w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2 disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign in with Email'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
