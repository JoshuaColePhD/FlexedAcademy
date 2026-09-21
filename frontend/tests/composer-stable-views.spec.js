import { expect, test } from '@playwright/test'

const preview = '/preview.html?fresh=0&voice=1&beta=1&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1'
const rect = (page) => page.locator('.composer-shell').evaluate((element) => {
  const { left, bottom, width, height } = element.getBoundingClientRect()
  return { left, bottom, width, height }
})

async function stableTransition(page, baseline, action) {
  const sampling = page.evaluate(() => new Promise((resolve) => {
    const frames = []
    const start = performance.now()
    const tick = () => {
      const element = document.querySelector('.composer-shell')
      if (!element) { resolve([{ missing: true }]); return }
      const { left, bottom, width, height } = element.getBoundingClientRect()
      frames.push({ left, bottom, width, height })
      if (performance.now() - start < 650) requestAnimationFrame(tick)
      else resolve(frames)
    }
    requestAnimationFrame(tick)
  }))
  await action()
  const frames = [...await sampling, await rect(page)]
  expect(frames.length).toBeGreaterThan(5)
  for (const frame of frames) {
    expect(frame.missing).toBeFalsy()
    for (const key of ['left', 'bottom', 'width', 'height']) {
      expect(Math.abs(frame[key] - baseline[key]), `Composer ${key} changed during a view switch`).toBeLessThanOrEqual(1)
    }
  }
}

for (const width of [1100, 1440]) {
  test(`composer keeps its rectangle across every desktop view at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.goto(preview)
    const input = page.locator('#composer-input')
    await expect(input).toBeVisible()
    await expect(page.locator('.composer-shell')).toHaveCSS('height', '56px')
    const baseline = await rect(page)
    await input.fill('Keep Friday unchanged.')
    await page.evaluate(() => { window.__composerOriginal = document.querySelector('#composer-input') })

    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'Close document', exact: true }).click())
    await expect(page.locator('.composer-context-line')).toHaveCount(0)
    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'Hide materials', exact: true }).click())
    await expect(page.locator('.artifact-drawer')).toHaveCount(0)
    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'Show materials', exact: true }).click())
    await stableTransition(page, baseline, () => page.getByRole('button', { name: /^Open Week 03/ }).click())
    await expect(page.locator('.composer-shell .composer-context-line')).toBeVisible()
    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click())
    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click())
    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'Plan with voice', exact: true }).click())
    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'Minimize teaching conversation', exact: true }).click())
    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'Expand teaching conversation', exact: true }).click())
    await stableTransition(page, baseline, () => page.getByRole('button', { name: 'End voice conversation', exact: true }).click())
    await expect(input).toHaveValue('Keep Friday unchanged.')
    expect(await page.evaluate(() => window.__composerOriginal === document.querySelector('#composer-input'))).toBe(true)

    await input.fill('Keep the goal.\nModel the task.\nDiscuss the evidence.')
    const draftBaseline = await rect(page)
    await stableTransition(page, draftBaseline, () => page.getByRole('button', { name: 'Close document', exact: true }).click())
    await stableTransition(page, draftBaseline, () => page.getByRole('button', { name: /^Open Week 03/ }).click())
    const fitted = await page.locator('.composer-shell').evaluate((shell) => {
      const box = shell.getBoundingClientRect()
      return [...shell.querySelectorAll('textarea, .composer-context-line, button')].every((element) => {
        const child = element.getBoundingClientRect()
        return !child.width || (child.top >= box.top && child.bottom <= box.bottom + 1)
      })
    })
    expect(fitted).toBe(true)
    await input.fill('')

    // A fresh deep link must choose the same rectangle as a reader opened
    // from chat; it must not depend on a cached pre-reader measurement.
    await page.reload()
    await expect(input).toBeVisible()
    await expect.poll(() => rect(page)).toEqual(baseline)
  })
}
