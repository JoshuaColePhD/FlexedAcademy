/* Public share cards must stay school-agnostic.
 *
 * LinkedIn, Slack, and Google read <meta> / Open Graph tags from the static
 * HTML, not from the React landing page. A district-named description here
 * is what a teacher posts by accident when they paste flexedacademy.com.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE_DESCRIPTION =
  "Build a week of lesson plans for your class, grounded in your state's standards and delivered in your school's own template."
const FORBIDDEN = /florence|alabama course of study|fcs template/i

function attrValues(html, attr) {
  const re = new RegExp(`${attr}\\s*=\\s*"([^"]*)"`, 'gi')
  return [...html.matchAll(re)].map((m) => m[1])
}

function metaContents(html) {
  return [
    ...attrValues(html, 'content'),
    ...attrValues(html, 'href').filter((h) => !h.startsWith('/') && !h.startsWith('http')),
  ]
}

function assertGenericCopy(label, text) {
  const hit = text.match(FORBIDDEN)
  assert.equal(hit, null, `${label} names a specific school or district: ${hit?.[0]}`)
}

const indexHtml = readFileSync(join(root, 'index.html'), 'utf8')
const previewHtml = readFileSync(join(root, 'preview.html'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8'))

for (const [label, html] of [
  ['index.html', indexHtml],
  ['preview.html', previewHtml],
]) {
  for (const value of metaContents(html)) assertGenericCopy(`${label} metadata`, value)
  const description = html.match(/name="description"\s+content="([^"]*)"/s)?.[1]
    || html.match(/content="([^"]*)"\s+name="description"/s)?.[1]
  assert.equal(description, SITE_DESCRIPTION, `${label} description`)
  const og = html.match(/property="og:description"\s+content="([^"]*)"/s)?.[1]
    || html.match(/content="([^"]*)"\s+property="og:description"/s)?.[1]
  assert.equal(og, SITE_DESCRIPTION, `${label} og:description`)
  const twitter = html.match(/name="twitter:description"\s+content="([^"]*)"/s)?.[1]
    || html.match(/content="([^"]*)"\s+name="twitter:description"/s)?.[1]
  assert.equal(twitter, SITE_DESCRIPTION, `${label} twitter:description`)
}

assert.equal(manifest.description, SITE_DESCRIPTION, 'manifest.json description')
assertGenericCopy('manifest.json', JSON.stringify(manifest))
assert.match(indexHtml, /property="og:title"\s+content="FlexEd Academy"/)
assert.match(indexHtml, /rel="canonical"\s+href="https:\/\/flexedacademy.com\/"/)

console.log('public metadata stays generic')
