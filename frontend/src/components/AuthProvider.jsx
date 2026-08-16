import { useCallback, useEffect, useState } from 'react'
import { AuthContext, EXPLICIT_SIGNOUT_KEY, KNOWN_AUTHED_KEY } from '../lib/authContext'
import { api } from '../lib/api'

function setAuthedState(val) {
  try {
    if (val) localStorage.setItem(KNOWN_AUTHED_KEY, '1')
    else localStorage.removeItem(KNOWN_AUTHED_KEY)
  } catch {
    // ignore
  }
}

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('loading') // 'loading' | 'authed' | 'anon'
  const [user, setUser] = useState(null)

  const refresh = useCallback(() => {
    return api
      .me()
      .then((u) => {
        setUser(u)
        setStatus('authed')
        setAuthedState(true)
        // Returned, not swallowed: callers that need the *fresh* answer (the
        // return-from-checkout poll) can read it without racing React state.
        return u
      })
      .catch(() => {
        setUser(null)
        setStatus('anon')
        setAuthedState(false)
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
      setAuthedState(false)
    }
    window.addEventListener('aplang:unauthorized', onUnauthorized)
    return () => window.removeEventListener('aplang:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (email, password) => {
    const u = await api.login(email, password)
    setUser(u)
    setStatus('authed')
    setAuthedState(true)
    return u
  }, [])

  const loginWithGoogle = useCallback(async (credential) => {
    const u = await api.loginWithGoogle(credential)
    setUser(u)
    setStatus('authed')
    setAuthedState(true)
    return u
  }, [])

  const signup = useCallback(async (name, email, password) => {
    const u = await api.signup(name, email, password)
    setUser(u)
    setStatus('authed')
    setAuthedState(true)
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
    setAuthedState(true)
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
      setAuthedState(false)
    }
  }, [])

  /* Same shape as logout — this device's cookie stops working too (its "sv"
     no longer matches, per backend/deps.py), so it has to end up in the same
     anon state, not just "every OTHER device." */
  const signOutEverywhere = useCallback(async () => {
    try {
      sessionStorage.setItem(EXPLICIT_SIGNOUT_KEY, '1')
    } catch {
      /* Not available — same fallback as logout() above. */
    }
    try {
      await api.signOutEverywhere()
    } finally {
      setUser(null)
      setStatus('anon')
      setAuthedState(false)
    }
  }, [])

  /* NOT the same try/finally shape as logout/signOutEverywhere above — a
     wrong password must stay a normal thrown error with the account intact,
     not flip to anon regardless. Only a request that actually succeeded
     (the account is genuinely gone server-side) should end the session
     client-side, so the state flip happens after the await, not in a
     finally that runs either way. */
  const deleteAccount = useCallback(async (password) => {
    await api.deleteAccount(password)
    try {
      sessionStorage.setItem(EXPLICIT_SIGNOUT_KEY, '1')
    } catch {
      /* Not available — same fallback as logout() above. */
    }
    setUser(null)
    setStatus('anon')
    setAuthedState(false)
  }, [])

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        login,
        loginWithGoogle,
        signup,
        resetPassword,
        logout,
        signOutEverywhere,
        deleteAccount,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
