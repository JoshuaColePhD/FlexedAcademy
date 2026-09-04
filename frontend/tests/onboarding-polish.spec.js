import { expect, test } from '@playwright/test'

/* The onboarding preview is a real, local first-run flow backed by mockApi;
 * it needs no account and gives layout checks a stable fixture. These assert
 * geometry rather than a screenshot so a palette or font-rendering change
 * cannot hide the regressions this pass fixed: a detached rail, an action row
 * stranded in a separate location, or a final state with no destination in the path. */
test.describe('onboarding progress journey', () => {
  test('aligns the desktop rail, keeps the action footer stationary, reserves a terminal destination, and hands focus to the next question', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/preview.html?fresh=1')

    await expect(page.locator('.onboarding-rail-step[data-terminal="true"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()

    const geometry = await page.evaluate(() => {
      const rail = document.querySelector('.onboarding-rail-slot')?.getBoundingClientRect()
      const question = document.querySelector('.onboarding-question')?.getBoundingClientRect()
      const footer = document.querySelector('.onboarding-footer')?.getBoundingClientRect()
      return { railTop: rail?.top, questionTop: question?.top, footerBottom: footer?.bottom, viewportBottom: window.innerHeight }
    })
    expect(Math.abs(geometry.railTop - geometry.questionTop)).toBeLessThanOrEqual(4)
    expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.viewportBottom)
    const profileFooterBottom = geometry.footerBottom

    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('heading', { name: 'Where do you teach?' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => ({
      active: document.activeElement?.id,
      scrollTop: document.querySelector('.onboarding-scroll')?.scrollTop,
      titles: document.querySelectorAll('#onboarding-title').length,
    }))).toEqual({ active: 'onboarding-title', scrollTop: 0, titles: 1 })

    const footerBottom = () => page.evaluate(() => document.querySelector('.onboarding-footer')?.getBoundingClientRect().bottom)
    expect(await footerBottom()).toBeCloseTo(profileFooterBottom, 0)

    await page.locator('#onboarding-state').selectOption('AL')
    await page.getByRole('button', { name: /Skip the school/ }).click()
    await expect(page.getByRole('heading', { name: 'Which course are you teaching?' })).toBeVisible()
    expect(await footerBottom()).toBeCloseTo(profileFooterBottom, 0)

    await page.locator('#onboarding-framework-listbox-AP_Lang').click()
    await page.locator('#onboarding-grade').selectOption('11')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByRole('heading', { name: 'Is this your school year?' })).toBeVisible()
    expect(await footerBottom()).toBeCloseTo(profileFooterBottom, 0)
  })

  test('keeps the compact track and fixed action footer inside a phone viewport, including reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto('/preview.html?fresh=1')

    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible()
    const layout = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      markerDuration: getComputedStyle(document.querySelector('.onboarding-rail-marker')).transitionDuration,
      footerBottom: document.querySelector('.onboarding-footer')?.getBoundingClientRect().bottom,
      viewportBottom: window.innerHeight,
    }))
    expect(layout.horizontalOverflow).toBe(false)
    // Chromium serializes the same reduced-motion duration as either 0.01ms
    // or 1e-05s, depending on the engine build.
    expect(['0.01ms', '1e-05s']).toContain(layout.markerDuration)
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.viewportBottom)
  })
})
