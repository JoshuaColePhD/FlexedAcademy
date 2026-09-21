import { expect, test } from '@playwright/test'

test('composer completion uses the visible week and accepts only an explicit Tab', async ({ page }) => {
  await page.goto('/preview.html?fresh=0&trial=3&at=/c/c1')
  const input = page.locator('#composer-input')
  await expect(input).toBeVisible()

  const ghost = page.locator('.composer-ghost')
  await expect(ghost).toContainText('Week 04')
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText('Week 7')
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText('THE PLAN SO FAR')
  await expect(input).toHaveValue('')
  await input.fill('Write')
  await expect(ghost).toHaveText(' a lesson for this week.')
  await input.press('Tab')
  await expect(input).toHaveValue('Write a lesson for this week.')
  await input.fill('A different lesson about metaphors')
  await expect(ghost).toHaveCount(0)
  await expect(input).toHaveValue('A different lesson about metaphors')
})
