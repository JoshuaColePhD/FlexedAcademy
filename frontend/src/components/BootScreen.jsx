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
    <div className="flex h-app w-full overflow-hidden bg-paper" aria-busy="true">
      <span className="visually-hidden" role="status">Loading FlexEd Academy…</span>

      {/* the rail */}
      <div className="hidden w-[264px] shrink-0 flex-col gap-4 border-r border-edge bg-paper-sunken p-4 lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold tracking-tight text-ink">FlexEd Academy</span>
        </div>
        <div className="mt-2 flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-8 w-full rounded-md" />
          ))}
        </div>
      </div>

      {/* the year */}
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-gutter pt-8">
        <div className="skeleton h-6 w-48 rounded-md" />
        <div className="mt-2 flex flex-col gap-1.5">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="skeleton h-9 w-full rounded-md" />
          ))}
        </div>
      </div>
    </div>
  )
}
