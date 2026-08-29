#!/usr/bin/env node
/* An inventory of every button in the source, so adding one is a deliberate act.
 *
 * The companion to scripts/test-buttons.mjs, and the answer to the one thing a
 * browser crawl structurally cannot promise. test-buttons.mjs clicks what it
 * reaches; "what it reaches" is not "all of them," and the gap is invisible
 * from inside the crawl — a button behind a conditional nothing satisfies is
 * indistinguishable from a button that doesn't exist. This reads the source
 * instead, so the gap has a number.
 *
 * Two failures, both exact, neither heuristic:
 *
 *   1. A <button> inside a <form> with no `type`. HTML defaults it to submit,
 *      so a "Cancel" or "Add row" button silently submits the form it sits in.
 *      Only reported when the button is genuinely nested inside a <form> in
 *      the same file — not merely in a file that happens to contain one.
 *
 *   2. The inventory drifted from buttons.json. Adding a button is fine; adding
 *      one without noticing is what this stops. Re-run with --update, and the
 *      diff in review says a button was added, which is when someone asks
 *      whether it's covered.
 *
 * DELIBERATELY NOT AN ACCESSIBILITY CHECKER, though the temptation is obvious.
 * A first draft flagged every button with no static name and reported 62 of
 * 223 — and every one sampled was a false positive: aria-label={...},
 * {opt.label}, {shown.confirmLabel}, {content}. The name is real, it just
 * isn't a string literal, and no amount of JSX squinting will see it. So the
 * accessible-name check lives in test-buttons.mjs, where Playwright computes
 * the REAL accessible name off the rendered node and the answer is a fact
 * rather than a guess. check-classes.mjs's warning applies exactly: a checker
 * that reports plausible-looking noise gets muted, and a muted checker is
 * worse than no checker.
 *
 * The inventory stores names, not line numbers. Line numbers churn every time
 * anything above a button moves, which would mean a snapshot update on
 * unrelated edits — and a snapshot people update reflexively has stopped being
 * a check. Lines are computed fresh for error messages, where they're useful.
 *
 * Usage: node scripts/check-buttons.mjs [--update]
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const INVENTORY = join(ROOT, 'buttons.json')
const UPDATE = process.argv.includes('--update')

/* Source locations whose button is unreachable from the crawl, and why. This
   list is not a mute button — it's the record of where the two numbers at the
   bottom of this script legitimately differ. An entry needs a reason. */
const UNREACHABLE = {
  'src/components/ErrorBoundary.jsx':
    "the crash screen. Rendering it needs a component that throws, which the mock backend can't cause on purpose.",
}

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

/* Find the '>' that closes an open tag starting at `i`, skipping over strings
   and over anything inside {braces} — a className template literal containing
   a '>' is common enough that a naive indexOf('>') mis-slices real files. */
function tagEnd(s, i) {
  let depth = 0
  let quote = null
  for (let j = i; j < s.length; j++) {
    const c = s[j]
    if (quote) {
      if (c === quote && s[j - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return j
  }
  return -1
}

/* The matching </button>, counting nesting. Buttons don't nest in valid HTML,
   but a <button> inside a comment or a string inside this element would
   otherwise steal the close tag. */
function elementEnd(s, from) {
  let depth = 1
  let j = from + 1
  while (j < s.length) {
    if (s.startsWith('<button', j)) {
      depth++
      j += 7
    } else if (s.startsWith('</button>', j)) {
      depth--
      if (!depth) return j
      j += 9
    } else j++
  }
  return -1
}

/* Is `i` inside a <form>…</form> in this file? Counts opens and closes before
   the position rather than asking "does this file contain a form at all,"
   which over-reports badly: SettingsPage has a form and seventeen buttons
   outside it. */
function insideForm(s, i) {
  let depth = 0
  const re = /<form\b|<\/form>/g
  let m
  while ((m = re.exec(s)) && m.index < i) depth += m[0] === '</form>' ? -1 : 1
  return depth > 0
}

/* The button's name as it can be known from source alone: an aria-label or
   title string literal, else its static text. Anything dynamic reads as null —
   that is a fact about this file, not a complaint about the button. */
function staticName(tag, inner) {
  const aria = tag.match(/aria-label="([^"]*)"/)
  if (aria) return aria[1]
  const title = tag.match(/title="([^"]*)"/)
  if (title) return title[1]
  const text = inner
    .replace(/\{[^{}]*\}/g, '') // {expressions} are not static text
    .replace(/<[^>]*>/g, ' ') // nested elements (icons, spans)
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

const buttons = []
for (const file of walk(SRC).filter((f) => extname(f) === '.jsx')) {
  const rel = relative(ROOT, file)
  const s = readFileSync(file, 'utf8')
  for (let i = s.indexOf('<button'); i >= 0; i = s.indexOf('<button', i + 1)) {
    const close = tagEnd(s, i)
    if (close < 0) continue
    const tag = s.slice(i, close + 1)
    const selfClosing = tag.trimEnd().endsWith('/>')
    const end = selfClosing ? close : elementEnd(s, close)
    const inner = !selfClosing && end > 0 ? s.slice(close + 1, end) : ''
    buttons.push({
      file: rel,
      line: s.slice(0, i).split('\n').length,
      name: staticName(tag, inner),
      hasType: /\btype=/.test(tag),
      inForm: insideForm(s, i),
    })
  }
}

const failures = []

// ── 1. implicit submit ───────────────────────────────────────────────────────
for (const b of buttons) {
  if (b.inForm && !b.hasType) {
    failures.push(
      `${b.file}:${b.line} — <button> inside a <form> with no type. It defaults to ` +
        `type="submit" and will submit the form on click. Add type="button".`
    )
  }
}

// ── 2. the inventory ─────────────────────────────────────────────────────────
// Per file: how many buttons, and the ones whose name is knowable from source.
// Sorted so the file is stable under reordering within a file.
const current = {}
for (const b of buttons) {
  const entry = (current[b.file] ||= { count: 0, named: [] })
  entry.count++
  if (b.name) entry.named.push(b.name)
}
for (const entry of Object.values(current)) entry.named.sort()
const sorted = Object.fromEntries(Object.keys(current).sort().map((k) => [k, current[k]]))

if (UPDATE) {
  writeFileSync(INVENTORY, `${JSON.stringify(sorted, null, 2)}\n`)
  console.log(`buttons.json updated — ${buttons.length} buttons across ${Object.keys(sorted).length} files.`)
} else {
  let previous
  try {
    previous = JSON.parse(readFileSync(INVENTORY, 'utf8'))
  } catch {
    failures.push(`buttons.json is missing or unreadable. Create it: node scripts/check-buttons.mjs --update`)
  }
  if (previous) {
    for (const file of new Set([...Object.keys(previous), ...Object.keys(sorted)])) {
      const before = previous[file]
      const after = sorted[file]
      if (!before) {
        failures.push(`${file} — ${after.count} new button(s), not in buttons.json. Cover them in scripts/test-buttons.mjs, then re-run with --update.`)
        continue
      }
      if (!after) {
        failures.push(`${file} — every button is gone (buttons.json expects ${before.count}). If that's intended, re-run with --update.`)
        continue
      }
      if (before.count !== after.count) {
        failures.push(
          `${file} — ${after.count} buttons now, buttons.json expects ${before.count}. ` +
            `Cover any new one in scripts/test-buttons.mjs, then re-run with --update.`
        )
      }
      const added = after.named.filter((n) => !before.named.includes(n))
      const removed = before.named.filter((n) => !after.named.includes(n))
      if (added.length) failures.push(`${file} — new button label(s): ${added.map((n) => `"${n}"`).join(', ')}. Re-run with --update once covered.`)
      if (removed.length) failures.push(`${file} — button label(s) gone: ${removed.map((n) => `"${n}"`).join(', ')}. Re-run with --update if intended.`)
    }
  }
}

if (failures.length) {
  console.error(`check-buttons: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}

const unreachable = buttons.filter((b) => UNREACHABLE[b.file]).length
console.log(
  `check-buttons: ${buttons.length} buttons across ${Object.keys(sorted).length} files` +
    (unreachable ? `, ${unreachable} documented as unreachable from the crawl` : '') +
    '.'
)
