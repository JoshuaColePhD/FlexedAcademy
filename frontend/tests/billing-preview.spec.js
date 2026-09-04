import { expect, test } from '@playwright/test'

/* This preview test stays credential-free and deterministic. It exercises the
   app-owned modal lifecycle; Stripe's own fields and confirmation paths need a
   real test-mode publishable key and a Checkout Session created by the backend.
   Those are covered by the manual test-mode pass documented in README.md. */
test('opens and closes the embedded checkout surface on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/preview.html?at=/c/c1/settings')

  const subscribe = page.getByRole('button', { name: /^Subscribe$/ }).last()
  await expect(subscribe).toBeVisible()
  await subscribe.click()

  const paywall = page.getByRole('dialog')
  await expect(paywall).toBeVisible()
  await paywall.getByRole('button', { name: /^Subscribe$/ }).click()

  await expect(paywall).toBeVisible()
  await expect(paywall.getByText(/Local layout preview/)).toBeVisible()
  await expect(paywall).toHaveCSS('min-height', '844px')

  await paywall.getByRole('button', { name: 'Close' }).click()
  await expect(paywall).toHaveCount(0)
})
