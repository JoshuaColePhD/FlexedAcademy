import { expect, test } from '@playwright/test'

const seed = '/preview.html?fresh=0&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1'

async function lightWorkspace(page, width = 1100) {
  await page.setViewportSize({ width, height: 800 })
  await page.addInitScript(() => localStorage.setItem('flexed.theme', 'light'))
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.goto(seed)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('.is-composer-overlay')).toBeVisible()
}

async function showThreePanels(page) {
  await page.locator('.is-composer-overlay').getByRole('button', { name: 'Close document', exact: true }).click()
  await expect(page.locator('.is-composer-overlay')).toHaveCount(0)
  const show = page.getByRole('button', { name: 'Show materials', exact: true })
  if (await show.count()) await show.click()
  await expect(page.getByRole('button', { name: 'Hide materials', exact: true })).toBeVisible()
  await expect(page.locator('.artifact-drawer')).toBeVisible()
  // The reader preserves its composer rectangle through the closing glide.
  // Measure only after the dock actually returns between the two rails.
  await expect.poll(async () => {
    const [composer, materials, nav] = await Promise.all([
      page.locator('.composer-shell').boundingBox(),
      page.locator('.artifact-drawer').boundingBox(),
      page.locator('.app-rail').boundingBox(),
    ])
    return Boolean(composer && materials && nav) && nav.width >= 219
      && materials.width >= 239 && composer.x + composer.width <= materials.x - 17
  }).toBe(true)
}

async function resolvedColor(locator, variable) {
  return locator.evaluate((element, name) => {
    const probe = document.createElement('span')
    probe.style.color = getComputedStyle(element).getPropertyValue(name)
    element.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, variable)
}

test('1100px light workspace keeps materials readable and gives the composer a useful width', async ({ page }) => {
  await lightWorkspace(page)
  await showThreePanels(page)
  const materials = page.locator('.artifact-drawer')
  const composer = page.locator('.composer-shell')
  await expect.poll(async () => (await composer.boundingBox())?.width || 0).toBeGreaterThanOrEqual(500)
  const [navBox, materialBox, composerBox] = await Promise.all([
    page.locator('.app-rail').boundingBox(), materials.boundingBox(), composer.boundingBox(),
  ])
  expect(navBox.width).toBeGreaterThanOrEqual(219)
  expect(navBox.width).toBeLessThanOrEqual(241)
  const wordmark = page.locator('.app-rail .rail-brand-row > .rail-reveal')
  expect(await wordmark.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(materialBox.width).toBeGreaterThanOrEqual(239)
  expect(materialBox.width).toBeLessThanOrEqual(281)
  expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(materialBox.x - 17)
  await expect(materials).toHaveCSS('background-color', await resolvedColor(materials, '--paper-raised'))
  await expect(materials).not.toHaveCSS('background-color', 'rgb(28, 28, 28)')
  await expect(materials.getByRole('button', { name: 'Close materials panel', exact: true })).toBeVisible()
  const contrast = await materials.evaluate((element) => {
    const background = getComputedStyle(element).backgroundColor.match(/[\d.]+/g).map(Number)
    const foreground = getComputedStyle(element.querySelector('.artifact-drawer-heading')).color.match(/[\d.]+/g).map(Number)
    const luminance = (rgb) => rgb.slice(0, 3).map((channel) => {
      const value = channel / 255
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    const levels = [luminance(background), luminance(foreground)].sort((a, b) => b - a)
    return (levels[0] + .05) / (levels[1] + .05)
  })
  expect(contrast).toBeGreaterThanOrEqual(4.5)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('materials can close from either control and reopening restores the column', async ({ page }) => {
  await lightWorkspace(page)
  await showThreePanels(page)
  const composer = page.locator('.composer-shell')
  await expect.poll(async () => (await composer.boundingBox())?.width || 0).toBeGreaterThanOrEqual(500)
  const withMaterials = (await composer.boundingBox()).width
  const input = page.locator('#composer-input')
  await input.fill('Keep this draft while I rearrange the workspace.')
  await page.getByRole('button', { name: 'Close materials panel', exact: true }).click()
  await expect(page.locator('.artifact-drawer')).toHaveCount(0)
  await expect.poll(async () => Math.abs((await composer.boundingBox()).width - withMaterials)).toBeLessThanOrEqual(1)
  await expect(input).toHaveValue('Keep this draft while I rearrange the workspace.')
  await page.getByRole('button', { name: 'Show materials', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Hide materials', exact: true })).toBeVisible()
  await expect.poll(async () => Math.abs((await composer.boundingBox()).width - withMaterials)).toBeLessThanOrEqual(2)
  await page.getByRole('button', { name: 'Hide materials', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show materials', exact: true })).toBeVisible()
  await expect(page.locator('.artifact-drawer')).toHaveCount(0)
  await expect(input).toHaveValue('Keep this draft while I rearrange the workspace.')
})

test('the open lesson supplies editing context and revision suggestions in the original composer', async ({ page }) => {
  await lightWorkspace(page, 1280)
  const shell = page.locator('.composer-shell')
  const input = page.locator('#composer-input')
  await expect(input).toHaveCount(1)
  await expect(shell.locator('.composer-context-line')).toHaveText(/Week\s*0?3.*Editing this lesson/)
  await expect(input).toHaveAttribute('aria-describedby', /composer-context/)
  await expect(shell.locator('.composer-ghost')).toHaveText("Add support for Wednesday's lesson.")
  await expect(input).toHaveValue('')
  const dictate = shell.getByRole('button', { name: 'Dictate', exact: true })
  await expect(dictate).toHaveAttribute('data-composer-action', 'dictate')
  await expect(dictate).toHaveCSS('background-color', await resolvedColor(dictate, '--paper-sunken'))
  const voice = shell.getByRole('button', { name: 'Plan with voice', exact: true })
  await expect(voice).toBeVisible()
  expect(await voice.evaluate((element) => Boolean(element.closest('.composer-control-row')))).toBe(true)
  await input.press('Tab')
  await expect(input).toHaveValue("Add support for Wednesday's lesson.")
  await expect(input).toBeFocused()
  await expect(shell.getByRole('button', { name: 'Apply change', exact: true })).toHaveAttribute('data-composer-action', 'send')
})

test('a reader resize keeps the composer onscreen without losing its draft', async ({ page }) => {
  await lightWorkspace(page, 1512)
  const input = page.locator('#composer-input')
  const shell = page.locator('.composer-shell')
  await input.fill('Keep Friday unchanged while adding support on Wednesday.')
  for (const width of [1100, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 })
    await expect.poll(async () => {
      const box = await shell.boundingBox()
      return Boolean(box) && box.x >= 7 && box.x + box.width <= width - 7
    }).toBe(true)
    await expect(input).toHaveValue('Keep Friday unchanged while adding support on Wednesday.')
    await expect(input).toBeFocused()
    await expect(page.locator('.is-composer-overlay')).toBeVisible()
    const conversation = await page.locator('.chat-workspace-main').boundingBox()
    expect(conversation.width).toBeGreaterThanOrEqual(279)
    expect(conversation.width).toBeLessThanOrEqual(341)
  }
})

test('landscape tablet keeps a usable composer beside the open lesson', async ({ page }) => {
  await lightWorkspace(page, 1512)
  const input = page.locator('#composer-input')
  await input.fill('Keep Friday unchanged while adding support on Wednesday.')
  await page.setViewportSize({ width: 1000, height: 800 })
  await expect(page.locator('.tablet-plan-pane')).toBeVisible()
  await expect(page.locator('.is-composer-overlay')).toHaveCount(0)
  await expect(input).toHaveValue('Keep Friday unchanged while adding support on Wednesday.')
  await expect(input).toBeFocused()
  await expect.poll(async () => {
    const [shell, plan] = await Promise.all([page.locator('.composer-shell').boundingBox(), page.locator('.tablet-plan-pane').boundingBox()])
    return shell.x + shell.width <= plan.x - 1
  }).toBe(true)
  await expect.poll(async () => (await input.boundingBox())?.width || 0).toBeGreaterThanOrEqual(160)
  await expect.poll(async () => (await page.locator('.composer-shell').boundingBox())?.width || 0).toBeGreaterThanOrEqual(300)
  const [inputBox, planBox, shellBox] = await Promise.all([input.boundingBox(), page.locator('.tablet-plan-pane').boundingBox(), page.locator('.composer-shell').boundingBox()])
  expect(inputBox.height).toBeGreaterThanOrEqual(40)
  expect(shellBox.x + shellBox.width).toBeLessThanOrEqual(planBox.x - 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await input.fill('A shorter tablet revision.')
  await expect(input).toHaveValue('A shorter tablet revision.')
})
