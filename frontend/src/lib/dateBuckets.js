/* Date-bucketing for the chat sidebar's "Recent" list.
 *
 * Mirrors lib/frameworks.js's groupFrameworks() shape — ordered named
 * buckets, items kept in their incoming order within each — rather than
 * inventing a different grouping pattern for what is the same underlying
 * problem: a flat list that got too long to scan.
 */

const DAY_MS = 86400000

const BUCKET_ORDER = ['Today', 'Yesterday', 'This week', 'Older']

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

// A bare "YYYY-MM-DD" parses as UTC midnight per spec, which reads as the
// PREVIOUS local day anywhere west of UTC — the same gotcha lib/dates.js's
// own parse() already works around. A full timestamp (what updated_at
// always is in production — db.now()'s isoformat with an explicit UTC
// offset) has no such ambiguity and passes through unchanged.
function toDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso)
}

function bucketFor(iso, now) {
  if (!iso) return 'Older'
  const days = Math.floor((startOfDay(now) - startOfDay(toDate(iso))) / DAY_MS)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'This week'
  return 'Older'
}

/** Groups items into Today / Yesterday / This week / Older by `dateKey(item)`.
 *  Items stay in whatever order they arrived in within a bucket — the
 *  server's own `updated_at DESC` sort already decided that, this only adds
 *  headings over it. Empty buckets are omitted. */
export function groupByDate(items = [], dateKey = (item) => item.updated_at, now = new Date()) {
  const buckets = new Map(BUCKET_ORDER.map((b) => [b, []]))
  for (const item of items) buckets.get(bucketFor(dateKey(item), now)).push(item)
  return BUCKET_ORDER.map((name) => ({ name, items: buckets.get(name) })).filter((g) => g.items.length > 0)
}
