import { expect, test } from '@playwright/test'

async function open(page) {
  await page.goto('/preview.html?fresh=0&persist=1&trial=7&at=/c/c1/chat/seed1')
  await expect(page.getByText(/Based on \d+ standards?/)).toBeVisible()
  await page.evaluate(() => {
    const original = window.fetch
    window.requests = []
    window.fetch = async (input, init = {}) => {
      if (String(input).includes('/api/chat_stream')) {
        window.requests.push(JSON.parse(init.body))
        return new Response('data: {"chunk":"A focused comparison for your class."}\n\ndata: {"done":true}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      }
      return original(input, init)
    }
  })
}

test('editing an earlier turn branches before the discarded exchange and leaves original intact', async ({ page }) => {
  await open(page)
  const original = await page.evaluate(() => structuredClone(window.__mock.state.messages.seed1))
  await page.getByRole('button', { name: 'Edit and send again', exact: true }).first().click()
  await page.getByLabel('Edit your message').fill('Use a short speech instead of the original text.')
  await page.getByRole('button', { name: 'Send again', exact: true }).click()
  await expect(page).not.toHaveURL(/\/chat\/seed1$/)
  await expect(page.getByText('A focused comparison for your class.', { exact: true })).toBeVisible()
  const result = await page.evaluate(() => ({ original: window.__mock.state.messages.seed1, request: window.requests.at(-1), child: window.__mock.state.chats.at(-1) }))
  expect(result.original).toEqual(original)
  expect(result.child.parent_chat_id).toBe('seed1')
  expect(result.request.messages.at(-1).content).toBe('Use a short speech instead of the original text.')
  expect(result.request.messages).toHaveLength(1)
})

test('regenerate creates a clean alternative without the prior response', async ({ page }) => {
  await open(page)
  await page.locator('#composer-input').fill('Compare two ways to teach commentary.')
  await page.locator('#composer-input').press('Enter')
  await expect(page.getByText('A focused comparison for your class.', { exact: true })).toBeVisible()
  const original = await page.evaluate(() => structuredClone(window.__mock.state.messages.seed1.slice(0, 2)))
  await page.getByRole('button', { name: 'Regenerate this reply', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.requests.length)).toBe(2)
  const result = await page.evaluate(() => ({ original: window.__mock.state.messages.seed1, request: window.requests.at(-1) }))
  expect(result.original.slice(0, 2)).toEqual(original)
  expect(result.original.map((message) => message.content).slice(2)).toEqual(['Compare two ways to teach commentary.', 'A focused comparison for your class.'])
  expect(result.request.messages.filter((m) => m.content === 'Compare two ways to teach commentary.')).toHaveLength(1)
  expect(result.request.messages.some((m) => m.content === 'A focused comparison for your class.')).toBe(false)
})

test('conversation attachments survive reload and remain scoped to the same chat', async ({ page }) => {
  await open(page)
  await page.locator('.composer-shell input[type=file]').setInputFiles({ name: 'Reading.txt', mimeType: 'text/plain', buffer: Buffer.from('A synthetic reading.') })
  await expect(page.getByRole('button', { name: 'Remove Reading.txt', exact: true })).toBeVisible()
  await page.locator('#composer-input').fill('Use this source for our discussion.')
  await page.locator('#composer-input').press('Enter')
  await expect(page.getByText('A focused comparison for your class.', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.__mock.state.messages.seed1.find((m) => m.content === 'Use this source for our discussion.')?.source_ids_json?.length)).toBe(1)
  await page.reload()
  await expect(page.locator('#composer-input')).toBeVisible()
  const saved = await page.evaluate(() => window.__mock.state.chatSources.seed1)
  expect(saved).toHaveLength(1)
  expect(saved[0].filename).toBe('Reading.txt')
  await expect(page.getByText('Conversation sources', { exact: true })).toBeVisible()
})

test('narrow lesson reader opens a focused day and can switch to the full week without moving the composer', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 })
  await open(page)
  await page.getByRole('button', { name: /^Open Week 03/ }).click()
  await expect(page.locator('.plan-deck')).toBeVisible()
  await page.getByRole('button', { name: 'Wednesday', exact: true }).click()
  await page.setViewportSize({ width: 1024, height: 850 })
  await expect.poll(async () => {
    const card = await page.locator('.plan-day-card[aria-label="Wednesday"]').boundingBox()
    const rail = await page.locator('.plan-deck-scroller').boundingBox()
    return Math.abs(card.x - rail.x)
  }).toBeLessThan(2)
  const before = await page.locator('.composer-shell').boundingBox()
  await page.getByRole('button', { name: 'Show full week', exact: true }).click()
  await expect(page.locator('.plan-deck')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Show one day at a time', exact: true })).toBeVisible()
  expect(await page.locator('.composer-shell').boundingBox()).toEqual(before)
})

test('opening a changed field from chat aligns the day and loads its saved text', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 850 })
  await page.goto('/preview.html?fresh=0&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1')
  await page.locator('#composer-input').fill('Revise this lesson to include more language support on Wednesday.')
  await page.locator('#composer-input').press('Enter')
  await page.getByRole('button', { name: 'Wednesday’s during', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Editing Wednesday · During', exact: true })
  await expect(editor).toContainText('Language support added.')
  await expect.poll(async () => {
    const card = await page.locator('.plan-day-card[aria-label="Wednesday"]').boundingBox()
    const rail = await page.locator('.plan-deck-scroller').boundingBox()
    return Math.abs(card.x - rail.x)
  }).toBeLessThan(2)
  await editor.fill('A teacher-edited rehearsal with language support.')
  await page.locator('#composer-input').click()
  await expect.poll(() => page.evaluate(() => window.__mock.state.plans.plan1.days.find((day) => day.name === 'Wednesday').during)).toBe('A teacher-edited rehearsal with language support.')
})
