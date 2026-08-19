#!/usr/bin/env node
/* Fail if any CSS custom property is used but never declared.
 *
 * The original stylesheet used --border-light and --bg-muted seven times without
 * declaring either, so artifact-card borders and chip backgrounds silently
 * rendered as nothing. Undefined custom properties are invalid-at-computed-value,
 * not an error — nothing warns you. This does.
 *
 * Also reports declared-but-unused as info (not a failure — some are intentional
 * API for future use).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })

const files = walk('src').filter((f) => ['.css', '.jsx', '.js'].includes(extname(f)))

const declared = new Map()
const used = new Map()

/* Comments are not code.
 *
 * base.css carries a comment that names --color-mark in order to say it is
 * defined nowhere and that --mark is the right token — and this checker read
 * that sentence as a USE and reported the property it was warning about. A
 * checker that fails on its own documentation trains people to ignore it,
 * which is worse than not having one. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ')

for (const file of files) {
  const text = stripComments(readFileSync(file, 'utf8'))
  if (extname(file) === '.css') {
    for (const m of text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) {
      if (!declared.has(m[1])) declared.set(m[1], file)
    }
  } else {
    /* A custom property set from a React style prop is a real declaration —
       style={{ '--onboarding-dir': direction }} is what defines the value
       base.css's own onboarding-step-enter keyframe reads. Only CSS files
       were scanned for declarations, so every inline-defined property looked
       undefined and the gate failed on working code. */
    for (const m of text.matchAll(/['"](--[a-z0-9-]+)['"]\s*:/gi)) {
      if (!declared.has(m[1])) declared.set(m[1], file)
    }
  }
  for (const m of text.matchAll(/var\((--[a-z0-9-]+)/gi)) {
    if (!used.has(m[1])) used.set(m[1], file)
  }
}

const missing = [...used.keys()].filter((v) => !declared.has(v)).sort()
const unused = [...declared.keys()].filter((v) => !used.has(v)).sort()

if (unused.length) {
  console.log(`note: ${unused.length} declared but unused: ${unused.join(', ')}`)
}

if (missing.length) {
  console.error('\nUndefined CSS custom properties — these render as nothing:\n')
  for (const v of missing) console.error(`  ${v}  (first used in ${used.get(v)})`)
  console.error('')
  process.exit(1)
}

console.log(`ok: ${used.size} custom properties used, all declared (${declared.size} total)`)
