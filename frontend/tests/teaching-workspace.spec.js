import { expect, test } from '@playwright/test'

// The document/teaching switch has been removed from the lesson reader.
// Keep these scenarios for a future teaching entry point; persistence and
// review invalidation remain covered by backend/test_teaching_workflow.py.
test.skip(true, 'Teaching workspace has no navigation entry in the simplified reader')

const workspace = '/preview.html?fresh=0&persist=1&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1'

test('teaching reviews and reflections survive reload and inform the next week', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(workspace)
  await page.getByRole('button', { name: 'Teach & review', exact: true }).click()
  await page.getByRole('button', { name: 'Monday', exact: true }).click()
  await page.getByLabel('The activities and assessment match the learning target').check()
  await page.getByLabel('Lesson progress', { exact: true }).selectOption('taught')
  await page.getByLabel('What should next week take into account?').fill('Spend more time comparing the evidence in two speeches.')
  await page.getByRole('button', { name: 'Save teaching notes', exact: true }).click()
  await expect(page.getByText('Teaching notes saved', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Teach & review', exact: true }).click()
  await page.getByRole('button', { name: 'Monday', exact: true }).click()
  await expect(page.getByLabel('Lesson progress', { exact: true })).toHaveValue('taught')
  await expect(page.getByLabel('The activities and assessment match the learning target')).toBeChecked()
  await expect(page.getByLabel('What should next week take into account?')).toHaveValue('Spend more time comparing the evidence in two speeches.')
  await page.getByRole('button', { name: 'Plan next week', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__mock.state.lastPrompt || '')).toContain('Spend more time comparing the evidence')
  expect(errors).toEqual([])
})

test('editing a lesson creates recoverable history and invalidates the prior teaching review', async ({ page }) => {
  await page.goto(workspace)
  await page.getByRole('button', { name: 'Teach & review', exact: true }).click()
  await page.getByRole('button', { name: 'Monday', exact: true }).click()
  await page.getByLabel('Lesson progress', { exact: true }).selectOption('taught')
  await page.getByRole('button', { name: 'Save teaching notes', exact: true }).click()
  await expect(page.getByText('Teaching notes saved', { exact: true })).toBeVisible()
  // Exercise the same edit endpoint as the document editor, with no paid model.
  await page.evaluate(async () => {
    await fetch('/api/revise_day', { method: 'POST', body: JSON.stringify({ plan_id: 'plan1', day_index: 0, field: 'during', feedback: 'Compare two speeches in pairs' }) })
  })
  await page.reload()
  await page.getByRole('button', { name: 'Teach & review', exact: true }).click()
  await page.getByRole('button', { name: 'Monday', exact: true }).click()
  await expect(page.getByText('This lesson changed since your last review.', { exact: false })).toBeVisible()
  await expect(page.getByLabel('Lesson progress', { exact: true })).toHaveValue('planned')
  await page.getByRole('button', { name: 'Version history', exact: true }).click()
  await page.getByRole('button', { name: /^Version 1 / }).click()
  await page.getByRole('button', { name: 'Restore version 1', exact: true }).click()
  await expect(page.getByText('Version restored. The document is being rebuilt.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Version 3 · current/ })).toBeVisible()
})

test('teaching workspace fits a phone and keeps lesson controls reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(workspace)
  await page.getByRole('button', { name: 'Teach & review', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ready to teach?', exact: true })).toBeAttached()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Save teaching notes', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Save teaching notes', exact: true })).toBeInViewport()
})
