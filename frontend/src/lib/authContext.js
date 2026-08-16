import { createContext, useContext } from 'react'

/** { status: 'loading' | 'authed' | 'anon', user: {id,email,name}|null,
 *    login, signup, resetPassword, logout, signOutEverywhere, deleteAccount,
 *    refresh } — see AuthProvider.jsx for the implementation. */
export const AuthContext = createContext(null)

/** Set by AuthProvider.logout() just before it signs out, read once by Gate
 *  (App.jsx) to tell an explicit sign-out apart from a session that expired
 *  mid-use — the two should land somewhere different. sessionStorage, not a
 *  ref or module-level variable: Gate and AuthProvider don't share a parent
 *  that could hold state above both of them without either drilling it
 *  through every consumer of useAuth() or (worse) making AuthContext itself
 *  carry routing concerns. */
export const EXPLICIT_SIGNOUT_KEY = 'aplang:explicit-signout'
export const KNOWN_AUTHED_KEY = 'aplang:known-authed'

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() called outside <AuthProvider>')
  return ctx
}
