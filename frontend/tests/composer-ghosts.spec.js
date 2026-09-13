import { expect, test } from '@playwright/test'

test('composer ghosts are the two boilerplate prompts', async ({ page }) => {
  await page.goto('/preview.html?fresh=0&trial=3&at=/c/c1')
  const input = page.locator('#composer-input')
  await expect(input).toBeVisible()

  const ghost = page.locator('.composer-ghost')
  await expect(ghost).toHaveText('Write a lesson for this week')
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText('Week 7')
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText('THE PLAN SO FAR')
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText('I want to revise')
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText("Help me plan tomorrow")

  await input.pressSequentially('Revise')
  await expect(ghost).toHaveText(" this week's plan")
  await input.press('Tab')
  await expect(input).toHaveValue("Revise this week's plan")
})
