/* Rewrite OpenAI-style math delimiters into the ones remark-math understands.
 *
 * The model emits \( ... \) and \[ ... \] . remark-math only ever recognizes
 * $ and $$ , so without this the plugin is a no-op on real output. Worse,
 * CommonMark's own backslash-escape rule eats the leading backslash first, so
 * by the time anything is parsed `\[` is indistinguishable from a literal
 * bracket — which is exactly why a chat reply about quadratics rendered as
 *     [ x=\frac{-(-8)}{2(2)}=2 ]
 * with the backslashes already stripped. This has to run on the raw string,
 * before parsing, or there is nothing left to recognize.
 *
 * Pure string -> string so it can be tested without a DOM.
 */

/* Ranges holding code, which must never be rewritten: a teacher pasting a
 * shell command or a regex containing \( has to survive untouched. */
function protectedRanges(text) {
  const ranges = []
  const lines = text.split('\n')
  let offset = 0
  let fence = null // { char, len, start }

  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (m) {
      const char = m[1][0]
      const len = m[1].length
      if (!fence) {
        fence = { char, len, start: offset }
      } else if (char === fence.char && len >= fence.len) {
        ranges.push([fence.start, offset + line.length])
        fence = null
      }
    }
    offset += line.length + 1
  }
  // An unterminated fence runs to the end — true mid-stream on every frame
  // until the closing fence arrives.
  if (fence) ranges.push([fence.start, text.length])

  // Inline code spans, skipping anything already inside a fence.
  const inFence = (i) => ranges.some(([a, b]) => i >= a && i < b)
  const tick = /`+/g
  let open = null
  let match
  while ((match = tick.exec(text))) {
    if (inFence(match.index)) continue
    if (!open) {
      open = { start: match.index, len: match[0].length }
    } else if (match[0].length === open.len) {
      ranges.push([open.start, match.index + match[0].length])
      open = null
    }
  }
  return ranges
}

function isProtected(ranges, start, end) {
  return ranges.some(([a, b]) => start < b && end > a)
}

/* Only a *balanced* pair is rewritten. An opener whose closer has not arrived
 * yet is left exactly as it is, which is what keeps a half-streamed expression
 * from swallowing the rest of the reply into one giant math node. */
function convert(text, openTok, closeTok, display) {
  const ranges = protectedRanges(text)
  const out = []
  let i = 0
  while (i < text.length) {
    const start = text.indexOf(openTok, i)
    if (start === -1) break
    const bodyAt = start + openTok.length
    const end = text.indexOf(closeTok, bodyAt)
    if (end === -1) break // unbalanced: leave the remainder alone
    if (isProtected(ranges, start, end + closeTok.length)) {
      out.push(text.slice(i, end + closeTok.length))
      i = end + closeTok.length
      continue
    }
    const body = text.slice(bodyAt, end).trim()
    out.push(text.slice(i, start))
    if (!body) {
      out.push(text.slice(start, end + closeTok.length))
    } else if (display) {
      // $$ on its own line is flow (display) math.
      out.push(`\n\n$$\n${body}\n$$\n\n`)
    } else {
      // With singleDollarTextMath off, $$…$$ inline is text math.
      out.push(`$$${body}$$`)
    }
    i = end + closeTok.length
  }
  out.push(text.slice(i))
  return out.join('')
}

export function normalizeMathDelimiters(text) {
  if (!text) return text || ''
  let out = String(text)
  if (!out.includes('\\[') && !out.includes('\\(')) return out
  // Double-escaped forms some models emit, collapsed first.
  out = out.replace(/\\\\\[/g, '\\[').replace(/\\\\\]/g, '\\]')
  out = out.replace(/\\\\\(/g, '\\(').replace(/\\\\\)/g, '\\)')
  out = convert(out, '\\[', '\\]', true)
  out = convert(out, '\\(', '\\)', false)
  return out
}

export default normalizeMathDelimiters
