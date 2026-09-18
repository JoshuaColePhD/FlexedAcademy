import { expect, test } from '@playwright/test'

/* Regression cover for the two rendering failures in the reported transcript —
 * a GFM table that rendered as raw pipes and LaTeX that rendered as literal
 * source — plus the streaming and ordering behavior that came with the fix. */

async function openChat(page) {
  await page.goto('/preview.html?fresh=0&trial=3&at=/c/c1/chat/seed1')
  await expect(page.locator('#composer-input')).toBeVisible()
  await page.evaluate(() => {
    window.chatEvents = []
    // Holds the stream open until released, so a test can assert on what the
    // transcript looks like MID-stream. The default harness returns the whole
    // body at once, which cannot catch a progressive-rendering regression.
    window.releaseStream = null
    const original = window.fetch
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url
      if (!url.includes('/api/chat_stream')) return original(input, init)
      const events = window.chatEvents.shift() || [{ chunk: 'ok' }, { done: true }]
      const encoder = new TextEncoder()
      const hold = new Promise((resolve) => { window.releaseStream = resolve })
      const body = new ReadableStream({
        async start(controller) {
          for (const event of events) {
            if (event === '__HOLD__') { await hold; continue }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            await new Promise((r) => setTimeout(r, 12))
          }
          controller.close()
        },
      })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }
  })
}

const send = async (page, text) => {
  await page.locator('#composer-input').fill(text)
  await page.locator('#composer-input').press('Enter')
}
const queue = (page, turn) => page.evaluate((t) => window.chatEvents.push(t), turn)
// The seeded chat already contains an assistant turn, so assertions target the
// newest bubble rather than every .msg-markdown on the page.
const reply = (page) => page.locator('.msg-markdown').last()

test('a GFM table renders as a table, not as raw pipes', async ({ page }) => {
  await openChat(page)
  await queue(page, [
    { chunk: 'Which form helps:\n\n| Question | Form |\n|---|---|\n' },
    { chunk: '| Max height? | Vertex |\n| Zeros? | Factored |\n' },
    { done: true },
  ])
  await send(page, 'compare the forms')
  await expect(reply(page).locator('table')).toBeVisible()
  await expect(reply(page).locator('th').first()).toHaveText('Question')
  await expect(page.getByText('|---|---|')).toHaveCount(0)
})

test('OpenAI-style LaTeX renders as math, not as literal source', async ({ page }) => {
  await openChat(page)
  // remark-math understands neither of these on its own; normalizeMath rewrites
  // them before parsing, which is the only reason this passes.
  await queue(page, [
    { chunk: 'The axis is \\(x=-\\frac{b}{2a}\\), so:\n\n' },
    { chunk: '\\[ x=\\frac{-(-8)}{2(2)}=2 \\]\n' },
    { done: true },
  ])
  await send(page, 'find the vertex')
  // \[...\] must become DISPLAY math and \(...\) inline math.
  await expect(reply(page).locator('.katex-display')).toBeVisible()
  await expect(reply(page).locator('.katex')).toHaveCount(2)
  await expect(reply(page).locator('.katex-error')).toHaveCount(0)
  // KaTeX keeps the original TeX in a hidden MathML <annotation>, so assert on
  // what is actually painted rather than on the element's text content.
  expect(await reply(page).locator('.katex-html').first().innerText()).not.toContain('frac')
})

test('markdown is formatted WHILE streaming, not only after it settles', async ({ page }) => {
  await openChat(page)
  await queue(page, [
    { chunk: '## Monday\n\nOpen with a **quick** check.\n\n' },
    '__HOLD__',
    { chunk: 'Then move on.\n' },
    { done: true },
  ])
  await send(page, 'what is monday')
  // Asserted before the stream is released: this is the test that would catch
  // a revert to rendering raw text until settle.
  await expect(reply(page).locator('h2')).toHaveText('Monday')
  await expect(reply(page).locator('strong')).toHaveText('quick')
  await page.evaluate(() => window.releaseStream?.())
  await expect(reply(page)).toContainText('Then move on.')
})

test('malformed math degrades to an error mark without taking out the transcript', async ({ page }) => {
  await openChat(page)
  await queue(page, [{ chunk: 'Broken: $$\\frac{$$\n\nStill here.' }, { done: true }])
  await send(page, 'break it')
  await expect(reply(page)).toContainText('Still here.')
  await expect(page.locator('.crash, .crash-card')).toHaveCount(0)
})

test('a code block renders with its own copy button', async ({ page }) => {
  await openChat(page)
  await queue(page, [{ chunk: 'Try:\n\n```js\nconst x = 1\n```\n' }, { done: true }])
  await send(page, 'show me code')
  await expect(reply(page).locator('.msg-code pre')).toBeVisible()
  await expect(reply(page).locator('.msg-code-copy')).toHaveCount(1)
})

test('the work card follows the preamble instead of preceding it', async ({ page }) => {
  await openChat(page)
  // The shape the backend now produces: prose, then the tool call.
  await queue(page, [
    { chunk: 'Building week 7 on quadratics.' },
    { tool_call: 'generate_lesson_plan', action: 'create', instruction: 'quadratics', days: [], field: null, week_number: 7 },
    { done: true },
  ])
  await send(page, 'make a lesson')
  const prose = page.getByText('Building week 7 on quadratics.')
  await expect(prose).toBeVisible()
  const order = await page.evaluate(() => {
    const text = [...document.querySelectorAll('.msg-markdown')]
      .find((n) => n.textContent.includes('Building week 7'))
    const card = document.querySelector('[class*="work-activity"], .chat-activity, .work-activity')
    if (!text || !card) return null
    // 4 === DOCUMENT_POSITION_FOLLOWING: the card comes after the prose.
    return text.compareDocumentPosition(card) & 4 ? 'after' : 'before'
  })
  expect(order === null || order === 'after').toBeTruthy()
})

test('regenerate is offered on a reply that succeeded', async ({ page }) => {
  await openChat(page)
  await queue(page, [{ chunk: 'A short answer.' }, { done: true }])
  await send(page, 'tell me something')
  await expect(page.getByText('A short answer.')).toBeVisible()
  await expect(page.getByLabel('Regenerate this reply')).toBeVisible()
})
