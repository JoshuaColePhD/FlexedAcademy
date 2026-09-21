import { expect, test } from '@playwright/test'

test('course totals survive search and a selected standard reaches the composer', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/preview.html?fresh=0&at=/c/c1/standards')
  const summary = page.getByRole('region', { name: 'Standards overview' })
  await expect(summary).toContainText('5 of 12 course standards')
  await page.evaluate(() => {
    const fetch = window.fetch
    window.__standardsSearches = []
    window.fetch = (input, init) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname === '/api/standards') window.__standardsSearches.push(url.searchParams.get('q'))
      return fetch(input, init)
    }
  })
  await page.getByRole('searchbox', { name: 'Search standards' }).fill('RHS-2')
  await expect.poll(() => page.evaluate(() => window.__standardsSearches)).toEqual(['RHS-2'])
  await expect(summary).toContainText('5 of 12 course standards')
  await page.getByRole('button', { name: 'Add RHS-2 to the lesson plan', exact: true }).click()
  await expect(page.locator('#composer-input')).toHaveValue(/^Focus this lesson on RHS-2:/)
  await expect(page.getByText('Added to chat', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('global command shortcuts retain the class from a nested route', async ({ page }) => {
  await page.goto('/preview.html?fresh=0&at=/c/c2/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: 'Standards', exact: true }).click()
  await expect(page).toHaveURL(/\/c\/c2\/standards$/)
})

test('the library opens an exact orphan plan without creating a chat', async ({ page }) => {
  await page.goto('/preview.html?fresh=0&at=/c/c1/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.evaluate(() => { window.__mock.state.planChat.planOrphan = null })
  await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: 'Library', exact: true }).click()
  const link = page.locator('a[href$="?plan=planOrphan"]')
  await expect(link).toBeVisible()
  const chatCount = await page.evaluate(() => window.__mock.state.chats.length)
  await link.click()
  await expect(page).toHaveURL(/\/c\/c1\?plan=planOrphan$/)
  await expect(page.locator('.plan-table')).toBeVisible()
  expect(await page.evaluate(() => window.__mock.state.chats.length)).toBe(chatCount)
})
