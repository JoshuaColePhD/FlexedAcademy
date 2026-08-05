import { createContext, useContext } from 'react'

/** { status: 'loading' | 'authed' | 'anon', user: {id,email,name}|null,
 *    login, signup, logout, refresh } — see AuthProvider.jsx for the implementation. */
export const AuthContext = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() called outside <AuthProvider>')
  return ctx
}
