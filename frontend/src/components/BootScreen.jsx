/* What the app shows while GET /api/auth/me resolves.
 *
 * That branch used to be `if (status === 'loading') return null` — a blank white
 * page on every single cold load, for as long as the session round trip takes.
 * On school wifi that is not a flash, it is a second or two of nothing, and
 * "nothing" is indistinguishable from "broken".
 *
 * Deliberately a skeleton of the real layout rather than a spinner: it reserves
 * the same space the app is about to occupy, so the first paint doesn't jump. */
export function BootScreen({ label = 'Loading FlexEd Academy…' }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-paper/20 p-6" aria-busy="true">
      <div className="flex items-center gap-3 rounded-full bg-paper-raised/80 px-4 py-3 text-sm font-medium text-ink-muted shadow-sm ring-1 ring-edge/60">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
        <span role="status">{label}</span>
      </div>
    </div>
  )
}
