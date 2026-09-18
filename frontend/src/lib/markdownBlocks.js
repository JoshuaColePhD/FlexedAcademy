/* Split streaming markdown into settled blocks plus a still-growing tail.
 *
 * Re-parsing the whole reply every frame is what everyone tries first, and it
 * is disqualified here by KaTeX rather than by the parser: a full re-parse
 * re-renders every expression from scratch each frame at 1-4ms apiece, so a
 * reply with six equations costs 6-24ms/frame of KaTeX alone. Splitting into
 * append-only blocks means each block parses exactly once, and each equation
 * renders exactly once, when its block finalizes.
 *
 * THE INVARIANT everything downstream depends on: once a block is emitted in
 * `stable`, it never changes. StreamingMarkdown keys memoized blocks by index,
 * which is only safe because blocks are append-only. Every rule below exists to
 * keep that true — a boundary is only ever used once the lines on both sides of
 * it have arrived, so its meaning can no longer change.
 *
 * Pure functions, no React and no DOM, so they test in plain node.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const TABLE_ROW = /^\s*\|/
const TABLE_DELIM = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/
const LINK_REF_DEF = /^\s{0,3}\[[^\]]+\]:/

/** Line indices where a fence is open (those lines can never be a boundary). */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false)
  let fence = null
  lines.forEach((line, i) => {
    const m = FENCE.exec(line)
    if (m) {
      const char = m[1][0]
      const len = m[1].length
      if (!fence) {
        fence = { char, len }
        mask[i] = true
      } else if (char === fence.char && len >= fence.len) {
        fence = null
        mask[i] = true
      } else {
        mask[i] = true
      }
      return
    }
    mask[i] = fence !== null
  })
  return mask
}

const prevNonBlank = (lines, i) => {
  for (let j = i - 1; j >= 0; j--) if (lines[j].trim()) return lines[j]
  return null
}
/* The next non-blank line, but ONLY if it is finished.
 *
 * The final line of a streaming document is still being written, and one
 * character changes its meaning: "-" is a paragraph, "- " is a list item. A
 * boundary judged against a half-typed line flips its verdict a frame later,
 * which withdraws a block that was already emitted and breaks the append-only
 * invariant. Requiring a following line proves this one is complete.
 */
const nextNonBlank = (lines, i) => {
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue
    return j < lines.length - 1 ? lines[j] : null
  }
  return null
}

export function splitBlocks(text) {
  if (!text) return { stable: [], tail: '' }
  const lines = text.split('\n')
  const masked = fenceMask(lines)

  const boundaries = []
  for (let i = 0; i < lines.length; i++) {
    if (masked[i] || lines[i].trim()) continue
    const before = prevNonBlank(lines, i)
    const after = nextNonBlank(lines, i)
    // No text after it yet: undecidable, so never cut here. Once the next line
    // arrives this boundary's meaning is fixed and it can be used safely.
    if (before === null || after === null) continue
    // A loose list is ONE list in CommonMark. Cutting "- a\n\n- b" in half
    // yields two single-item <ul>s with different margins.
    const listish = (l) => LIST_ITEM.test(l) || /^\s{2,}\S/.test(l)
    if (listish(before) && listish(after)) continue
    // Never separate a table from its continuation.
    if (TABLE_ROW.test(before) && TABLE_ROW.test(after)) continue
    boundaries.push(i)
  }

  if (!boundaries.length) return { stable: [], tail: text }

  const cut = boundaries[boundaries.length - 1]
  const stable = []
  let start = 0
  for (const b of boundaries) {
    const chunk = lines.slice(start, b).join('\n').trim()
    if (chunk) stable.push(chunk)
    start = b + 1
  }
  const tail = lines.slice(cut + 1).join('\n')

  // A link reference definition is resolved across blocks, so nothing after one
  // can be rendered in isolation. Rare in model output; cheap insurance.
  const refAt = stable.findIndex((b) => LINK_REF_DEF.test(b))
  if (refAt !== -1) {
    const held = stable.slice(refAt)
    return { stable: stable.slice(0, refAt), tail: [...held, tail].join('\n\n') }
  }
  return { stable, tail }
}

/** Count occurrences of a delimiter that are not backslash-escaped. */
function countUnescaped(text, token) {
  let n = 0
  for (let i = 0; i <= text.length - token.length; i++) {
    if (!text.startsWith(token, i)) continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) slashes++
    if (slashes % 2 === 0) {
      n++
      i += token.length - 1
    }
  }
  return n
}

/** Close marks the model has opened but not yet finished.
 *
 * Without this the reader watches literal ** and ` scroll past and snap into
 * formatting a frame later, which is precisely the churn this is meant to stop.
 */
export function closeOpenMarks(tail) {
  if (!tail) return ''
  let out = tail
  const lines = out.split('\n')

  // A table whose delimiter row has not arrived would render as a paragraph of
  // pipes and then snap into a table — the single most visible mid-stream
  // artifact for this app's content. Hold those rows back for a frame instead.
  let holdFrom = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) break
    if (!TABLE_ROW.test(lines[i])) break
    holdFrom = i
  }
  if (holdFrom !== -1) {
    const hasDelim = lines.slice(holdFrom).some((l) => TABLE_DELIM.test(l) && l.includes('-'))
    if (!hasDelim) out = lines.slice(0, holdFrom).join('\n')
  }
  if (!out.trim()) return ''

  // An unterminated fence: everything after it is code until it closes.
  const fences = out.split('\n').filter((l) => FENCE.test(l)).length
  if (fences % 2 === 1) return `${out}\n\`\`\``

  if (countUnescaped(out, '`') % 2 === 1) out += '`'
  if (countUnescaped(out, '**') % 2 === 1) out += '**'
  // Single-asterisk emphasis, counting only asterisks that are not part of a **.
  const singles = out.replace(/\*\*/g, '')
  if (countUnescaped(singles, '*') % 2 === 1) out += '*'

  // Deliberately does NOT try to close $$ — normalizeMathDelimiters already
  // leaves an unbalanced expression alone, and guessing wrong here would hand
  // KaTeX a malformed expression instead of plain text.
  return out
}

export default { splitBlocks, closeOpenMarks }
