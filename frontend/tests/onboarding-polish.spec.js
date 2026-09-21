import { expect, test } from '@playwright/test'

async function chooseClass(page) {
  await page.getByLabel('State', { exact: true }).selectOption('AL')
  await page.getByLabel('Grade', { exact: true }).selectOption('11')
  await page.getByRole('searchbox', { name: 'Search courses' }).fill('AP English Language')
  await page.getByRole('radio', { name: /AP English Language/ }).check()
}

async function countChatRequests(page) {
  // The stream transport may capture fetch before this step. Count at the
  // installed mock boundary so module-load order cannot bypass the assertion.
  await page.evaluate(() => window.__mock.reset())
}

async function chatRequestCount(page) {
  return page.evaluate(() => window.__mock.calls.filter((call) => call.path === '/api/chat_stream').length)
}

test('two-step setup preserves the actual topic and starts one first-plan request', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/preview.html?fresh=1')
  await expect(page.getByRole('heading', { name: 'Which class are we planning for?' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'All grades', exact: true })).toHaveCount(0)
  await chooseClass(page)
  await page.getByRole('button', { name: 'Continue to my first week' }).click()
  await expect(page.getByRole('heading', { name: 'What are you teaching next?' })).toBeVisible()
  await expect(page.locator('.onboarding-avatar-wide')).toHaveCount(0)
  await expect(page.getByText('A source from your course')).toBeVisible()
  await page.getByLabel('Topic, text, or skill').fill('Compare the arguments in two speeches and write a response on Friday.')
  await countChatRequests(page)
  await page.getByRole('button', { name: 'Build my first plan' }).click()
  await expect.poll(() => chatRequestCount(page)).toBe(1)
  await expect.poll(() => page.evaluate(() => window.__mock.state.lastPrompt || '')).toContain('Compare the arguments in two speeches')
  await expect(page).toHaveURL(/\/c\/[^/]+\/chat\//)
  await expect(page.locator('.plan-table')).toBeVisible({ timeout: 15_000 })
  expect(await page.evaluate(() => window.__mock.state.ownedPlanIds.length)).toBe(1)
  expect(await chatRequestCount(page)).toBe(1)
  expect(errors).toEqual([])
})

test('unfinished class choices resume after refresh without a profile step', async ({ page }) => {
  await page.goto('/preview.html?fresh=1')
  await chooseClass(page)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Which class are we planning for?' })).toBeVisible()
  await expect(page.getByLabel('State', { exact: true })).toHaveValue('AL')
  await expect(page.getByLabel('Grade', { exact: true })).toHaveValue('11')
  await expect(page.getByRole('radio', { name: /AP English Language/ })).toBeChecked()
  await expect(page.getByRole('button', { name: 'Continue to my first week' })).toBeEnabled()
})

test('a saved class and unfinished first-week topic resume without a duplicate class', async ({ page }) => {
  await page.goto('/preview.html?fresh=1&persist=1')
  await chooseClass(page)
  await page.getByRole('button', { name: 'Continue to my first week' }).click()
  await page.getByLabel('Topic, text, or skill').fill('Resume this close reading lesson')
  const classId = await page.evaluate(() => window.__mock.state.classes[0].id)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'What are you teaching next?' })).toBeVisible()
  await expect(page.getByLabel('Topic, text, or skill')).toHaveValue('Resume this close reading lesson')
  expect(await page.evaluate(() => window.__mock.state.classes.map((row) => row.id))).toEqual([classId])
})

test('unsupported state keeps grade explicit and saves context without promising generation', async ({ page }) => {
  await page.goto('/preview.html?fresh=1')
  await page.getByLabel('State', { exact: true }).selectOption('TX')
  await page.getByLabel('Grade', { exact: true }).selectOption('3')
  await page.getByLabel('Course name', { exact: true }).fill('English Language Arts')
  await page.getByRole('button', { name: 'Continue to my first week' }).click()
  await page.getByLabel('Topic, text, or skill').fill('Compare two stories')
  await countChatRequests(page)
  await expect(page.getByRole('button', { name: 'Build my first plan' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Save my teaching context' }).click()
  await expect(page).toHaveURL(/\/c\/[^/]+$/)
  await expect(page.locator('#composer-input')).toHaveValue('Compare two stories')
  expect(await chatRequestCount(page)).toBe(0)
})

test('setup remains usable on a phone with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/preview.html?fresh=1')
  await chooseClass(page)
  await page.getByRole('button', { name: 'Continue to my first week' }).click()
  await expect(page.getByRole('heading', { name: 'What are you teaching next?' })).toBeVisible()
  await expect(page.getByLabel('Topic, text, or skill')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const target = page.getByRole('button', { name: 'Build my first plan' })
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.x + box.width).toBeLessThanOrEqual(375)
})
