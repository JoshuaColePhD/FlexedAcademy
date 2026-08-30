import { expect, test } from '@playwright/test'

const enabled = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD && process.env.E2E_CLASS_ID)

async function signIn(page) {
  await page.goto('/login')
  await page.getByLabel(/email/i).fill(process.env.E2E_EMAIL)
  await page.getByLabel(/password/i).fill(process.env.E2E_PASSWORD)
  await page.getByRole('button', { name: /^sign in$/i }).click()
  await page.waitForURL(new RegExp(`/c/${process.env.E2E_CLASS_ID}`))
}

test.describe('desktop teacher workflow', () => {
  test.skip(!enabled, 'Set E2E_EMAIL, E2E_PASSWORD, and E2E_CLASS_ID for the disposable staging account.')

  test('signs in, opens a plan, and keeps the document controls reachable', async ({ page }) => {
    await signIn(page)
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

  test('opens the mode picker and delivers one typed turn after a mocked stream', async ({ page }) => {
    await signIn(page)

    const composer = page.getByRole('textbox', { name: /lesson plan|what are you teaching|revise|what do you need/i }).last()
    await expect(composer).toBeVisible()

    await page.getByRole('button', { name: /more composer actions/i }).click()
    await expect(page.getByRole('menuitemradio', { name: /Coach.*veteran teacher/i })).toBeVisible()
    await page.getByRole('menuitemradio', { name: /Coach.*veteran teacher/i }).click()

    // Keep this test cheap and deterministic: it verifies the browser's
    // submit/stream lifecycle without spending a model call. The real
    // authenticated endpoint is exercised by the deployment smoke/pilot
    // checks; this route proves one click produces one logical request and
    // settles the visible assistant bubble.
    let streamRequests = 0
    await page.route('**/api/chat_stream', async (route) => {
      streamRequests += 1
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: [
          'data: {"status":"accepted","label":"Request received"}\n\n',
          'data: {"chunk":"Hello back."}\n\n',
          'data: {"done":true}\n\n',
        ].join(''),
      })
    })

    await composer.fill('hello')
    await composer.press('Enter')
    await expect.poll(() => streamRequests, { timeout: 15_000 }).toBe(1)
    await expect(page.getByText('Hello back.', { exact: true })).toBeVisible()
  })
})
