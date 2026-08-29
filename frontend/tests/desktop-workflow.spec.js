import { expect, test } from '@playwright/test'

const enabled = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD && process.env.E2E_CLASS_ID)

test.describe('desktop teacher workflow', () => {
  test.skip(!enabled, 'Set E2E_EMAIL, E2E_PASSWORD, and E2E_CLASS_ID for the disposable staging account.')

  test('signs in, opens a plan, and keeps the document controls reachable', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL)
    await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD)
    await page.getByRole('button', { name: /^sign in$/i }).click()

    await page.waitForURL(new RegExp(`/c/${process.env.E2E_CLASS_ID}`))
    await expect(page.getByRole('textbox', { name: /lesson plan|what are you teaching|revise/i })).toBeVisible()

    // A saved staging plan makes this check cost-free and deterministic. The
    // test opens the exact reader used after a build, then verifies close and
    // download remain usable after a desktop resize.
    const planCard = page.getByRole('button', { name: /open .*lesson plan|open week/i }).first()
    await expect(planCard).toBeVisible()
    await planCard.click()
    await expect(page.getByRole('region', { name: /lesson plan document/i })).toBeVisible()
    await expect(page.getByLabel(/download as docx/i)).toBeVisible()

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByLabel(/close document/i)).toBeVisible()
    await page.getByLabel(/close document/i).click()
    await expect(page.getByRole('textbox', { name: /lesson plan|what are you teaching|revise/i })).toBeVisible()
  })
})
