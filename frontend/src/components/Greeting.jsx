/* The greeting on an empty screen.
 *
 * The one place the serif appears, and one of the very few places --accent is
 * allowed — as a fill, on a decorative aria-hidden glyph. Everything else in the
 * app is Inter and near-black, which is what makes this land.
 */

const HONORIFIC = /^(mr|mrs|ms|mx|dr|prof|coach)\.?$/i

/** "Mr. Cole" rather than "Josh": a teacher's own name, the way their students
 *  and colleagues write it. Falls back to nothing when the field is blank, so
 *  the greeting degrades to just the time of day. */
function displayName(raw) {
  const parts = (raw || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  return HONORIFIC.test(parts[0]) ? parts.slice(0, 2).join(' ') : parts[0]
}

function timeOfDay(now = new Date()) {
  const h = now.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/* Ten tapered spokes on a 24 grid. Inline rather than the 399KB public/logo.png,
   which would be a heavy request for a 26px mark; `currentColor` keeps it
   theme-aware without a second asset. */
function Mark({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      {Array.from({ length: 10 }, (_, i) => (
        <rect
          key={i}
          x="11.35"
          y="1.7"
          width="1.3"
          height="8.1"
          rx="0.65"
          transform={`rotate(${i * 36} 12 12)`}
        />
      ))}
    </svg>
  )
}

export function Greeting({ settings }) {
  const name = displayName(settings?.teacher)
  return (
    <div className="mb-7 flex animate-rise-in items-center justify-center gap-3">
      <Mark className="h-[26px] w-[26px] shrink-0 text-accent" />
      <h1 className="font-display text-[1.875rem] font-normal leading-tight tracking-display text-ink md:text-[2.25rem]">
        {timeOfDay()}
        {name ? `, ${name}` : ''}
      </h1>
    </div>
  )
}
