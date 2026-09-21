import { expect, test } from '@playwright/test'

const finalReplyId = 'clearance-final-reply'
const finalReply = 'Final check: ask students to explain their evidence in one sentence.\n\nKeep this sentence and the message actions visible above the composer.'
const multilineDraft = 'Keep the lesson goal.\nAdd partner rehearsal.\nCheck understanding.\nSupport emerging readers.\nKeep Friday unchanged.\nFinish with reflection.'

async function openLongConversation(page, viewport) {
  await page.setViewportSize(viewport)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/preview.html?fresh=0&voice=1&beta=1&trial=7&at=/c/c1')
  await expect(page.locator('#composer-input')).toBeVisible()
  // Populate the disposable preview before this chat is requested. A real
  // loaded history has no new-turn pin spacer to accidentally hide this bug.
  await page.evaluate(({ finalReplyId, finalReply }) => {
    const history = Array.from({ length: 14 }, (_, index) => ({
      id: `clearance-history-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `Conversation turn ${index + 1}. ${'We discussed the learning goal, student needs, and the evidence that would show understanding. '.repeat(5)}`,
      created_at: '2026-08-07T12:00:00Z',
    }))
    window.__mock.state.messages.seed1 = [
      ...history,
      ...window.__mock.state.messages.seed1,
      { id: finalReplyId, role: 'assistant', content: finalReply, created_at: '2026-08-07T12:05:00Z' },
    ]
    window.history.pushState({}, '', `${window.__previewBase}/c/c1/chat/seed1`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, { finalReplyId, finalReply })
  await expect(page.locator('[data-message-id]').filter({ hasText: finalReply })).toBeAttached()
}

async function expectClearAtBottom(page, scroll, last, { scrollToBottom = true } = {}) {
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(300)
  await expect.poll(async () => {
    if (scrollToBottom) await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
    const [message, dock, viewport] = await Promise.all([
      last.boundingBox(), page.locator('.composer-experience').boundingBox(), scroll.boundingBox(),
    ])
    return Boolean(message && dock && viewport)
      && message.y >= viewport.y - 1
      && message.y + message.height <= dock.y - 8
      && message.y + message.height <= viewport.y + viewport.height + 1
  }, { message: 'The entire latest turn must scroll above the visible composer' }).toBe(true)
}

async function expectMessageActionsClear(page) {
  const scroll = page.locator('.chat-transcript-scroll')
  const last = page.locator('[data-message-id]').filter({ hasText: finalReply })
  await expectClearAtBottom(page, scroll, last)
  const copy = last.getByRole('button', { name: 'Copy this message', exact: true })
  await copy.focus()
  await expect(copy).toBeFocused()
  await expectClearAtBottom(page, scroll, last)
  // Geometry alone would miss another overlay intercepting the action.
  expect(await copy.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return Boolean(hit && element.contains(hit))
  })).toBe(true)
}

test('desktop latest reply and actions clear a multiline composer with the lesson closed and open', async ({ page }) => {
  await openLongConversation(page, { width: 1280, height: 800 })
  // Saved chats land on the conversation; opening a lesson is explicit.
  await expect(page.locator('.is-composer-overlay')).toHaveCount(0)
  await page.locator('#composer-input').fill(multilineDraft)
  await expect(page.locator('.composer-shell')).toHaveClass(/is-expanded/)
  await expectMessageActionsClear(page)

  const showMaterials = page.getByRole('button', { name: 'Show materials', exact: true })
  if (await showMaterials.count()) await showMaterials.click()
  await page.locator('.artifact-drawer').getByRole('button', { name: /^Open Week 03/ }).first().click()
  await expect(page.locator('.is-composer-overlay')).toBeVisible()
  await expect(page.locator('#composer-input')).toHaveValue(multilineDraft)
  await expectMessageActionsClear(page)
})

test('composer growth follows the latest reply but preserves an older reading position', async ({ page }) => {
  await openLongConversation(page, { width: 1280, height: 800 })
  await expect(page.locator('.is-composer-overlay')).toHaveCount(0)
  const input = page.locator('#composer-input')
  const scroll = page.locator('.chat-transcript-scroll')
  const last = scroll.locator('[data-message-id]').filter({ hasText: finalReply })
  await input.fill('Keep this unsent revision.')
  await expectClearAtBottom(page, scroll, last)
  await input.fill(multilineDraft)
  await expect(page.locator('.composer-shell')).toHaveClass(/is-expanded/)
  // No second wheel gesture or imperative scroll: the new measured tail
  // should keep an already-following teacher above the enlarged composer.
  await expectClearAtBottom(page, scroll, last, { scrollToBottom: false })

  await scroll.evaluate((element) => {
    element.scrollTop = 120
    element.dispatchEvent(new Event('scroll'))
  })
  const readingTop = await scroll.evaluate((element) => element.scrollTop)
  const clearance = () => page.locator('.workspace-chat').evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).getPropertyValue('--chat-composer-clearance')),
  )
  const expandedClearance = await clearance()
  await input.fill('A shorter unsent revision.')
  await expect.poll(clearance).toBeLessThan(expandedClearance)
  // Allow the resize observer and its follow effect to run before checking
  // that neither shrinking nor growing the dock yanks the reading position.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(Math.abs(await scroll.evaluate((element) => element.scrollTop) - readingTop)).toBeLessThanOrEqual(1)
  await input.fill(multilineDraft)
  await expect.poll(clearance).toBeGreaterThanOrEqual(expandedClearance)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(Math.abs(await scroll.evaluate((element) => element.scrollTop) - readingTop)).toBeLessThanOrEqual(1)
})

for (const { name, viewport } of [
  { name: 'phone', viewport: { width: 390, height: 844 } },
  { name: 'landscape tablet', viewport: { width: 1000, height: 800 } },
]) {
  test(`${name} latest reply and actions clear the floating multiline composer`, async ({ page }) => {
    await openLongConversation(page, viewport)
    await page.locator('#composer-input').fill(multilineDraft)
    await expect(page.locator('.composer-shell')).toHaveClass(/is-expanded/)
    await expectMessageActionsClear(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

for (const { name, viewport } of [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 } },
]) {
  test(`${name} voice history clears the expanded and collapsed consultation dock`, async ({ page }) => {
    await openLongConversation(page, viewport)
    if (await page.locator('.is-composer-overlay').count()) {
      await page.getByRole('button', { name: 'Close document', exact: true }).click()
      await expect(page.locator('.is-composer-overlay')).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Plan with voice', exact: true }).last().click()
    await page.getByText('Earlier conversation', { exact: true }).click()
    const scroll = page.getByRole('region', { name: 'Lesson details and conversation', exact: true })
    const last = scroll.locator('.voice-details-turn').filter({ hasText: finalReply })
    await expect(last).toBeAttached()
    await page.locator('#composer-input').fill(multilineDraft)
    await expect(page.getByRole('button', { name: 'Minimize teaching conversation', exact: true })).toBeVisible()
    await expectClearAtBottom(page, scroll, last)
    const expandedHeight = (await page.locator('.composer-experience').boundingBox()).height
    await page.getByRole('button', { name: 'Minimize teaching conversation', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Expand teaching conversation', exact: true })).toBeVisible()
    await expect.poll(async () => (await page.locator('.composer-experience').boundingBox()).height).toBeLessThan(expandedHeight)
    await expectClearAtBottom(page, scroll, last)
    await expect(page.locator('#composer-input')).toHaveValue(multilineDraft)
  })
}
