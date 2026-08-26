/* What the app shows while GET /api/auth/me resolves.
 *
 * That branch used to be `if (status === 'loading') return null` — a blank white
 * page on every single cold load, for as long as the session round trip takes.
 * On school wifi that is not a flash, it is a second or two of nothing, and
 * "nothing" is indistinguishable from "broken".
 *
 * Deliberately a skeleton of the real layout rather than a spinner: it reserves
 * the same space the app is about to occupy, so the first paint doesn't jump. */
export function BootScreen() {
  return (
    <div className="flex h-full w-full z-10" aria-busy="true">
      <span className="visually-hidden" role="status">Loading FlexEd Academy…</span>
    </div>
  )
}
