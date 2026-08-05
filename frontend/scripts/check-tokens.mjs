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

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  if (extname(file) === '.css') {
    for (const m of text.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) {
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
