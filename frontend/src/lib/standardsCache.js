import { api } from './api'
import { normalizeCode } from './codes'

/* One cache, shared by every place a standard gets looked up — a chat
 * citation's popover (Citation.jsx) and the rail's Standards panel
 * (ArtifactDetailPanel.jsx). Each used to keep its own Map, so opening the
 * Standards panel for a plan already read in chat re-fetched every code from
 * scratch, and the panel itself fired one request per code with no reuse
 * across mounts. A record only ever changes if the corpus is reprocessed —
 * safe to hold for the life of the tab.
 *
 * `subject` is part of the key, not just the request: the same code can
 * resolve to a different chunk depending on course (see
 * backend/retrieval.py's chunk_for_code) — see cacheKey().
 */
const cache = new Map()

export function cacheKey(code, subject, state) {
  return `${normalizeCode(code)}::${subject || ''}::${state || ''}`
}

/** Cached record for one code, or undefined if never fetched. */
export function getCached(code, subject, state) {
  return cache.get(cacheKey(code, subject, state))
}

/**
 * One code, deduped against any request already in flight for the same key
 * (a Standards panel and a citation popover can want the same code at once).
 */
export function fetchStandard(code, { subject, state, signal } = {}) {
  const key = cacheKey(code, subject, state)
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  return api.getStandard(code, { subject, state, signal }).then((r) => {
    cache.set(key, r)
    return r
  })
}

/**
 * Every code a plan cites, in one request — see backend/routes/standards.py's
 * get_standards_batch. Skips codes already cached, so re-opening a panel
 * costs nothing once every code it cites has been seen once (by either this
 * panel or a chat citation). Returns {code: record | null} for ALL requested
 * codes, cached ones included.
 */
export async function fetchStandardsBatch(codes, { subject, state, signal } = {}) {
  const uncached = codes.filter((code) => !cache.has(cacheKey(code, subject, state)))
  if (uncached.length) {
    const fetched = await api.getStandardsBatch(uncached, { subject, state, signal })
    for (const code of uncached) {
      cache.set(cacheKey(code, subject, state), fetched[code] ?? null)
    }
  }
  const out = {}
  for (const code of codes) out[code] = cache.get(cacheKey(code, subject, state))
  return out
}
