/* Placeholders that hold the layout while a request is in flight.

   Every skeleton is aria-hidden and the announcement is a single sibling
   sentence in a role="status" region — a screen reader should hear "Loading
   standards…" once, not forty grey boxes. */

import { motion } from 'framer-motion'

export function Skeleton({ width = '100%', height = '1rem', radius, className = '', style, static: isStatic }) {
  return (
    <motion.span
      aria-hidden="true"
      className={`skeleton ${isStatic ? 'skeleton-static' : ''} ${className}`.trim()}
      style={{ width, height, borderRadius: radius, ...style }}
      animate={isStatic ? {} : { opacity: [0.4, 0.8, 0.4] }}
      transition={isStatic ? {} : { duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
    />
  )
}

/** Stacked text lines. The last one is short, the way a paragraph ends.
 *
 * `static`: no shimmer — for a placeholder that holds layout for as long as
 * a lesson plan is generating (a couple minutes), where an infinite sweep
 * reads as the panel being busy rather than a quiet spot output lands in. */
export function SkeletonText({ lines = 3, width = '100%', static: isStatic }) {
  return (
    <span aria-hidden="true" className="skeleton-text" style={{ width }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className="skeleton-line"
          width={i === lines - 1 ? '62%' : '100%'}
          static={isStatic}
        />
      ))}
    </span>
  )
}

/** Rows shaped like `.list-row`, so the list doesn't jump when real data lands. */
export function SkeletonRows({ rows = 4, static: isStatic }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton-row-main">
            <Skeleton width="42%" height="0.9375rem" static={isStatic} />
            <Skeleton width="68%" height="0.75rem" static={isStatic} />
          </span>
          <Skeleton width="5.5rem" height="1.5rem" radius="var(--r-full)" static={isStatic} />
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
