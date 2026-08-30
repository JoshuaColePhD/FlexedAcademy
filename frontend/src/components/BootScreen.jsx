/* One centered loading mark. The old app layered a large brand watermark under
 * a second pill that repeated "Loading FlexEd Academy", which looked like two
 * loading states fighting for attention. */
export function BootScreen({ label = 'Loading…' }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-paper/20 p-6" aria-busy="true">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-semibold tracking-tight text-ink/40">FlexEd Academy</h1>
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
        <span role="status" className="sr-only">{label}</span>
      </div>
    </div>
  )
}
