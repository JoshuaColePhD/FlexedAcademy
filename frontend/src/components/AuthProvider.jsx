import { useCallback, useEffect, useState } from 'react'
import { AuthContext, EXPLICIT_SIGNOUT_KEY } from '../lib/authContext'
import { api } from '../lib/api'

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading') // 'loading' | 'authed' | 'anon'
  const [user, setUser] = useState(null)

  const refresh = useCallback(() => {
    return api
      .me()
      .then((u) => {
        setUser(u)
        setStatus('authed')
        // Returned, not swallowed: callers that need the *fresh* answer (the
        // return-from-checkout poll) can read it without racing React state.
        return u
      })
      .catch(() => {
        setUser(null)
        setStatus('anon')
        return null
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // A session expiring mid-use surfaces as a 401 from whatever request hit it
  // first — api.js dispatches this once, globally, instead of every page
  // needing its own "you got logged out" handling.
  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null)
      setStatus('anon')
    }
    window.addEventListener('aplang:unauthorized', onUnauthorized)
    return () => window.removeEventListener('aplang:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (email, password) => {
    const u = await api.login(email, password)
    setUser(u)
    setStatus('authed')
    return u
  }, [])

  const loginWithGoogle = useCallback(async (credential) => {
    const u = await api.loginWithGoogle(credential)
    setUser(u)
    setStatus('authed')
    return u
  }, [])

  const signup = useCallback(async (name, email, password) => {
    const u = await api.signup(name, email, password)
    setUser(u)
    setStatus('authed')
    return u
  }, [])

  // /api/auth/reset-password logs the account in directly (same cookie the
  // login route sets) — a reset link that dropped you into a second sign-in
  // form would be one more thing standing between "forgot password" and
  // actually building a plan.
  const resetPassword = useCallback(async (token, password) => {
    const u = await api.resetPassword(token, password)
    setUser(u)
    setStatus('authed')
    return u
  }, [])

  const logout = useCallback(async () => {
    /* A flag, not a navigate() call: navigate() and the status flip below
       land in separate commits (the router's own location state and React's
       don't actually batch together), so Gate would render once with the new
       status but the OLD location, and its wildcard route already redirects
       to /login?next=<that old path> before the location update ever lands.
       Gate reads this flag itself once it sees status go anon — see Gate in
       App.jsx — which sidesteps the ordering question entirely. */
    try {
      sessionStorage.setItem(EXPLICIT_SIGNOUT_KEY, '1')
    } catch {
      /* Not available — worst case this falls back to the next-preserving
         redirect, same as a session that expired mid-use. */
    }
    try {
      await api.logout()
    } finally {
      setUser(null)
      setStatus('anon')
    }
  }, [])

  return (
    <AuthContext.Provider
      value={{ status, user, login, loginWithGoogle, signup, resetPassword, logout, refresh }}
    >
      {children}
    </AuthContext.Provider>
  )
}
