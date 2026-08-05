/* Placeholders that hold the layout while a request is in flight.

   Every skeleton is aria-hidden and the announcement is a single sibling
   sentence in a role="status" region — a screen reader should hear "Loading
   standards…" once, not forty grey boxes. */

export function Skeleton({ width = '100%', height = '1rem', radius, className = '', style }) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton ${className}`.trim()}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  )
}

/** Stacked text lines. The last one is short, the way a paragraph ends. */
export function SkeletonText({ lines = 3, width = '100%' }) {
  return (
    <span aria-hidden="true" className="skeleton-text" style={{ width }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="skeleton-line" width={i === lines - 1 ? '62%' : '100%'} />
      ))}
    </span>
  )
}

/** Rows shaped like `.list-row`, so the list doesn't jump when real data lands. */
export function SkeletonRows({ rows = 4 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton-row-main">
            <Skeleton width="42%" height="0.9375rem" />
            <Skeleton width="68%" height="0.75rem" />
          </span>
          <Skeleton width="5.5rem" height="1.5rem" radius="var(--r-full)" />
        </div>
      ))}
    </div>
  )
}

/**
 * The announcement half of a loading state. Pair with any skeleton above.
 * Kept separate so a page can place the skeleton visually wherever it likes
 * while the live region stays in one predictable spot.
 */
export function LoadingAnnouncement({ children = 'Loading…' }) {
  return (
    <p className="visually-hidden" role="status">
      {children}
    </p>
  )
}
