import { expect, test } from '@playwright/test'

const seed = '/preview.html?fresh=0&at=/c/c1/chat/seed1'
const weekPlanName = 'Open Week 03 — Aug 17-21, 2026'

/* Seeded chats already have a week, so Outputs should already be open.
   Keep this helper for tests that run before the artifact fetch lands, or
   after a prior step closed the rail. */
async function openArtifactsPanel(page) {
  const closeRail = page.getByRole('button', { name: 'Close artifacts panel', exact: true })
  const openRail = page.getByRole('button', { name: 'Open artifacts panel', exact: true })
  await expect(closeRail.or(openRail)).toBeVisible()
  if (await closeRail.isVisible()) return
  await openRail.click()
  await expect(page.locator('.artifact-drawer')).toBeVisible()
}

test('desktop document spans most of the workspace under the composer and fullscreen restores it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(seed)
  await expect(page.locator('body')).not.toContainText('not retrieved')
  await expect(page.locator('.is-composer-overlay')).toBeVisible()
  const panel = page.locator('.is-composer-overlay')
  const composer = page.locator('#composer-input')
  await expect(panel).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.panel-scrim')).toHaveCount(0)
  await expect(panel.locator('.plan-table')).toBeVisible()
  await page.waitForTimeout(450)
  await composer.fill('Keep the lesson plan open while I type.')
  await expect(composer).toBeFocused()
  const assertComposerOverlay = async () => {
    const inputBox = await composer.boundingBox()
    const panelBox = await panel.boundingBox()
    const workspaceBox = await page.locator('.workspace-panes').boundingBox()
    const leftRailBox = await page.locator('.app-rail').boundingBox()
    const chatBox = await page.locator('.workspace-chat').boundingBox()
    const actionBox = await panel.locator('.doc-head > div:last-child').boundingBox()
    expect(leftRailBox.width).toBeLessThan(8)
    expect(chatBox.width).toBeGreaterThan(250)
    expect(chatBox.width).toBeLessThanOrEqual(360)
    expect(panelBox.x).toBeGreaterThanOrEqual(chatBox.x + chatBox.width - 8)
    expect(panelBox.width).toBeGreaterThan(workspaceBox.width * 0.55)
    expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
    const tableScroll = panel.locator('.plan-table-scroll')
    if (await tableScroll.count()) {
      expect(await tableScroll.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    }
    expect(inputBox.x + inputBox.width).toBeGreaterThan(panelBox.x)
    const composerIsOnTop = await composer.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      return document.elementFromPoint(rect.right - 8, rect.y + rect.height / 2) === el
    })
    expect(composerIsOnTop).toBe(true)
  }
  await assertComposerOverlay()
  const body = panel.locator('.doc-body')
  const composerShell = page.locator('.composer-shell')
  await composer.fill('Keep the lesson plan open while I type.\nSecond line\nThird line\nFourth line\nFifth line\nSixth line')
  /* --composer-h is measured with ResizeObserver, so padding lags the
     textarea grow by a frame. Scroll only after that dock height is applied,
     otherwise the last rows still sit behind the taller composer. */
  await expect.poll(async () => {
    const composerBox = await composerShell.boundingBox()
    const padding = await body.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom))
    return Boolean(composerBox) && padding > composerBox.height
  }).toBe(true)
  await expect.poll(async () => {
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight })
    const sheetBox = await body.locator('.doc-sheet').boundingBox()
    const composerBox = await composerShell.boundingBox()
    return Boolean(sheetBox && composerBox) && sheetBox.y + sheetBox.height <= composerBox.y
  }).toBe(true)
  await composer.fill('Keep the lesson plan open while I type.')
  await panel.getByRole('button', { name: 'Enter fullscreen' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.is-overlay-fullscreen')).toBeVisible()
  await expect(page.locator('.plan-table')).toBeVisible()
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue('Keep the lesson plan open while I type.')
  const fullscreenComposerBox = await composer.boundingBox()
  const fullscreenPanelBox = await page.locator('.is-overlay-fullscreen').boundingBox()
  expect(fullscreenComposerBox.y).toBeGreaterThan(fullscreenPanelBox.y)
  expect(fullscreenComposerBox.y + fullscreenComposerBox.height).toBeLessThanOrEqual(fullscreenPanelBox.y + fullscreenPanelBox.height)
  const fullscreenComposerIsOnTop = await composer.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return document.elementFromPoint(rect.right - 8, rect.y + rect.height / 2) === el
  })
  expect(fullscreenComposerIsOnTop).toBe(true)
  await page.getByRole('button', { name: 'Exit fullscreen' }).click()
  await expect(panel).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(composer).toHaveValue('Keep the lesson plan open while I type.')
  await panel.getByRole('button', { name: 'Close document' }).click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: /Week 03 Quiz — Voice & Tone Quiz/ }).click()
  await expect(panel).toBeVisible()
  await page.waitForTimeout(450)
  await composer.fill('Quiz and chat remain independent.')
  await expect(composer).toBeFocused()
  await assertComposerOverlay()
  expect(errors).toEqual([])
})

test('system appearance updates without visiting settings', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  // Default account appearance is charcoal; this spec is the system-follow path.
  await page.addInitScript(() => localStorage.setItem('aplang.theme', 'system'))
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.goto(seed)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.app-rail')).toHaveCSS('background-color', 'rgb(20, 20, 19)')
  await expect(page.locator('.is-composer-overlay')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('dark-workspace.png') })
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.locator('.app-rail')).toHaveCSS('background-color', 'rgb(242, 242, 244)')
})

test('composer stays centered between the navigation and materials rails', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(seed)
  const composer = page.locator('.composer-shell')
  await expect(composer).toBeVisible()
  const overlay = page.locator('.is-composer-overlay')
  if (await overlay.isVisible()) {
    await overlay.getByRole('button', { name: 'Close document' }).click()
    await expect(overlay).toHaveCount(0)
  }
  await openArtifactsPanel(page)
  await expect(page.locator('.artifact-drawer')).toBeVisible()
  await expect(page.locator('.artifact-drawer-handle')).toHaveCount(0)
  await expect(page.locator('.app-rail-handle')).toHaveCount(0)
  await page.waitForTimeout(420)
  const assertComposerBetweenRails = async () => {
    const topbarBox = await page.locator('.workspace-topbar').boundingBox()
    const drawerBox = await page.locator('.artifact-drawer').boundingBox()
    const composerBox = await composer.boundingBox()
    const chatBox = await page.locator('.workspace-chat').boundingBox()
    // The outputs inspector is an in-flow column, inset with the workspace
    // gutter rather than an overlay that starts under the chat header.
    expect(Math.abs(drawerBox.y - topbarBox.y)).toBeLessThanOrEqual(12)
    expect(await page.locator('.artifact-drawer').evaluate((el) => getComputedStyle(el).position)).toBe('relative')
    expect(composerBox.x).toBeGreaterThanOrEqual(chatBox.x - 1)
    expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(drawerBox.x - 24)
  }
  await assertComposerBetweenRails()

  const closeRail = page.getByRole('button', { name: 'Close artifacts panel', exact: true })
  await expect(closeRail).toHaveAttribute('aria-expanded', 'true')
  await expect(closeRail).toHaveAttribute('aria-controls', 'artifacts-panel')
  await closeRail.click()
  await expect(page.locator('.artifact-drawer')).toHaveCount(0)
  const openRail = page.getByRole('button', { name: 'Open artifacts panel', exact: true })
  await expect(openRail).toBeVisible()
  await expect(openRail).toHaveAttribute('aria-expanded', 'false')
  await expect(composer).toBeVisible()
  await openRail.click()
  await expect(page.locator('.artifact-drawer')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close artifacts panel', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(420)
  await assertComposerBetweenRails()

  await page.setViewportSize({ width: 1512, height: 900 })
  await page.waitForTimeout(220)
  await assertComposerBetweenRails()
  await page.getByRole('button', { name: 'Close artifacts panel', exact: true }).click()
  await expect(page.locator('.artifact-drawer')).toHaveCount(0)
  await expect(composer).toBeVisible()
})

test('phone keeps its dedicated reader and fits the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(seed)
  await expect(page.locator('#composer-input')).toBeVisible()
  await expect(page.locator('.is-composer-overlay')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Open lesson plan', exact: true }).click()
  await expect(page.locator('.is-mobile-reader')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('phone lesson-plan peek follows a long thumb pull to the transcript edge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(seed)

  const sheet = page.locator('.mobile-composer-plan-sheet.has-plan')
  const handle = sheet.locator('.plan-peek-handle')
  await expect(sheet).toBeVisible()
  await expect(handle).toBeVisible()

  const initialBody = await sheet.locator('.plan-peek-body').boundingBox()
  const handleBox = await handle.boundingBox()
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + handleBox.width / 2, Math.max(1, handleBox.y - 600), { steps: 8 })
  await page.mouse.up()

  await expect(handle).toHaveAttribute('aria-expanded', 'true')
  const openBody = await sheet.locator('.plan-peek-body').boundingBox()
  const transcript = await page.locator('.workspace-chat .scroll-y').boundingBox()
  const openSheet = await sheet.boundingBox()
  expect(openBody.height).toBeGreaterThan(initialBody.height + 200)
  expect(Math.abs(openSheet.y - transcript.y)).toBeLessThanOrEqual(2)

  const openHandleBox = await handle.boundingBox()
  await page.mouse.move(openHandleBox.x + openHandleBox.width / 2, openHandleBox.y + openHandleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(openHandleBox.x + openHandleBox.width / 2, openHandleBox.y + openBody.height + 12, { steps: 8 })
  await page.mouse.up()

  await expect(handle).toHaveAttribute('aria-expanded', 'false')
  const closedBody = await sheet.locator('.plan-peek-body').boundingBox()
  const closedSheet = await sheet.boundingBox()
  expect(closedBody.height).toBeLessThanOrEqual(2)
  expect(closedSheet.y).toBeGreaterThan(openSheet.y + 200)
})
