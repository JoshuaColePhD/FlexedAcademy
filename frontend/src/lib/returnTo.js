/* Keep post-auth destinations same-origin and path-only. Shared links and
 * expired-session redirects both use this value, so one small helper keeps
 * every handoff free of open-redirect surprises. */
export function safeReturnTo(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.startsWith('/') && !trimmed.startsWith('//') ? trimmed : null
}

export function withReturnTo(path, returnTo) {
  const safe = safeReturnTo(returnTo)
  return safe ? `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(safe)}` : path
}
