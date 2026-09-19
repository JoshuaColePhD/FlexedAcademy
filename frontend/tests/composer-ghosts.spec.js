import { expect, test } from '@playwright/test'

test('composer ghosts are grounded in the class week and materials', async ({ page }) => {
  await page.goto('/preview.html?fresh=0&trial=3&at=/c/c1')
  const input = page.locator('#composer-input')
  await expect(input).toBeVisible()

  const ghost = page.locator('.composer-ghost')
  await expect(ghost).toHaveText(/Plan Week \d+ around the current unit and pacing guide\./)
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText('THE PLAN SO FAR')
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText('I want to revise')
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText("Help me plan tomorrow")
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText("Revise this week's plan")
  await expect(page.locator('.composer-ghost-overlay')).not.toContainText('Write a lesson for this week')

  const prompt = (await ghost.textContent()) || ''
  await input.pressSequentially('Plan')
  await expect(ghost).toHaveText(prompt.slice('Plan'.length))
  await input.press('Tab')
  await expect(input).toHaveValue(prompt)
})
