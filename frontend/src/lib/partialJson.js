/* Best-effort parse of JSON that is still arriving.

   The previous approach was `JSON.parse(rawJson + ']}')`, which only succeeded
   for one exact partial shape — a truncation sitting directly inside the days
   array, with no open string and no nested open object. Every other moment in
   the stream threw, so the live preview mostly showed nothing at all.

   Strategy here: walk the text once to find every prefix that ends on a
   structural boundary, then try the longest such prefix first, closing whatever
   brackets are still open. Simple, bounded, and easy to reason about. */

/** Scan a prefix: is it inside a string, and what closers does it still need? */
function scan(text) {
  const stack = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  return { inString, escaped, closers: stack.reverse().join('') }
}

/** Try to complete one candidate prefix into valid JSON. */
function tryClose(prefix) {
  const cleaned = prefix.replace(/[,:]\s*$/, '')
  const { inString, escaped, closers } = scan(cleaned)
  if (inString || escaped) return undefined
  try {
    return JSON.parse(cleaned + closers)
  } catch {
    return undefined
  }
}

export function parsePartialJson(text) {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed) return null

  // Already complete?
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through
  }

  // Collect indices where a prefix could legally end, outside of strings.
  const boundaries = []
  let inString = false
  let escaped = false
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') {
        inString = false
        boundaries.push(i + 1) // a completed string value
      }
      continue
    }
    if (ch === '"') inString = true
    else if ('{}[],'.includes(ch)) boundaries.push(i + 1)
    else if (/[\d\w]/.test(ch)) boundaries.push(i + 1) // end of a number/true/null
  }

  // Longest first — the most complete preview we can show.
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const parsed = tryClose(trimmed.slice(0, boundaries[i]))
    if (parsed !== undefined) return parsed
  }
  return null
}

/** Only show a preview once there is a usable week in there. */
export function usablePlan(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  if (!Array.isArray(parsed.days) || parsed.days.length === 0) return null
  return parsed
}
