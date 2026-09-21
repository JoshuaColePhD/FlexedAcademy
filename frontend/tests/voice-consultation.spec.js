import { expect, test } from '@playwright/test'

const existing = '/preview.html?fresh=0&voice=1&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1'
const freshChat = '/preview.html?fresh=0&voice=1&trial=7&at=/c/c1'
const composer = (page) => page.locator('#composer-input')
const details = (page) => page.getByRole('complementary', { name: 'Voice session details', exact: true })
async function say(page, text, { enter = false } = {}) {
  await expect(composer(page)).toHaveAccessibleName('Practice a spoken teaching idea')
  await composer(page).fill(text)
  if (enter) await composer(page).press('Enter')
  else await page.getByRole('button', { name: 'Send teaching idea', exact: true }).click()
}
async function openVoice(page, url, beforeOpen) {
  await page.addInitScript(() => {
    window.__micRequests = 0
    navigator.mediaDevices.getUserMedia = async () => { window.__micRequests++; throw new Error('Preview must never request a microphone') }
  })
  await page.goto(url)
  if (beforeOpen) await beforeOpen()
  await page.getByRole('button', { name: 'Plan with voice', exact: true }).last().click()
  await expect(composer(page)).toHaveAccessibleName('Practice a spoken teaching idea')
  await expect(composer(page)).toBeVisible()
  // There is one input for the conversation, even while the animated stage
  // and the supporting-details panel are both open.
  await expect(page.getByLabel('Practice a spoken teaching idea', { exact: true })).toHaveCount(1)
}
async function generationCount(page) {
  return page.evaluate(() => window.__mock.calls.filter((call) => call.path === '/api/generate_stream').length)
}
async function savedUserCount(page, content) {
  return page.evaluate((text) => Object.values(window.__mock.state.messages).flat().filter((message) => message.role === 'user' && message.content === text).length, content)
}
async function expectNoVoiceProvider(page) {
  expect(await page.evaluate(() => window.__micRequests)).toBe(0)
  expect(await page.evaluate(() => window.__mock.calls.some((call) => call.path === '/api/voice/session'))).toBe(false)
}

test('voice preview builds a first lesson and keeps the session across chat creation', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await openVoice(page, freshChat)
  const request = 'Build a week of rhetorical analysis using two speeches and daily exit tickets.'
  await say(page, request)
  await expect.poll(() => page.evaluate(() => window.__mock.state.lastPrompt || '')).toContain('rhetorical analysis')
  await expect(page.locator('.doc-head')).toContainText('Saved')
  await expect(page.locator('.artifact-overlay')).toBeVisible()
  await expect(details(page).getByRole('button', { name: 'View lesson', exact: true })).toHaveCount(0)
  await expect(composer(page)).toBeEnabled()
  await expect.poll(() => savedUserCount(page, request)).toBe(1)
  expect(await generationCount(page)).toBe(1)
  await expectNoVoiceProvider(page)
  expect(errors).toEqual([])
})

test('consultation responds during a build and applies ordered changes only after the draft saves', async ({ page }) => {
  await openVoice(page, existing)
  await page.evaluate(() => { window.__mock.latency.stream = 5500 })
  await say(page, 'Revise this lesson to include more language support on Wednesday.')
  await expect.poll(() => generationCount(page)).toBe(1)
  await say(page, 'How can students show independent understanding?')
  await expect(details(page).getByText('Try a brief worked example, then have students explain their choice to a partner. What would show you that they can do it independently?', { exact: true }).first()).toBeVisible()
  expect(await generationCount(page)).toBe(1)
  await say(page, 'Add partner rehearsal before Wednesday writing.')
  await expect(details(page).getByText(/1 change.*waiting/i)).toBeVisible()
  await say(page, 'Make that rehearsal three minutes and keep Friday unchanged.')
  await expect(details(page).getByText(/2 changes.*waiting/i)).toBeVisible()
  expect(await generationCount(page)).toBe(1)
  await expect.poll(() => generationCount(page), { timeout: 15000 }).toBe(2)
  const prompts = await page.evaluate(() => window.__mock.calls.filter((call) => call.path === '/api/generate_stream').map((call) => call.body.query))
  expect(prompts[1]).toContain('Add partner rehearsal')
  expect(prompts[1]).toContain('three minutes')
  expect(prompts[1]).toContain('Friday unchanged')
  await expect(details(page).getByText(/changes.*waiting/i)).toHaveCount(0, { timeout: 15000 })
  expect(await savedUserCount(page, 'Add partner rehearsal before Wednesday writing.')).toBe(1)
})

test('failed queued revision preserves the request and offers an explicit retry', async ({ page }) => {
  await openVoice(page, existing)
  await page.evaluate(() => { window.__mock.latency.stream = 2000 })
  await say(page, 'Revise this lesson with more language support for Wednesday.')
  await expect.poll(() => generationCount(page)).toBe(1)
  await page.evaluate(() => { window.__mock.state.failNextGeneration = true })
  await say(page, 'Add a three-minute partner rehearsal on Wednesday.')
  await expect(details(page).getByRole('button', { name: 'Retry pending changes', exact: true })).toBeVisible({ timeout: 12000 })
  await expect(details(page).getByText(/1 change.*waiting/i)).toBeVisible()
  await details(page).getByRole('button', { name: 'Retry pending changes', exact: true }).click()
  await expect.poll(() => generationCount(page)).toBe(3)
  await expect(details(page).getByText(/1 change.*waiting/i)).toHaveCount(0, { timeout: 10000 })
  await expect(details(page).getByRole('button', { name: 'Retry pending changes', exact: true })).toHaveCount(0)
})

test('voice preview fits a phone, can minimize, and ends explicitly', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openVoice(page, existing)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Minimize teaching conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Expand teaching conversation', exact: true })).toBeVisible()
  await expect(composer(page)).toBeInViewport()
  await page.getByRole('button', { name: 'Expand teaching conversation', exact: true }).click()
  await details(page).getByRole('button', { name: 'View lesson', exact: true }).click()
  await expect(details(page).getByRole('button', { name: 'View lesson', exact: true })).toHaveCount(0)
  await expect(details(page).getByRole('button', { name: 'Download lesson as DOCX', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'End voice conversation', exact: true })).toBeInViewport()
  await expect(composer(page)).toBeInViewport()
  await page.getByRole('button', { name: 'End voice conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Plan with voice', exact: true }).last()).toBeVisible()
  await expectNoVoiceProvider(page)
})

test('desktop voice stage joins the composer, keeps details beside the lesson, and ends on navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openVoice(page, existing)
  await expect.poll(async () => {
    const [voice, shell] = await Promise.all([page.locator('.voice-consultation').boundingBox(), page.locator('.composer-shell').boundingBox()])
    return Boolean(voice && shell && Math.abs(voice.x - shell.x) <= 2 && Math.abs(voice.width - shell.width) <= 2 && Math.abs(voice.y + voice.height - shell.y - 12) <= 2)
  }).toBe(true)
  await expect.poll(async () => {
    const [information, lesson] = await Promise.all([details(page).boundingBox(), page.locator('.artifact-overlay').boundingBox()])
    return Boolean(information && lesson && information.x >= 0 && information.x + information.width <= lesson.x + 2)
  }).toBe(true)
  await page.getByRole('button', { name: 'Close document', exact: true }).click()
  await expect(details(page).getByRole('button', { name: 'View lesson', exact: true })).toBeVisible()
  await expect(details(page).getByRole('button', { name: 'Download lesson as DOCX', exact: true })).toBeVisible()
  await page.getByRole('link', { name: /Week 02 · Close Reading/ }).click()
  await expect(page.getByRole('heading', { name: 'Teaching conversation', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Plan with voice', exact: true }).last()).toBeVisible()
})

test('Enter sends one preview turn and preserves the teacher’s normal text draft', async ({ page }) => {
  const normalDraft = 'Keep this unsent note about Friday’s seminar.'
  await openVoice(page, existing, () => composer(page).fill(normalDraft))
  await expect(composer(page)).toHaveValue('')
  const idea = 'How can students show independent understanding?'
  await say(page, idea, { enter: true })
  await expect.poll(() => savedUserCount(page, idea)).toBe(1)
  await expect.poll(() => page.evaluate((text) => window.__mock.calls.filter((call) => call.path === '/api/chat_stream' && [...(call.body.messages || [])].reverse().find((message) => message.role === 'user')?.content === text).length, idea)).toBe(1)
  await expect(composer(page)).toHaveValue('')
  await page.getByRole('button', { name: 'End voice conversation', exact: true }).click()
  await expect(composer(page)).toHaveValue(normalDraft)
  await expect(composer(page)).toBeFocused()
  expect(await savedUserCount(page, normalDraft)).toBe(0)
  await expectNoVoiceProvider(page)
})

test('minimize and expand keep the shared composer mounted, with its unsent voice draft', async ({ page }) => {
  await openVoice(page, existing)
  const originalInput = await composer(page).elementHandle()
  const draft = 'A correction I am still thinking through.'
  await composer(page).fill(draft)
  await page.getByRole('button', { name: 'Minimize teaching conversation', exact: true }).click()
  await expect(composer(page)).toBeVisible()
  await expect(composer(page)).toHaveValue(draft)
  expect(await composer(page).evaluate((element, original) => element === original, originalInput)).toBe(true)
  await page.getByRole('button', { name: 'Expand teaching conversation', exact: true }).click()
  await expect(composer(page)).toHaveValue(draft)
  expect(await composer(page).evaluate((element, original) => element === original, originalInput)).toBe(true)
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send teaching idea', exact: true })).toBeDisabled()
  await composer(page).press('Enter')
  await expect(composer(page)).toHaveValue(draft)
  expect(await savedUserCount(page, draft)).toBe(0)
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send teaching idea', exact: true })).toBeEnabled()
  await expectNoVoiceProvider(page)
})

test('reduced motion keeps voice controls functional without a continuously animated stage', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openVoice(page, existing)
  await expect.poll(() => page.locator('.voice-consultation').evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length)).toBe(0)
  await page.getByRole('button', { name: 'Minimize teaching conversation', exact: true }).click()
  await expect(composer(page)).toBeVisible()
  await page.getByRole('button', { name: 'Expand teaching conversation', exact: true }).click()
  await expect(page.getByRole('button', { name: 'End voice conversation', exact: true })).toBeEnabled()
  await expectNoVoiceProvider(page)
})

for (const { name, normalDraft, voiceDraft, expected } of [
  { name: 'returns an unsent idea to an empty composer', normalDraft: '', voiceDraft: 'Keep the exit ticket under three minutes.', expected: 'Keep the exit ticket under three minutes.' },
  { name: 'keeps both distinct drafts in order', normalDraft: 'Keep my Friday seminar note.', voiceDraft: 'Add more time to Wednesday rehearsal.', expected: 'Keep my Friday seminar note.\n\nAdd more time to Wednesday rehearsal.' },
  { name: 'does not duplicate the same draft', normalDraft: 'Save this thought about student choice.', voiceDraft: 'Save this thought about student choice.', expected: 'Save this thought about student choice.' },
]) {
  test(`ending voice ${name} and focuses the normal composer`, async ({ page }) => {
    await openVoice(page, existing, () => composer(page).fill(normalDraft))
    await composer(page).fill(voiceDraft)
    await page.getByRole('button', { name: 'End voice conversation', exact: true }).click()
    await expect(composer(page)).toHaveValue(expected)
    await expect(composer(page)).toBeFocused()
    expect(await savedUserCount(page, voiceDraft)).toBe(0)
    expect(await generationCount(page)).toBe(0)
    await page.getByRole('button', { name: 'Plan with voice', exact: true }).last().click()
    await expect(composer(page)).toHaveValue('')
    await page.getByRole('button', { name: 'End voice conversation', exact: true }).click()
    await expect(composer(page)).toHaveValue(expected)
    await expectNoVoiceProvider(page)
  })
}

test('an unsent voice idea returns to its own chat after navigation', async ({ page }) => {
  await openVoice(page, existing)
  // Remove the reader first, so navigating immediately after typing tests
  // recovery without accidentally waiting out the draft-storage debounce.
  await page.getByRole('button', { name: 'Close document', exact: true }).click()
  const draft = 'An unfinished thought for this rhetorical-devices lesson only.'
  await composer(page).fill(draft)
  await page.getByRole('link', { name: /Week 02 · Close Reading/ }).click()
  await expect(page.getByRole('heading', { name: 'Teaching conversation', exact: true })).toHaveCount(0)
  await expect(composer(page)).toHaveValue('')
  // Saved-chat navigation keeps the conversation and navigation available.
  await expect(page.locator('.artifact-overlay')).toHaveCount(0)
  await page.getByRole('link', { name: /Week 03 · Rhetorical Devices/ }).click({ timeout: 5000 })
  await expect(page.getByRole('button', { name: 'Plan with voice', exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Plan with voice', exact: true }).last().click()
  await expect(composer(page)).toHaveValue(draft)
  expect(await savedUserCount(page, draft)).toBe(0)
  await expectNoVoiceProvider(page)
})

test('sidebar has one scroll region, prioritizes planning, and follows history only when requested', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openVoice(page, freshChat, async () => {
    await page.evaluate(() => {
      const history = Array.from({ length: 8 }, (_, index) => ({
        id: `long-history-${index}`,
        role: index % 2 ? 'assistant' : 'user',
        content: `${index + 1}. ${'We discussed the learning goal, student needs, and the evidence that would show understanding. '.repeat(5)}`,
      }))
      window.__mock.state.messages.seed1.unshift(...history)
    })
    await page.getByRole('link', { name: /Week 03 · Rhetorical Devices/ }).click()
    await page.locator('.artifact-drawer').getByRole('button', { name: /^Open Week 03/ }).first().click()
    await expect(page.locator('.artifact-overlay')).toBeVisible()
  })
  const sidebar = details(page)
  const scroll = sidebar.getByRole('region', { name: 'Lesson details and conversation', exact: true })
  const history = sidebar.getByRole('log', { name: 'Recent teaching conversation', exact: true })
  await expect(scroll).toBeVisible()
  const earlier = sidebar.locator('.voice-details-history')
  await expect(earlier).not.toHaveAttribute('open', '')
  await earlier.getByText('Earlier conversation', { exact: true }).click()
  await expect(earlier).toHaveAttribute('open', '')
  await expect(page.locator('.artifact-overlay')).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'View lesson', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: 'Download lesson as DOCX', exact: true })).toHaveCount(0)
  expect(await sidebar.evaluate((element) => [...element.querySelectorAll('*')].filter((node) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight).length)).toBe(1)
  expect(await history.evaluate((element) => ({ overflow: getComputedStyle(element).overflowY, fontSize: getComputedStyle(element.querySelector('p')).fontSize }))).toEqual({ overflow: 'visible', fontSize: '13px' })
  expect(await sidebar.evaluate((element) => Boolean(element.querySelector('.voice-details-planning').compareDocumentPosition(element.querySelector('.voice-details-conversation')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0)

  const initialReplies = await page.evaluate(() => window.__mock.state.messages.seed1.filter((message) => message.role === 'assistant').length)
  await say(page, 'How can students show independent understanding?')
  await expect(history.getByText('Happy to talk it through. What are you hoping they walk away with?', { exact: true }).first()).toBeAttached()
  // Rendered speech arrives before the deliberately delayed message save.
  // Finish that turn before measuring the next turn's persistence.
  await expect.poll(() => page.evaluate(() => window.__mock.state.messages.seed1.filter((message) => message.role === 'assistant').length)).toBe(initialReplies + 1)
  // A streamed reply must not pull the teacher away from the decisions or
  // questions they are reading at the top of the same scroll region.
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0)
  await sidebar.getByRole('button', { name: 'Latest message', exact: true }).click()
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)
  const repliesBefore = await page.evaluate(() => window.__mock.state.messages.seed1.filter((message) => message.role === 'assistant').length)
  const nextIdea = 'What would help students explain their evidence?'
  await say(page, nextIdea)
  await expect.poll(() => savedUserCount(page, nextIdea)).toBe(1)
  await expect.poll(() => page.evaluate(() => window.__mock.state.messages.seed1.filter((message) => message.role === 'assistant').length)).toBe(repliesBefore + 1)
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)
  await expectNoVoiceProvider(page)
})
