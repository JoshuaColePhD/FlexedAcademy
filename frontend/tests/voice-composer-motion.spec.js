import { expect, test } from '@playwright/test'

const preview = '/preview.html?fresh=0&voice=1&beta=1&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1'

async function sampleDuring(page, action) {
  const sampling = page.evaluate(() => new Promise((resolve) => {
    const samples = []
    const start = performance.now()
    const frame = () => {
      const shell = document.querySelector('.composer-shell')
      if (!shell) { resolve([...samples, { missing: true }]); return }
      const box = shell.getBoundingClientRect()
      const style = getComputedStyle(shell)
      samples.push({ left: box.left, bottom: box.bottom, width: box.width, height: box.height, radius: style.borderRadius, transform: style.transform })
      if (performance.now() - start < 650) requestAnimationFrame(frame)
      else resolve(samples)
    }
    requestAnimationFrame(frame)
  }))
  await action()
  return sampling
}

function expectStable(samples) {
  expect(samples.length).toBeGreaterThan(5)
  expect(samples.some((sample) => sample.missing)).toBe(false)
  for (const dimension of ['left', 'bottom', 'width', 'height']) {
    const values = samples.map((sample) => sample[dimension])
    expect(Math.max(...values) - Math.min(...values), `${dimension} must stay stable during voice motion`).toBeLessThanOrEqual(1)
  }
  expect(new Set(samples.map((sample) => sample.radius)).size).toBe(1)
  expect(samples.every((sample) => sample.transform === 'none')).toBe(true)
}

for (const viewport of [{ width: 1100, height: 800 }, { width: 390, height: 844 }]) {
  test(`voice motion leaves the composer stable at ${viewport.width}px`, async ({ page }) => {
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.addInitScript(() => {
      window.__micRequests = 0
      navigator.mediaDevices.getUserMedia = async () => { window.__micRequests++; throw new Error('Use simulated voice only') }
    })
    // A phone's deep-linked reader replaces the chat entirely. Exercise the
    // voice button in its composer, rather than the reader's return-to-chat link.
    await page.goto(viewport.width < 768 ? preview.replace('%3Fplan=plan1', '') : preview)
    await expect(page.locator('#composer-input')).toBeVisible()
    // Finish the existing reader entrance before measuring the voice entrance.
    await page.waitForTimeout(500)
    await expect(page.locator('#composer-input')).toBeVisible()
    await page.evaluate(() => { window.__originalComposerInput = document.querySelector('#composer-input') })
    expectStable(await sampleDuring(page, () => page.getByRole('button', { name: 'Plan with voice', exact: true }).last().click()))
    const input = page.getByRole('textbox', { name: 'Practice a spoken teaching idea', exact: true })
    await input.fill('Keep this thought while voice animates.')
    expectStable(await sampleDuring(page, () => page.getByRole('button', { name: 'Replay the last reply', exact: true }).click()))
    const bars = page.locator('.voice-signal i')
    const initial = await bars.evaluateAll((elements) => elements.map((element) => element.style.transform).join())
    await expect.poll(() => bars.evaluateAll((elements) => elements.map((element) => element.style.transform).join())).not.toBe(initial)
    await expect(page.locator('.voice-stage-orb')).toHaveCount(0)
    expectStable(await sampleDuring(page, () => page.getByRole('button', { name: 'Minimize teaching conversation', exact: true }).click()))
    expectStable(await sampleDuring(page, () => page.getByRole('button', { name: 'Expand teaching conversation', exact: true }).click()))
    await expect(input).toHaveValue('Keep this thought while voice animates.')
    expectStable(await sampleDuring(page, () => page.getByRole('button', { name: 'End voice conversation', exact: true }).click()))
    await expect(page.locator('#composer-input')).toHaveValue('Keep this thought while voice animates.')
    expect(await page.evaluate(() => window.__originalComposerInput === document.querySelector('#composer-input'))).toBe(true)
    expect(await page.evaluate(() => window.__micRequests)).toBe(0)
    expect(errors).toEqual([])
  })
}

test('reduced motion keeps the voice visual still', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(preview)
  await page.getByRole('button', { name: 'Plan with voice', exact: true }).last().click()
  await expect(page.locator('.voice-signal')).toBeVisible()
  await page.getByRole('button', { name: 'Replay the last reply', exact: true }).click()
  await expect(page.locator('.voice-consultation')).toHaveAttribute('data-voice-phase', 'speaking')
  const samples = await page.locator('.voice-signal i').evaluateAll((elements) => new Promise((resolve) => {
    const samples = []
    const start = performance.now()
    const frame = () => {
      samples.push(elements.map((element) => element.style.transform).join())
      if (performance.now() - start < 300) requestAnimationFrame(frame)
      else resolve(samples)
    }
    requestAnimationFrame(frame)
  }))
  expect(new Set(samples).size).toBe(1)
  await expect.poll(() => page.locator('.voice-dock').evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length)).toBe(0)
})
