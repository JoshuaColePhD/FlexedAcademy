import { useCallback, useEffect, useState } from 'react'
import { AuthContext } from '../lib/authContext'
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

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } finally {
      setUser(null)
      setStatus('anon')
    }
  }, [])

  return (
    <AuthContext.Provider value={{ status, user, login, loginWithGoogle, signup, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}
