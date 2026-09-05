import { expect, test } from '@playwright/test'

/* This preview test stays credential-free and deterministic. It exercises the
   app-owned modal lifecycle; Stripe's own fields and confirmation paths need a
   real test-mode publishable key and a Checkout Session created by the backend.
   Those are covered by the manual test-mode pass documented in README.md. */
test('opens and closes the embedded checkout surface on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/preview.html?at=/c/c1/settings')
  await page.getByRole('button', { name: 'Billing', exact: true }).click()

  const subscribe = page.getByRole('button', { name: /^Subscribe$/ }).last()
  await expect(subscribe).toBeVisible()
  await subscribe.click()

  const paywall = page.getByRole('dialog')
  await expect(paywall).toBeVisible()
  await expect(paywall.getByText(/Preview only — no payment details are collected/)).toBeVisible()
  await expect(paywall.getByRole('button', { name: /^Subscribe ·/ })).toBeDisabled()
  const bounds = await paywall.boundingBox()
  expect(bounds.width).toBeLessThanOrEqual(390)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(845)

  await paywall.getByRole('button', { name: 'Close checkout' }).click()
  await expect(paywall).toHaveCount(0)
})
