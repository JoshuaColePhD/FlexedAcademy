/* Turning a thrown error into user-facing text, in exactly one place.

   The backend goes to real trouble to attach an actionable `hint` to every error
   — "Run: python scripts/02_embed_store.py", "Drop the grade from the request",
   "Is the backend running? Start it with ./run.sh". Six of the thirteen call
   sites then threw it away and showed only `err.message`, so the teacher got
   "Request failed (502)" when the app knew how to fix it.

   The fix isn't to remember harder at each site; it's to make the hint arrive
   with the message so there's no separate thing to forget. */

/** The message and hint, never dropping one and never inventing either. */
export function errorParts(err, fallback = 'The request failed.') {
  const message = (err && err.message) || fallback
  const hint = (err && err.hint) || ''
  // A hint that merely restates the message is noise in a toast.
  return { message, hint: hint && hint !== message ? hint : '' }
}

/** One string, for the places that only have room for one (aria-label, title). */
export function errorText(err, fallback) {
  const { message, hint } = errorParts(err, fallback)
  return hint ? `${message} ${hint}` : message
}

export function isNetworkError(err) {
  return err?.code === 'network_error'
}

export function isNotFound(err) {
  return err?.status === 404 || (typeof err?.code === 'string' && err.code.endsWith('_not_found'))
}

/** True for a user-initiated abort, which is never worth surfacing. */
export function isAbort(err) {
  return err?.name === 'AbortError'
}
