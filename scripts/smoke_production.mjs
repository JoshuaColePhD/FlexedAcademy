/* Does the deployed site actually WORK for a visitor — not just answer 200?
 *
 * Written after an outage where every conventional signal stayed green. The
 * app shipped a bug that left every logged-out visitor on a blank boot screen:
 * no landing page, no sign-in form. Throughout it,
 *
 *   GET /              -> 200
 *   GET /api/health    -> {"ok":true}
 *   GET /api/health/ready -> {"ok":true}
 *
 * ...because the failure was in client-side JavaScript. Nothing threw, so
 * Sentry saw nothing either. The site was down for anyone who wasn't already
 * logged in, and the only reason it was found was somebody opening it.
 *
 * That is why this drives a real browser. flexedacademy.com is a single-page
 * app: `curl /` returns a shell containing zero words of the landing page
 * (verified — grep "Sign in" finds nothing), so any check that doesn't execute
 * JavaScript is structurally incapable of catching this class of bug. A
 * string-match on the HTML would have passed happily the entire time.
 *
 * Two assertions, both about a stranger's first thirty seconds:
 *   1. The marketing page renders and offers a way in.
 *   2. A protected URL bounces to /login instead of hanging.
 *
 * Retries before failing. Render's free instance sleeps after 15 minutes idle
 * and takes ~50s to wake (keepwarm/README.md), so a first load outside the
 * keepwarm window is legitimately slow — and a monitor that cries wolf gets
 * muted, which is worse than not having one.
 *
 * Usage: node scripts/smoke_production.mjs [https://flexedacademy.com]
 */
import { chromium } from 'playwright'

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'https://flexedacademy.com').replace(/\/$/, '')
const ATTEMPTS = Number(process.env.SMOKE_ATTEMPTS || 3)
// Generous: a cold Render instance is ~50s, and being slow is not being broken.
const NAV_TIMEOUT_MS = 90_000
const EXPECT_TIMEOUT_MS = 30_000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runChecks(browser) {
  const failures = []
  // A fresh context per attempt: no storage, no cookies, exactly what a
  // stranger arriving from a link gets. (The outage only affected visitors
  // WITHOUT a session, so reusing state here would have hidden it.)
  const context = await browser.newContext()
  const page = await context.newPage()
  page.setDefaultTimeout(EXPECT_TIMEOUT_MS)
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)

  try {
    // 1. The landing page renders something a human can act on.
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    try {
      // Matched on visible TEXT, not on a role or a selector. The first draft
      // of this asked for a link named "Sign in" and failed against a site
      // that was rendering perfectly — the words were there, the role was not
      // what I guessed. A monitor whose assertion is more specific than the
      // thing it is checking generates false alarms, and a monitor people
      // learn to ignore is worse than none. The question here is only "did
      // the app paint its landing page, or is it the empty boot shell?", so
      // match the way a person reading the screen would.
      await page.getByText(/sign in/i).first().waitFor({ state: 'visible' })
      console.log('  ok   landing page renders and offers a way in')
    } catch {
      const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 200)
      failures.push(
        `landing page never rendered a sign-in affordance. body text was: ${JSON.stringify(text)}`
      )
    }

    // 2. A protected route sends a signed-out visitor to /login rather than
    //    hanging on the boot screen. This is the exact assertion the outage
    //    would have failed.
    await page.goto(`${BASE}/c/smoke-test-not-a-real-class`, { waitUntil: 'domcontentloaded' })
    try {
      await page.waitForURL(/\/login/, { timeout: EXPECT_TIMEOUT_MS })
      console.log('  ok   a protected route redirects a signed-out visitor to /login')
    } catch {
      failures.push(
        `a protected route did not redirect to /login (stuck at ${page.url()}) — ` +
          'this is the blank-boot-screen failure mode'
      )
    }
  } finally {
    await context.close()
  }
  return failures
}

const browser = await chromium.launch()
let failures = []
try {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    console.log(`\nattempt ${attempt}/${ATTEMPTS} against ${BASE}`)
    failures = await runChecks(browser)
    if (!failures.length) break
    if (attempt < ATTEMPTS) {
      // Backs off rather than hammering: a waking instance needs time, and a
      // deploy that is mid-swap resolves on its own within a minute.
      const wait = attempt * 30_000
      console.log(`  ..   ${failures.length} check(s) failed; retrying in ${wait / 1000}s`)
      await sleep(wait)
    }
  }
} finally {
  await browser.close()
}

console.log()
if (failures.length) {
  console.log(`FAILED — the deployed site is not usable by a signed-out visitor:`)
  for (const f of failures) console.log(`  * ${f}`)
  process.exit(1)
}
console.log('PASSED — a stranger can load the site and reach the sign-in form.')
