#!/usr/bin/env node
/* Fail if a className references a semantic CSS class that no stylesheet defines.
 *
 * This is the ErrorBoundary bug. `.crash`, `.crash-card`, `.crash-message`,
 * `.crash-details`, `.btn-outline`, `.column`, `.page` and `.empty-state` were
 * all deleted along with components.css. Nothing warned, nothing failed, and the
 * crash screen — the one surface a teacher only ever sees when things have
 * already gone wrong — rendered as raw browser defaults for months. A class that
 * doesn't exist is not an error in CSS; it's just nothing.
 *
 * check-tokens.mjs is deliberately left alone. It is good precisely because it is
 * exact: `var(--x)` used, `--x:` declared, no heuristics. Broadening it to guess
 * at class names would put false positives in a checker people currently trust.
 * So this is a separate script with its own, narrower promise.
 *
 * DELIBERATELY NOT GENERAL. It only looks at kebab-case names inside string
 * literals. It cannot see through `cn(...)` helpers or fully-computed class
 * names and it must not try: a checker that reports plausible-looking noise gets
 * muted, and a muted checker is worse than no checker. If you hit a genuine
 * dynamic case, add the name to ALLOW below with a comment saying why.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const files = walk('src')

/* ── what the stylesheets define ──────────────────────────────────────────── */
const defined = new Set()
for (const file of files.filter((f) => extname(f) === '.css')) {
  const text = readFileSync(file, 'utf8')
  // Any `.some-class` appearing in a selector position. Generous on purpose:
  // this side of the comparison should never be the reason something fails.
  for (const m of text.matchAll(/\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/gi)) defined.add(m[1])
}

/* ── what the components ask for ──────────────────────────────────────────── */

// A semantic class is kebab-case with at least one hyphen, or one of the small
// set of single-word classes this app actually uses. Single words are otherwise
// too likely to be a Tailwind utility (`flex`, `grid`, `hidden`, `truncate`).
const SEMANTIC = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/
const SINGLE_WORD_SEMANTIC = new Set(['btn', 'cite', 'tag', 'input', 'column', 'page', 'eyebrow'])

// Tailwind utility families. A name matching one of these is Tailwind's problem,
// not ours — Tailwind fails loudly at build time for a class it can't generate.
const TW = new RegExp(
  '^(' +
    [
      'bg', 'text', 'border', 'rounded', 'flex', 'grid', 'gap', 'space', 'divide',
      'p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml',
      'w', 'h', 'min', 'max', 'size', 'inset', 'top', 'right', 'bottom', 'left',
      'overflow', 'overscroll', 'items', 'justify', 'self', 'place', 'content',
      'col', 'row', 'order', 'basis', 'shrink', 'grow', 'z', 'opacity', 'shadow', 'drop',
      'font', 'leading', 'tracking', 'truncate', 'line', 'whitespace', 'break',
      'animate', 'transition', 'duration', 'delay', 'ease', 'origin', 'scale',
      'translate', 'rotate', 'skew', 'transform', 'cursor', 'select', 'pointer',
      'resize', 'appearance', 'outline', 'ring', 'blur', 'backdrop', 'filter',
      'brightness', 'contrast', 'invert', 'saturate', 'grayscale', 'sepia',
      'fill', 'stroke', 'object', 'aspect', 'list', 'underline', 'decoration',
      'indent', 'align', 'table', 'caption', 'placeholder', 'accent', 'caret',
      'scroll', 'snap', 'touch', 'will', 'sr', 'not', 'group', 'peer', 'tabular', 'no',
      'antialiased', 'subpixel', 'uppercase', 'lowercase', 'capitalize', 'normal',
      'italic', 'visible', 'invisible', 'collapse', 'static', 'fixed', 'absolute',
      'relative', 'sticky', 'block', 'inline', 'hidden', 'contents', 'isolate',
      'float', 'clear', 'box', 'container', 'columns', 'first', 'last', 'only',
      'odd', 'even', 'empty', 'from', 'via', 'to', 'forced',
    ].join('|') +
    ')(-|$)'
)

// Classes that are real but can't be seen by a static scan of stylesheets.
const ALLOW = new Set([
  // Applied by react-resizable-panels / third-party markup, not by us.
  'data-panel-group',
])

const asked = new Map() // class -> "file:line"

for (const file of files.filter((f) => ['.jsx', '.js'].includes(extname(f)))) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // className="…" and className={`… ${x} …`} — for template literals this
    // matches the literal chunks only, which is exactly the intended scope.
    for (const m of line.matchAll(/className\s*=\s*[{]?[`"']([^`"']*)[`"']/g)) {
      for (const raw of m[1].split(/\s+/)) {
        if (!raw) continue
        // Strip variant prefixes (sm:, hover:, dark:, group-hover:) and the
        // important marker; drop anything with an arbitrary-value bracket.
        const bare = raw.replace(/^!/, '').split(':').pop()
        if (!bare || bare.includes('[') || bare.includes('(')) continue
        const isSemantic = SEMANTIC.test(bare) || SINGLE_WORD_SEMANTIC.has(bare)
        if (!isSemantic || TW.test(bare) || ALLOW.has(bare)) continue
        if (!asked.has(bare)) asked.set(bare, `${file}:${i + 1}`)
      }
    }
  })
}

const missing = [...asked.keys()].filter((c) => !defined.has(c)).sort()

if (missing.length) {
  console.error('\nClasses used in JSX that no stylesheet defines — these render as nothing:\n')
  for (const c of missing) console.error(`  .${c}  (first used at ${asked.get(c)})`)
  console.error('')
  process.exit(1)
}

console.log(`ok: ${asked.size} semantic classes used, all defined`)
