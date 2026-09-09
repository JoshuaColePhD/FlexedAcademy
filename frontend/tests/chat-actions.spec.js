import { expect, test } from '@playwright/test'

async function openChat(page, fresh = false) {
  await page.goto(`/preview.html?fresh=0&trial=3&at=/c/c1${fresh ? '' : '/chat/seed1'}`)
  await expect(page.locator('#composer-input')).toBeVisible()
  if (!fresh) await expect(page.getByText('Grounded:', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    window.chatCalls = []
    window.chatEvents = []
    window.revisionFailure = false
    window.generationFailure = false
    const original = window.fetch
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url
      const body = init.body ? JSON.parse(init.body) : null
      if (url.includes('/api/chat_stream')) {
        window.chatCalls.push({ path: 'chat', body })
        const events = window.chatEvents.shift() || [{ chunk: 'Try a short modeled example, then check an independent response.' }, { done: true }]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.includes('/api/generate_stream')) {
        window.chatCalls.push({ path: body?.revise_plan_id ? 'week' : 'create', body })
        if (window.generationFailure) return new Response(`data: ${JSON.stringify({ error: { code: 'validation_error', message: 'Generation test failure' } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.includes('/api/revise_day') || /\/plans\/[^/]+\/revise$/.test(url)) {
        window.chatCalls.push({ path: url.includes('revise_days') ? 'days' : url.includes('revise_day') ? 'day' : 'week', body })
        if (window.revisionFailure) return new Response(JSON.stringify({ error: { code: 'revision_failed', message: 'Revision test failure' } }), { status: 500 })
        if (url.includes('revise_days')) {
          const plan = structuredClone(window.__mock.state.plans[body.plan_id])
          for (const index of body.day_indices) plan.days[index][body.field || 'during'] = 'Revised task'
          window.__mock.state.plans[body.plan_id] = plan
          return new Response(JSON.stringify({ id: body.plan_id, plan_json: plan, warnings: [], retrieved_ids: [], week_label: plan.week_of }), { headers: { 'Content-Type': 'application/json' } })
        }
      }
      return original(input, init)
    }
  })
}

async function events(page, ...turns) {
  await page.evaluate((turns) => { window.chatEvents.push(...turns) }, turns)
}
async function send(page, text) {
  await page.locator('#composer-input').fill(text)
  await page.locator('#composer-input').press('Enter')
}
const planAction = (action, extra = {}) => ({ tool_call: 'generate_lesson_plan', action, target_plan_id: action === 'create' ? null : 'plan1', instruction: 'Keep paper materials and the 45-minute period.', days: [], field: null, week_number: 3, ...extra })
const done = { done: true }

for (const prompt of ['Why use this approach?', 'Could a debate help students explain their evidence?']) {
  test(`advice with an open plan does not mutate: ${prompt}`, async ({ page }) => {
    await openChat(page)
    await send(page, prompt)
    await expect(page.getByText('Try a short modeled example, then check an independent response.', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.chatCalls.filter((c) => c.path !== 'chat'))).toEqual([])
    expect(await page.evaluate(() => window.chatCalls[0].body.active_plan_id)).toBe('plan1')
    expect(await page.evaluate(() => window.chatCalls[0].body.plan_open)).toBe(false)
  })
}

test('commands from the open week apply to that plan', async ({ page }) => {
  await openChat(page)
  await page.getByRole('button', { name: /View lesson plan/ }).click()
  await events(page, [planAction('revise_week'), done])
  await send(page, 'Ask questions')
  expect(await page.evaluate(() => window.chatCalls[0].body.plan_open)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.chatCalls.filter((c) => c.path === 'week').length)).toBe(1)
})

test('explicit new plan preserves the old plan and creates once after a dropped stream', async ({ page }) => {
  await openChat(page)
  const before = await page.evaluate(() => structuredClone(window.__mock.state.plans.plan1))
  await events(page, [planAction('create')], [planAction('create'), done])
  await send(page, 'Create a separate plan on argument with paper materials and 45-minute periods.')
  await expect.poll(() => page.evaluate(() => window.chatCalls.filter((c) => c.path === 'create').length)).toBe(1)
  await expect.poll(() => page.evaluate(() => window.__mock.state.ownedPlanIds.length)).toBe(3)
  expect(await page.evaluate(() => window.chatCalls.filter((c) => c.path === 'chat').length)).toBe(1)
  expect(await page.evaluate(() => window.chatCalls.filter((c) => ['day', 'days', 'week'].includes(c.path)))).toEqual([])
  expect(await page.evaluate(() => window.__mock.state.plans.plan1)).toEqual(before)
})

test('selected-day revision routes exact days and preserves the rest', async ({ page }) => {
  await openChat(page)
  const before = await page.evaluate(() => structuredClone(window.__mock.state.plans.plan1))
  await events(page, [planAction('revise_days', { days: ['Tuesday', 'Thursday'], field: 'during' }), done])
  await send(page, 'Change only Tuesday and Thursday activities to paper-based practice.')
  await expect.poll(() => page.evaluate(() => window.chatCalls.filter((c) => c.path === 'days').length)).toBe(1)
  const call = await page.evaluate(() => window.chatCalls.find((c) => c.path === 'days'))
  expect(call.body.day_indices).toEqual([1, 3])
  expect(call.body.field).toBe('during')
  const after = await page.evaluate(() => window.__mock.state.plans.plan1)
  for (const index of [0, 2, 4]) expect(after.days[index]).toEqual(before.days[index])
  await expect(page.getByText(/Done — .* is updated/)).toBeVisible()
})

test('whole-week request streams a revision onto the open plan', async ({ page }) => {
  await openChat(page)
  await events(page, [planAction('revise_week'), done])
  await send(page, 'Rework the whole week for shorter class periods.')
  await expect.poll(() => page.evaluate(() => window.chatCalls.filter((c) => c.path === 'week').length)).toBe(1)
  const call = await page.evaluate(() => window.chatCalls.find((c) => c.path === 'week'))
  expect(call.body.revise_plan_id).toBe('plan1')
  await expect(page.getByText(/Done — .* is updated/)).toBeVisible()
  expect(await page.evaluate(() => window.chatCalls.filter((c) => c.path === 'create'))).toEqual([])
})

test('failed day revision never reports saved or a missing chat reply', async ({ page }) => {
  await openChat(page)
  await page.evaluate(() => { window.revisionFailure = true })
  await events(page, [{ tool_call: 'update_lesson_day', target_plan_id: 'plan1', day: 'Wednesday', field: 'assessment', feedback: 'Use an exit ticket' }, done])
  await send(page, 'Replace Wednesday’s assessment with an exit ticket.')
  await expect(page.getByText(/Couldn’t revise.*Revision test failure/)).toBeVisible()
  await expect(page.getByText('Wednesday was updated and saved.', { exact: true })).toHaveCount(0)
  await expect(page.getByText("Didn't get a reply back.", { exact: true })).toHaveCount(0)
})

test('an opening plan request talks first and does not start writing the week', async ({ page }) => {
  await openChat(page, true)
  await events(page, [{ tool_call: 'ask_clarifying_questions', questions: [{ id: 'text', text: 'What are you teaching this week?', options: ['A text we’re reading', 'A skill, no text yet', 'Test/exam prep'] }] }, done])
  await send(page, "let's build a plan")
  await expect(page.getByText('What are you teaching this week?', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.chatCalls.filter((c) => c.path === 'create'))).toEqual([])
  await expect(page.getByText('Building your lesson plan')).toHaveCount(0)
})

test('initial clarification through creation retains earlier constraints', async ({ page }) => {
  await openChat(page, true)
  await events(page, [{ tool_call: 'ask_clarifying_questions', questions: [{ id: 'goal', text: 'Which skill should students practice?', options: ['Evidence', 'Organization'] }] }, done])
  await send(page, 'Plan next week using paper materials in 45-minute periods.')
  await expect(page.getByText('Which skill should students practice?', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.chatCalls.filter((c) => c.path === 'create'))).toEqual([])
  await events(page, [planAction('create', { instruction: 'Plan evidence analysis using paper materials in 45-minute periods.' }), done])
  await send(page, 'Evidence analysis using the current text.')
  await expect.poll(() => page.evaluate(() => window.chatCalls.filter((c) => c.path === 'create').length)).toBe(1)
  const call = await page.evaluate(() => window.chatCalls.find((c) => c.path === 'create'))
  expect(call.body.query).toBe('Evidence analysis using the current text.')
  expect(call.body.conversation_context).toContain('paper materials')
  expect(call.body.conversation_context).toContain('45-minute periods')
  await expect(page.getByText(/is built/).last()).toBeVisible()
  const generatedId = await page.evaluate(() => window.__mock.state.ownedPlanIds.at(-1))
  await events(page, [{ tool_call: 'update_lesson_day', target_plan_id: generatedId, day: 'Wednesday', field: 'assessment', feedback: 'Use a two-question exit ticket.' }, done])
  await send(page, 'Replace only Wednesday’s assessment with a two-question exit ticket.')
  await expect.poll(() => page.evaluate(() => window.chatCalls.filter((c) => c.path === 'day').length)).toBe(1)
  expect(await page.evaluate(() => window.chatCalls.find((c) => c.path === 'day').body.plan_id)).toBe(generatedId)
  await expect(page.getByText(/Updated Wednesday.*rebuilt the document/)).toBeVisible()
})


test('ambiguous revision asks a question without changing the plan', async ({ page }) => {
  await openChat(page)
  await events(page, [{ tool_call: 'ask_clarifying_questions', questions: [{ id: 'change', text: 'What should change about Thursday?', options: ['Activity', 'Assessment'] }] }, done])
  await send(page, 'Can you change Thursday?')
  await expect(page.getByText('What should change about Thursday?', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.chatCalls.filter((c) => c.path !== 'chat'))).toEqual([])
})

test('failed new-plan generation preserves the current plan and shows no completion', async ({ page }) => {
  await openChat(page)
  const before = await page.evaluate(() => structuredClone(window.__mock.state.plans.plan1))
  await page.evaluate(() => { window.generationFailure = true })
  await events(page, [planAction('create'), done])
  await send(page, 'Create a separate plan on argument.')
  await expect(page.getByText('Generation test failure', { exact: true }).first()).toBeVisible()
  expect(await page.evaluate(() => window.__mock.state.plans.plan1)).toEqual(before)
  expect(await page.evaluate(() => window.__mock.state.ownedPlanIds.length)).toBe(2)
  await expect(page.getByText(/is built/)).toHaveCount(0)
})

const quizAction = (extra = {}) => ({ tool_call: 'generate_quiz', source_plan_id: null, target_quiz_id: null, instruction: 'Assess inference with a five-minute paper quiz; preserve accessible wording.', question_types: ['multiple_choice'], num_questions: 5, passage_mode: 'none', revises_current: false, ...extra })

async function trackQuizzes(page) {
  await page.evaluate(() => {
    const original = window.fetch
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url
      if (init.method === 'POST' && /\/quizzes(?:\/[^/]+\/revise)?$/.test(url)) {
        window.chatCalls.push({ path: 'quiz', url, body: JSON.parse(init.body) })
        if (window.revisionFailure) return new Response(JSON.stringify({ error: { code: 'quiz_failed', message: 'Quiz test failure' } }), { status: 500 })
      }
      return original(input, init)
    }
  })
}

test('standalone quiz with a plan open preserves the plan and carries constraints into revision', async ({ page }) => {
  await openChat(page)
  await trackQuizzes(page)
  const before = await page.evaluate(() => structuredClone(window.__mock.state.plans.plan1))
  await events(page, [quizAction(), done])
  await send(page, 'Create a separate inference quiz with accessible wording, five minutes, on paper.')
  await expect(page.getByText(/Built "/).last()).toBeVisible()
  const create = await page.evaluate(() => window.chatCalls.find((c) => c.path === 'quiz'))
  expect(create.url).toContain('/classes/c1/quizzes')
  expect(create.body.instruction).toContain('accessible wording')
  const quizId = await page.evaluate(() => window.__mock.state.standaloneQuizzes.c1[0].id)
  await events(page, [quizAction({ revises_current: true, target_quiz_id: quizId, instruction: 'Make the inference more demanding, retaining five minutes and accessible wording.' }), done])
  await send(page, 'Make this quiz harder.')
  await expect(page.getByText(/Updated "/).last()).toBeVisible()
  const revise = await page.evaluate(() => window.chatCalls.filter((c) => c.path === 'quiz').at(-1))
  expect(revise.url).toContain(`/quizzes/${quizId}/revise`)
  expect(revise.body.feedback).toContain('five minutes and accessible wording')
  expect(await page.evaluate(() => window.__mock.state.standaloneQuizzes.c1.length)).toBe(1)
  expect(await page.evaluate(() => window.__mock.state.plans.plan1)).toEqual(before)
})

test('a week and a quiz in one turn builds the plan then the quiz', async ({ page }) => {
  await openChat(page, true)
  await page.evaluate(() => {
    const original = window.fetch
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url
      if (init.method === 'POST' && /\/plans\/[^/]+\/quiz$/.test(url)) {
        window.chatCalls.push({ path: 'plan-quiz', url, body: JSON.parse(init.body) })
      }
      return original(input, init)
    }
  })
  await events(page, [planAction('create', { also_quiz: true }), done])
  await send(page, 'Plan a week on Gatsby and make a quiz.')
  await expect.poll(() => page.evaluate(() => window.chatCalls.filter((c) => c.path === 'create').length)).toBe(1)
  await expect.poll(() => page.evaluate(() => window.chatCalls.filter((c) => c.path === 'plan-quiz').length)).toBe(1)
  const quiz = await page.evaluate(() => window.chatCalls.find((c) => c.path === 'plan-quiz'))
  expect(quiz.url).toMatch(/\/plans\/[^/]+\/quiz$/)
})

test('optional suggestions can be skipped or typed past without starting work', async ({ page }) => {
  await openChat(page, true)
  await events(page, [planAction('create'), done])
  await send(page, 'Build a week on inference with paper materials and 45-minute periods.')
  await expect(page.getByText('Optional next step for this lesson plan', { exact: true })).toBeVisible()
  const calls = await page.evaluate(() => window.chatCalls.length)
  await page.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(page.getByText('Optional next step for this lesson plan', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.chatCalls.length)).toBe(calls)
  await send(page, 'Why start with modeling?')
  await expect(page.getByText('Try a short modeled example, then check an independent response.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.chatCalls.filter((c) => c.path === 'create').length)).toBe(1)
})

test('clicking a question answer preserves the full question and previous constraints', async ({ page }) => {
  await openChat(page, true)
  await events(page, [{ tool_call: 'ask_clarifying_questions', questions: [{ id: 'goal', text: 'Which skill should students practice?', options: ['Evidence', 'Organization'] }] }, done])
  await send(page, 'Plan next week using paper materials in 45-minute periods.')
  await expect(page.getByText('Which skill should students practice?', { exact: true })).toBeVisible()
  await events(page, [planAction('create'), done])
  await page.getByRole('button', { name: 'Evidence', exact: true }).click()
  await expect(page.getByText(/is built/).last()).toBeVisible()
  const last = await page.evaluate(() => window.chatCalls.filter((c) => c.path === 'chat').at(-1).body)
  expect(JSON.stringify(last.messages)).toContain('Which skill should students practice? (Evidence / Organization)')
  expect(JSON.stringify(last.messages)).toContain('45-minute periods')
})

test('failed quiz revision retains the saved quiz and never reports updated', async ({ page }) => {
  await openChat(page, true)
  await trackQuizzes(page)
  await events(page, [quizAction(), done])
  await send(page, 'Make a five-question multiple-choice inference quiz.')
  await expect(page.getByText(/Built "/).last()).toBeVisible()
  const before = await page.evaluate(() => structuredClone(window.__mock.state.standaloneQuizzes.c1[0]))
  await page.evaluate(() => { window.revisionFailure = true })
  await events(page, [quizAction({ revises_current: true, target_quiz_id: before.id }), done])
  await send(page, 'Make this quiz harder.')
  await expect(page.getByText(/Quiz test failure/).first()).toBeVisible()
  expect(await page.evaluate(() => window.__mock.state.standaloneQuizzes.c1[0])).toEqual(before)
  await expect(page.getByText(/Updated "/)).toHaveCount(0)
})

test('unspecified quiz uses a 5-question default instead of interviewing', async ({ page }) => {
  await page.goto('/preview.html?fresh=0&trial=3&at=/c/c1/chat/seed1')
  await expect(page.locator('#composer-input')).toBeVisible()
  await send(page, 'make a quiz')
  await expect(page.getByText(/5-question multiple-choice/i)).toBeVisible()
  await expect(page.getByText('What kind of questions?', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/Built "/).last()).toBeVisible()
  await page.locator('#composer-input').fill('Could a debate help?')
  await expect(page.locator('#composer-input')).toHaveValue('Could a debate help?')
})
