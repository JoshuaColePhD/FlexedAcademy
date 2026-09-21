import { expect, test } from '@playwright/test'

const url = '/preview.html?fresh=0&voice=1&beta=1&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1'
async function open(page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new Error('This is a microphone-free preview test') }
  })
  await page.goto(url)
  await page.getByRole('button', { name: 'Plan with voice', exact: true }).last().click()
}
async function say(page, text) {
  await page.getByRole('textbox', { name: 'Practice a spoken teaching idea', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send teaching idea', exact: true }).click()
}
async function revise(page) {
  const before = await page.evaluate(() => structuredClone(window.__mock.state.plans.plan1))
  await say(page, 'Revise this lesson to include more language support on Wednesday.')
  await expect(page.locator('.lesson-change-receipt')).toContainText('Wednesday updated')
  await expect(page.getByRole('button', { name: 'Undo voice lesson change', exact: true })).toBeEnabled()
  return before
}
test('a spoken edit highlights Wednesday, restores the saved version with Undo, and keeps the draft', async ({ page }) => {
  await open(page)
  const before = await revise(page)
  await expect(page.locator('.doc-body .fa-flash').first()).toBeAttached()
  await expect(page.getByRole('complementary', { name: 'Voice session details', exact: true }).getByText('Revise this lesson to include more language support on Wednesday.', { exact: true })).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Practice a spoken teaching idea', exact: true })
  await input.fill('Keep this unfinished thought.')
  await page.getByRole('button', { name: 'Undo voice lesson change', exact: true }).click()
  await expect(page.locator('.lesson-change-receipt')).toHaveCount(0)
  expect(await page.evaluate(() => window.__mock.state.plans.plan1)).toEqual(before)
  expect(await page.evaluate(() => window.__mock.state.versions.plan1.at(-1).revision)).toBe(3)
  await expect(input).toHaveValue('Keep this unfinished thought.')
  await expect(page.locator('.doc-head')).toContainText('Saved')
})
test('Undo refuses a concurrent saved edit between fetching history and restoring', async ({ page }) => {
  await open(page)
  await revise(page)
  await page.evaluate(() => {
    const fetch = window.fetch
    window.fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (String(input).endsWith('/api/teaching/plans/plan1/versions')) {
        const state = window.__mock.state
        state.plans.plan1.days[0].during = 'A newer edit from another session.'
        state.versions.plan1.push({ revision: state.versions.plan1.at(-1).revision + 1, plan_json: structuredClone(state.plans.plan1) })
      }
      return response
    }
  })
  await page.getByRole('button', { name: 'Undo voice lesson change', exact: true }).click()
  await expect(page.locator('.lesson-change-receipt [role="alert"]')).toContainText('changed plan')
  expect(await page.evaluate(() => window.__mock.state.plans.plan1.days[0].during)).toBe('A newer edit from another session.')
  await expect(page.getByRole('button', { name: 'Undo voice lesson change', exact: true })).toBeEnabled()
})
test('ending voice while Undo is saving still restores the document and releases editing', async ({ page }) => {
  await open(page)
  const before = await revise(page)
  await page.evaluate(() => {
    const fetch = window.fetch
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/restore')) await new Promise(resolve => setTimeout(resolve, 400))
      return fetch(input, init)
    }
  })
  await page.getByRole('button', { name: 'Undo voice lesson change', exact: true }).click()
  await page.getByRole('button', { name: 'End voice conversation', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__mock.state.plans.plan1)).toEqual(before)
  await expect(page.locator('.doc-head')).toContainText('Saved')
  await expect(page.getByRole('button', { name: 'Edit Wednesday During', exact: true })).toBeEnabled()
})
test('an exploratory voice question discusses the idea without editing the plan', async ({ page }) => {
  await open(page)
  const before = await page.evaluate(() => structuredClone(window.__mock.state.plans.plan1))
  await say(page, 'Would a debate work on Friday?')
  await expect(page.locator('.voice-details-transcript')).toContainText('A debate could work')
  expect(await page.evaluate(() => window.__mock.state.plans.plan1)).toEqual(before)
  expect(await page.evaluate(() => window.__mock.calls.filter(call => call.path === '/api/generate_stream').length)).toBe(0)
  await expect(page.locator('.lesson-change-receipt')).toHaveCount(0)
})
