#!/usr/bin/env node
/* Every button in the app, clicked, in a real browser.
 *
 * The gap this closes: nothing in this repo has ever exercised a button.
 * `npm run check` is lint, tokens, classes and a build — all of which pass
 * happily while a click does nothing. The four focused test:* scripts pin
 * specific mechanisms in Node with no DOM. scripts/smoke_production.mjs drives
 * a browser but makes two assertions, both about a logged-out stranger's first
 * screen. A statically perfect button — handler attached, endpoint named,
 * props threaded — is still broken if the endpoint was renamed underneath it,
 * and that is the failure this app has actually shipped, twice.
 *
 * It runs against frontend/preview.html, which boots the REAL App.jsx against
 * src/dev/mockApi.js. No Postgres, no pgvector, no Google OAuth, no network.
 * That harness is why this test is cheap enough to run on every push; it is
 * load-bearing now, not the throwaway its own header once called it.
 *
 * WHAT "WORKS" MEANS HERE. Writing a bespoke assertion for each of 223 buttons
 * would be a week of work and would rot the day someone renames a label. So
 * every button gets the same four checks, which between them catch the whole
 * class of runtime breakage that motivated this:
 *
 *   1. It has an accessible name — computed by the browser off the rendered
 *      node, not guessed from the JSX. A nameless icon button is broken for a
 *      screen reader even when it works for a mouse.
 *   2. Clicking it throws nothing: no uncaught exception, no console error, and
 *      the ErrorBoundary crash screen does not appear.
 *   3. It sends no request the mock backend doesn't recognise. mockApi's
 *      fallthrough records those and answers 501 — before that, an unhandled
 *      endpoint got an empty 200 and a dead button looked like a live one.
 *   4. Something happened. A click must produce a request, a navigation, or a
 *      DOM change. This is the assertion that catches a handler that silently
 *      failed, and it needs no per-button knowledge to do it.
 *
 * On top of that, NAMED_EXPECTATIONS pins the exact request a handful of
 * load-bearing buttons must issue — "Save issued PATCH /api/me" is a contract
 * a rename breaks, and check 4 alone would not notice.
 *
 * State between clicks: the page is reloaded whenever a click navigates, opens
 * a dialog, or removes the button list from under us. mockApi's state is
 * per-page-load, so a reload is also a clean database — which is what makes a
 * destructive button ("Delete Class") safe to click here at all.
 *
 * Usage: node --test scripts/test-buttons.mjs
 *        BUTTONS_BASE=http://127.0.0.1:5174 node --test scripts/test-buttons.mjs
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

/* 127.0.0.1, not localhost: vite binds IPv4 only, and in the CI playwright
   container node resolves localhost to ::1 first — which cost a whole run to a
   readiness poll that could not reach a server that was already up. Local runs
   use the same address so the two cannot diverge again. */
const BASE = (process.env.BUTTONS_BASE || 'http://127.0.0.1:5174').replace(/\/$/, '')
const NAV_TIMEOUT_MS = 30_000

/* Every route worth crawling, and the state to reach it in.
   `anon` boots signed out — preview.jsx forces /api/auth/me to 401, which is
   the only way the landing and auth pages render at all.
   `minButtons` defaults to 1: a route that renders none is usually a route
   that failed to render, and saying so is most of the value of a smoke test.
   The prose pages are the honest exception, declared rather than inferred. */
const ROUTES = [
  { at: '/c/c1', label: 'class home (week board)' },
  { at: '/c/c1/chat/seed1', label: 'chat with a built plan' },
  { at: '/c/c1/plans', label: 'plan library' },
  { at: '/c/c1/history', label: 'chat history' },
  { at: '/c/c1/class', label: 'class settings' },
  { at: '/c/c1/standards', label: 'standards browser' },
  { at: '/c/c1/settings', label: 'account settings' },
  { at: '/c/c1/admin', label: 'admin' },
  // NotFoundPage's only escape hatch is a <Link>, not a button — the route is
  // still worth loading (a 404 page that crashes is a 404 page nobody escapes),
  // there is simply nothing here to click.
  { at: '/nope', label: 'not found', minButtons: 0 },
  { at: '/', anon: true, label: 'landing (signed out)' },
  { at: '/login', anon: true, label: 'sign in' },
  { at: '/signup', anon: true, label: 'sign up' },
  // The token IS the credential on this page — without one it renders the
  // "this link is no longer valid" state and its form never mounts, so the
  // route has to be entered the way the emailed link enters it.
  { at: '/reset-password?token=demo-token', anon: true, label: 'reset password' },
  { at: '/privacy', anon: true, label: 'privacy policy' },
  // TermsPage renders prose and no controls at all — the section nav that
  // gives PrivacyPolicyPage its ten buttons isn't used here.
  { at: '/terms', anon: true, label: 'terms', minButtons: 0 },
]

/* Buttons whose click legitimately produces no request, no navigation and no
   DOM change — so check 4 would fail them for doing exactly what they should.
   Keyed by accessible name. Each needs a reason; this is not a mute list.

   Kept deliberately short. If this grows past a handful, check 4 is measuring
   the wrong thing and should be fixed rather than exempted. */
const NO_VISIBLE_EFFECT = {
  'Copy link': 'writes to the clipboard; the toast it raises is async and may land after the check',
  'Copy password': 'clipboard only',
  // StandardsPage's view toggle starts on 'list', and re-selecting the segment
  // you are already in is correctly a no-op. Its sibling, "Visual Heatmap", is
  // NOT exempt — that one has to switch the view, and does.
  'List View': 'the already-selected segment of a segmented control; re-selecting it is meant to do nothing',
}

/* The buttons whose exact request is a contract worth pinning. A rename on the
   other side of one of these is a broken feature, and check 4 — which only
   asks whether SOMETHING happened — would not notice.

   Only buttons that issue their request from a FRESH page load belong here.
   ClassPage's "Save Changes" does not: it early-returns on `!isChanged`, so
   from an untouched form the correct behaviour is to do nothing. Pinning it
   here would have asserted the opposite of the truth. It gets a scripted flow
   at the bottom of this file instead — type first, then click. */
const NAMED_EXPECTATIONS = [
  { route: '/c/c1/settings', name: 'Save Profile', method: 'PATCH', path: '/api/me' },
]

let browser

before(async () => {
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
})

/* Back to this route's clean starting state, reusing the browser context.
   mockApi's state is rebuilt on every page load, so a navigation IS a database
   reset — the only thing that outlives it is sessionStorage, which the mock
   uses to stand in for the Stripe webhook ("mock.subscribed") and for the
   Drive connection. Clearing it is what keeps the button after a Subscribe
   click measured against the same account state as the button before it. */
async function reset(page, route) {
  await page.evaluate(() => {
    try {
      sessionStorage.clear()
      localStorage.clear()
    } catch {
      /* a context with storage blocked is still a usable one */
    }
  })
  await page.goto(pageUrl(route), { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('button, a[href], input', { timeout: NAV_TIMEOUT_MS })
  await page.waitForTimeout(350)
  await page.evaluate(() => window.__mock?.reset?.())
}

/* `at` is URL-encoded into a single param, so a route carrying its own query
   string (the reset-password token) survives intact — preview.jsx reads it back
   with params.get('at') and hands the whole thing to history.replaceState. */
const pageUrl = (route) => {
  const qs = new URLSearchParams({ at: route.at })
  if (route.anon) qs.set('anon', '1')
  return `${BASE}/preview.html?${qs}`
}

/* One page, wired for observation. Console errors and uncaught exceptions are
   collected rather than asserted here, so a single click can be blamed for the
   ones it produced. */
async function openPage(route) {
  const context = await browser.newContext({
    // "Copy link" and friends call navigator.clipboard.writeText, which
    // rejects — an uncaught rejection, i.e. a failure — without this.
    permissions: ['clipboard-read', 'clipboard-write'],
  })

  /* Fulfil every off-origin request with an empty 200 instead of letting it
     fail. Google Fonts and accounts.google.com are the only two, neither is
     load-bearing, and a network-restricted CI runner would otherwise fill the
     console with ERR_CONNECTION_RESET that this test would have to pattern-
     match its way around. Fulfilling makes the run identical everywhere. */
  await context.route('**', (r) => {
    const url = r.request().url()
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) return r.continue()
    return r.fulfill({ status: 200, contentType: 'text/plain', body: '' })
  })

  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`))
  // A file input opened by an "Upload" button blocks forever otherwise.
  page.on('filechooser', (fc) => fc.setFiles([]).catch(() => {}))
  page.setDefaultTimeout(10_000)
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS)

  // The app boots asynchronously (auth, then the shell). Wait for something
  // interactive rather than a fixed sleep.
  await page.goto(pageUrl(route), { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('button, a[href], input', { timeout: NAV_TIMEOUT_MS })
  await page.waitForTimeout(350)
  await page.evaluate(() => window.__mock?.reset?.())
  return { context, page, errors }
}

/* A cheap fingerprint of "what the page looks like now". Compared before and
   after a click to answer check 4 without knowing anything about the button.
   Length rather than content: a full-innerHTML diff would be enormous and no
   more informative for a yes/no question.

   `scroll` sums every element's scroll offset, not just the window's. The
   first version of this read window.scrollY alone and reported all ten of the
   privacy policy's section-nav buttons as doing nothing — they scroll an inner
   container, so the window never moves and scrollY never changes. Any
   "jump to" control in a scrollable pane is the same shape. */
const signature = (page) =>
  page.evaluate(() => {
    /* ONE pass over the document. The first version made six separate
       querySelectorAll calls plus a document.body.innerHTML read, twice per
       button — innerHTML serialises the entire tree into a string, and on the
       settings page that alone was most of the per-click cost. textContent
       reads as sensitively for a fraction of the work, and it doesn't force
       layout the way innerText would. */
    let scroll = 0
    let elements = 0
    let dialogs = 0
    let expanded = ''
    let pressed = ''
    let inputs = ''
    /* A rolling hash over every className. Without it the signature is blind to
       the single most common way this app shows state: a selected tab, an
       active filter chip, a pressed toggle are all a class swap on an element
       whose text and children never change. SplitLayout's class nav was
       reported as a dead button for exactly that reason — it highlights the
       row it selects, and nothing else about the page moves. */
    let classes = 0
    for (const el of document.getElementsByTagName('*')) {
      elements++
      scroll += el.scrollTop + el.scrollLeft
      const cn = typeof el.className === 'string' ? el.className : ''
      for (let i = 0; i < cn.length; i++) classes = (classes * 31 + cn.charCodeAt(i)) | 0
      /* Inline style too, because framer-motion animates through it rather
         than through classes — a rotating chevron or a collapsing panel is a
         `transform`/`height` on the element, and a signature that reads only
         className is blind to every animated toggle in the app. */
      const st = el.getAttribute('style')
      if (st) for (let i = 0; i < st.length; i++) classes = (classes * 31 + st.charCodeAt(i)) | 0
      const ae = el.getAttribute('aria-expanded')
      if (ae !== null) expanded += ae[0]
      const ap = el.getAttribute('aria-pressed')
      if (ap !== null) pressed += ap[0]
      if (el.getAttribute('role') === 'dialog' || (el.tagName === 'DIALOG' && el.hasAttribute('open'))) dialogs++
      if (el.tagName === 'INPUT') inputs += `${el.checked}${el.value}|`
    }
    /* Hashed, not measured. `text.length` misses the one thing a sort header
       does: reordering rows rearranges identical markup, so the element count,
       the class hash and the character count all come back unchanged. Every
       "Account / Status / Plans built / Tokens 7d / Joined" header in the admin
       table was reported as a dead button on that basis. */
    const raw = document.body.textContent || ''
    let text = raw.length
    for (let i = 0; i < raw.length; i++) text = (text * 31 + raw.charCodeAt(i)) | 0
    return {
      url: location.pathname + location.search + location.hash,
      elements,
      classes,
      text,
      scroll: scroll + Math.round(window.scrollY + window.scrollX),
      dialogs,
      expanded,
      pressed,
      inputs: inputs.length,
      focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName || '',
      crashed: raw.includes('Something went wrong'),
    }
  })

/* Every enabled, visible button on the page right now.
 *
 * Each carries its accessible name and its ORDINAL among visible buttons
 * sharing that name — which is what a click resolves through, not the DOM
 * index. The index is a snapshot, and on a page still settling (the admin page
 * mounts eight independent queries) a re-render between enumerating and
 * clicking shifts it, so the click lands on a neighbour and the neighbour gets
 * blamed. That is what reported all five admin sort headers as dead buttons
 * while clicking them by hand changed the table every time. A Playwright
 * locator resolves at action time instead, so the race has nowhere to happen.
 */
const enumerate = async (page) => {
  const found = await page.$$eval('button', (els) => {
    const seen = new Map()
    return els.map((el) => {
      const style = getComputedStyle(el)
      /* A zero-height box counts as not visible. offsetParent alone said yes
         to the sign-in page's collapsed "forgot password" panel, whose Send
         link button is in the DOM at height 0 behind a framer-motion collapse
         — and a click on it never resolved, because there is nothing there to
         click. A button a person cannot hit is not a button under test. */
      const box = el.getBoundingClientRect()
      const visible = box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      // Same precedence the accessibility tree uses for these three, which is
      // all this app relies on: aria-label, then title, then contents.
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
      let ordinal = -1
      if (visible) {
        ordinal = seen.get(name) ?? 0
        seen.set(name, ordinal + 1)
      }
      return { name, ordinal, visible, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' }
    })
  })
  return found
}

/* The locator for one enumerated button. `filter({ visible: true })` keeps the
   ordinal counting the same buttons enumerate counted — the app renders a
   desktop table and a mobile card list from the same data, so half the
   same-named buttons on a page are hidden at any width. */
const locate = (page, b) =>
  page.getByRole('button', { name: b.name, exact: true }).filter({ visible: true }).nth(b.ordinal)

/* Did the page move? One definition, used by both the click loop and the
   keyboard check — they had two, and when signature()'s fields were renamed
   only one of them was updated. The stale copy compared undefined to undefined
   for every button, reported "Enter did nothing" for four controls that worked
   perfectly, and would have had someone debugging the app instead of the test.
   `crashed` is excluded: it is asserted separately, not evidence of a click. */
const changed = (before, after) => Object.keys(before).some((k) => k !== 'crashed' && before[k] !== after[k])

/* Wait just long enough for the click to have finished doing whatever it does.
   A flat 700ms per button costs four minutes across the app and is still a
   guess. This settles as soon as the page stops issuing requests, and only
   waits out the long tail when there is one to wait out — mockApi's slowest
   deliberate latency is the 1500ms revise path. */
async function settle(page) {
  let last = -1
  for (let i = 0; i < 12; i++) {
    const n = await page.evaluate(() => (window.__mock?.calls || []).length)
    if (n === last && i > 0) return
    last = n
    await page.waitForTimeout(i === 0 ? 200 : 150)
  }
}

/* BUTTONS_ROUTE narrows the run to routes whose path contains it. Iterating on
   one page's failures should not cost a whole-suite run. */
const ONLY = process.env.BUTTONS_ROUTE
const SELECTED = ROUTES.filter((r) => !ONLY || r.at.includes(ONLY))

/* Routes are independent — separate contexts, separate mock state — so they
   crawl in parallel. Serially this is a twenty-minute suite, which is a suite
   nobody runs locally and a CI bill nobody wants; four at a time cuts it to a
   few minutes without making any single route's result depend on another's. */
describe('buttons', { concurrency: 4 }, () => {
  for (const route of SELECTED) {
    test(`buttons — ${route.label} (${route.at})`, async () => {
      const { context, page, errors } = await openPage(route)
      try {
        const initial = await enumerate(page)
        const minButtons = route.minButtons ?? 1
        assert.ok(
          initial.length >= minButtons,
          `${route.at} rendered ${initial.length} buttons, expected at least ${minButtons} — ` +
            `a route that renders nothing has failed, not finished`
        )

        // ── check 1, for every button on the page, before any of them move ────
        const nameless = initial.filter((b) => b.visible && !b.name)
        assert.equal(
          nameless.length,
          0,
          `${route.at}: ${nameless.length} visible button(s) with no accessible name ` +
            `(index ${nameless.map((b) => b.index).join(', ')}). Add an aria-label — an icon ` +
            `alone names nothing for a screen reader.`
        )

        const clickable = initial.filter((b) => b.visible && !b.disabled)
        const failures = []

        for (const target of clickable) {
          // Re-resolve by name each time: an earlier click may have re-rendered
          // the list, and a stale index would click something else and blame it
          // on this button.
          let live = await enumerate(page)
          let match = live.find((b) => b.name === target.name && b.visible && !b.disabled)
          if (!match) {
            // Gone — a previous click navigated or collapsed the section. Back to
            // the route's clean state and look again.
            await reset(page, route)
            live = await enumerate(page)
            match = live.find((b) => b.name === target.name && b.ordinal === target.ordinal && b.visible && !b.disabled)
            if (!match) continue // genuinely conditional; the reload didn't render it
          }

          errors.length = 0
          await page.evaluate(() => window.__mock?.reset?.())
          const before = await signature(page)

          try {
            await locate(page, match).click({ timeout: 5000, noWaitAfter: true })
          } catch (err) {
            failures.push(`"${target.name}" — click failed: ${err.message.split('\n')[0]}`)
            continue
          }

          await settle(page)

          const after = await signature(page)
          const state = await page.evaluate(() => ({
            calls: (window.__mock?.calls || []).map((c) => ({ path: c.path, method: c.method, status: c.status })),
            unhandled: (window.__mock?.unhandled || []).map((u) => `${u.method} ${u.path}`),
          }))

          // ── check 2 ──────────────────────────────────────────────────────────
          if (after.crashed) failures.push(`"${target.name}" — click rendered the ErrorBoundary crash screen`)
          if (errors.length) failures.push(`"${target.name}" — console error: ${errors[0].slice(0, 200)}`)

          // ── check 3 ──────────────────────────────────────────────────────────
          if (state.unhandled.length) {
            failures.push(
              `"${target.name}" — called an endpoint mockApi does not handle: ${[...new Set(state.unhandled)].join(', ')}. ` +
                `Either the app calls the wrong path, or src/dev/mockApi.js needs that route.`
            )
          }
          const failed = state.calls.filter((c) => c.status !== null && c.status >= 500)
          if (failed.length) failures.push(`"${target.name}" — request failed: ${failed.map((c) => `${c.method} ${c.path} -> ${c.status}`).join(', ')}`)

          // ── check 4 ──────────────────────────────────────────────────────────
          const didSomething = state.calls.length > 0 || changed(before, after)
          if (!didSomething && !NO_VISIBLE_EFFECT[target.name]) {
            failures.push(
              `"${target.name}" — clicking it did nothing: no request, no navigation, no DOM change. ` +
                `If that is correct, add it to NO_VISIBLE_EFFECT with a reason.`
            )
          }

          // ── the pinned contracts ─────────────────────────────────────────────
          for (const exp of NAMED_EXPECTATIONS) {
            if (exp.route !== route.at || exp.name !== target.name) continue
            const hit = state.calls.find(
              (c) => c.method === exp.method && (exp.path ? c.path === exp.path : c.path.startsWith(exp.pathStartsWith))
            )
            if (!hit) {
              failures.push(
                `"${target.name}" — expected ${exp.method} ${exp.path || `${exp.pathStartsWith}…`}, ` +
                  `got ${state.calls.map((c) => `${c.method} ${c.path}`).join(', ') || 'no requests at all'}`
              )
            }
          }

          // Back to a known page if the click moved us, so the next button is
          // measured from the same starting state this one was.
          if (before.url !== after.url || after.dialogs > before.dialogs) {
            await reset(page, route)
          }
        }

        assert.equal(failures.length, 0, `${route.at} — ${failures.length} button problem(s):\n  ${failures.join('\n  ')}`)
      } finally {
        await context.close()
      }
    })
  }
})

/* Keyboard parity, on a sample rather than everything: a control that responds
   to a mouse and not to Enter is broken for anyone who doesn't use one, and
   this app has shipped exactly that (see ArtifactDetailPanel.jsx's own note on
   the <span aria-disabled> it used to be). A native <button> gets this for
   free, so this is really checking that the app hasn't reached for a div. */
test('buttons respond to the keyboard, not only the mouse', async () => {
  const { context, page } = await openPage({ at: '/c/c1' })
  try {
    const names = (await enumerate(page)).filter((b) => b.visible && !b.disabled).slice(0, 8)
    const failures = []
    for (const b of names) {
      await page.evaluate(() => window.__mock?.reset?.())
      const before = await signature(page)
      await locate(page, b).focus()
      const focused = await page.evaluate(() => document.activeElement?.tagName)
      if (focused !== 'BUTTON') {
        failures.push(`"${b.name}" — could not take keyboard focus (activeElement was ${focused})`)
        continue
      }
      await page.keyboard.press('Enter')
      await page.waitForTimeout(500)
      const after = await signature(page)
      const calls = await page.evaluate(() => (window.__mock?.calls || []).length)
      if (calls === 0 && !changed(before, after) && !NO_VISIBLE_EFFECT[b.name]) {
        failures.push(`"${b.name}" — Enter did nothing, though a click does`)
      }
      if (before.url !== after.url) break // navigated; the rest of the sample is stale
    }
    assert.equal(failures.length, 0, `keyboard activation:\n  ${failures.join('\n  ')}`)
  } finally {
    await context.close()
  }
})

/* Scripted flows: the buttons whose contract only exists after something has
 * been typed. The crawl above clicks from a fresh page, which is the right
 * default — but a Save guarded by "has anything changed?" correctly does
 * nothing from there, and asserting otherwise pins the wrong behaviour.
 *
 * These are the pattern to copy when a button needs setup. Keep the setup to
 * what the button genuinely requires: a flow that reconstructs half a page
 * before clicking is testing the flow, not the button.
 */
const FLOWS = [
  {
    name: 'Save Changes sends the edited class name',
    route: { at: '/c/c1/class' },
    async run(page) {
      // The class name field, then the Save the form's own `isChanged` guard
      // is waiting on. ClassPage.jsx submit(): `if (!isChanged) return`.
      const field = page.locator('input[type="text"]').first()
      await field.fill('AP Language — period 3')
      await page.getByRole('button', { name: 'Save Changes' }).click()
    },
    expect: { method: 'PATCH', pathStartsWith: '/api/classes/' },
  },
]

for (const flow of FLOWS) {
  test(`flow — ${flow.name}`, async () => {
    const { context, page } = await openPage(flow.route)
    try {
      await flow.run(page)
      await settle(page)
      const calls = await page.evaluate(() =>
        (window.__mock?.calls || []).map((c) => ({ path: c.path, method: c.method, body: c.body, status: c.status }))
      )
      const hit = calls.find(
        (c) =>
          c.method === flow.expect.method &&
          (flow.expect.path ? c.path === flow.expect.path : c.path.startsWith(flow.expect.pathStartsWith))
      )
      assert.ok(
        hit,
        `expected ${flow.expect.method} ${flow.expect.path || `${flow.expect.pathStartsWith}…`}, got ` +
          `${calls.map((c) => `${c.method} ${c.path}`).join(', ') || 'no requests at all'}`
      )
      assert.ok(hit.status < 400, `${hit.method} ${hit.path} answered ${hit.status}`)
    } finally {
      await context.close()
    }
  })
}
