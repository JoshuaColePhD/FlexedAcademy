import { expect, test } from '@playwright/test'

async function openTemplateStep(page) {
  // Template customization is optional, reached after the first-plan flow.
  await page.goto('/preview.html?fresh=0&at=/c/c1/settings')
  await page.getByRole('button', { name: 'Preferences', exact: true }).click()
  await page.getByRole('button', { name: 'Take the tour again' }).click()
  await expect(page.getByRole('heading', { name: 'Where do you teach?' })).toBeVisible()
  await page.locator('#onboarding-state').selectOption('AL')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Which course, exactly?' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Is this your school year?' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make every plan feel like yours.' })).toBeVisible()
}

async function chooseFile(page, name = 'Blank lesson template.docx') {
  await page.getByRole('checkbox', { name: 'I confirm this is a blank reusable format.' }).check()
  // This fixture tests the browser upload contract, not document extraction.
  await page.locator('.onboarding-template-upload input[type="file"]').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('Local template upload fixture') })
}

test('phone template journey reveals real response sections, confirms the default, and advances', async ({ page }) => {
  /* CI runners have no prefers-reduced-motion; this VM often does. Pin full
     motion so the context-step focus race (200ms exit vs incoming heading)
     is actually exercised instead of skipped. */
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 390, height: 844 })
  await openTemplateStep(page)
  await expect(page.getByRole('checkbox', { name: 'I confirm this is a blank reusable format.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose my template', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Analyze my template', exact: true })).toBeDisabled()
  await chooseFile(page, 'Wrong format.txt')
  await expect(page.getByRole('alert').filter({ hasText: 'Choose a PDF or Word' })).toBeVisible()
  await page.locator('.onboarding-template-upload input[type="file"]').setInputFiles({ name: 'Blank lesson template.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('Local template upload fixture') })
  await page.getByRole('button', { name: 'Analyze my template', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Getting to know your template.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use this format', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'There’s your teaching rhythm.' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Detected sections in order' }).locator('li')).toHaveText(['01Learning targets', '02Standards', '03Opening activity', '04Instruction & practice', '05Check for understanding', '06Reflection'])
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('onboarding-title')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Use this format', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your format. From here on.' })).toBeVisible()
  expect(await page.evaluate(() => window.__mock.state.schoolTemplates['florence-high-school'].some((row) => row.is_personal_default))).toBe(true)
  await page.getByRole('button', { name: 'Keep going', exact: true }).click()
  await expect(page.getByRole('heading', { name: "You're ready to make great things." })).toBeVisible()
})

test('failed analysis cannot be confirmed and a failed request can be retried with the same file', async ({ page }) => {
  await openTemplateStep(page)
  await chooseFile(page)
  await page.evaluate(() => { window.__mock.state.templateIntakeOutcome = 'network_error'; window.__mock.state.templateAnalysisDelayMs = 100 })
  await page.getByRole('button', { name: 'Analyze my template', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'That didn’t go through.' })).toBeVisible()
  await expect(page.getByText('Blank lesson template.docx', { exact: true })).toBeVisible()
  await page.evaluate(() => { window.__mock.state.templateIntakeOutcome = 'failed' })
  await page.getByRole('button', { name: 'Analyze my template', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Let’s try a clearer template.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use this format', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Choose another file', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make every plan feel like yours.' })).toBeVisible()
})

test('Google Doc warnings remain reviewable with reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await openTemplateStep(page)
  await page.getByRole('checkbox', { name: 'I confirm this is a blank reusable format.' }).check()
  await page.getByRole('button', { name: 'Use a Google Doc link', exact: true }).click()
  await page.getByPlaceholder('Paste a shareable Google Doc link').fill('https://docs.google.com/document/d/local-preview-template/edit')
  await page.evaluate(() => { window.__mock.state.templateIntakeOutcome = 'analyzed_with_warnings' })
  await page.getByRole('button', { name: 'Analyze my template', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Getting to know your template.' })).toBeVisible()
  await expect(page.locator('.template-reading-scan')).toBeHidden()
  await expect(page.getByText('Check the order of merged table cells against your original.')).toBeVisible()
  expect(await page.locator('.onboarding-analysis-card').evaluate((el) => el.getBoundingClientRect().right <= innerWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'Use this format', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Use this format', exact: true }).click()
  await expect(page.locator('.onboarding-confetti')).toHaveCount(0)
})

test('a first plan does not require a school template upload', async ({ page }) => {
  await page.goto('/preview.html?fresh=1')
  await page.getByLabel('State', { exact: true }).selectOption('AL')
  await page.getByLabel('Grade', { exact: true }).selectOption('11')
  await page.getByRole('radio', { name: /AP English Language/ }).check()
  await page.getByRole('button', { name: 'Continue to my first week' }).click()
  await expect(page.getByRole('heading', { name: 'What are you teaching next?' })).toBeVisible()
  await expect(page.locator('input[type="file"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Build my first plan' })).toBeVisible()
})
