import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { recoverDumpedToolsFromText } from '../src/lib/chatToolRecovery.js'
import { planOperation, quizReceipt, quizRevisionId, readQuizReceipt, revisionDayIndices, shouldStreamPlanRevision } from '../src/lib/chatActions.js'
import { isClearlySpecifiedPlanRequest } from '../src/lib/planIntent.js'

// Run the actual hook's streaming code without a DOM. Only React state storage,
// timing instrumentation, and the API URL are stubbed; fetch uses real Responses.
async function harness(responses, callbacks = {}) {
  const calls = []
  const noop = () => {}
  class ApiError extends Error {
    constructor(message, options = {}) { super(message); Object.assign(this, options) }
  }
  const context = vm.createContext({
    AbortController, TextDecoder, Response, crypto,
    setTimeout, clearTimeout,
    window: { setTimeout, clearTimeout },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body))
      const response = responses.shift()
      if (typeof response === 'function') return response(init)
      if (response instanceof Error) throw response
      return new Response(response.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  const modules = {
    react: { useCallback: (fn) => fn, useEffect: noop, useRef: (current) => ({ current }), useState: (initial) => [initial, noop] },
    '../lib/api': { ApiError, api: { chatStreamUrl: () => '/api/chat_stream' }, apiErrorFromBody: (body) => new ApiError(body.error.message, body.error) },
    '../lib/voiceMetrics': { firstToken: noop },
    '../lib/chatToolRecovery': { recoverDumpedToolsFromText },
    '../lib/performanceMetrics': { mark: noop, measure: noop },
  }
  const source = await readFile(new URL('../src/hooks/useChatStream.js', import.meta.url), 'utf8')
  const module = new vm.SourceTextModule(source, { context })
  await module.link((specifier) => new vm.SyntheticModule(Object.keys(modules[specifier]), function () {
    for (const [key, value] of Object.entries(modules[specifier])) this.setExport(key, value)
  }, { context }))
  await module.evaluate()
  return { hook: module.namespace.useChatStream(callbacks), calls }
}
const action = { tool_call: 'generate_lesson_plan', action: 'create', target_plan_id: null, instruction: 'Build argument analysis.', days: [], field: null }
const done = { done: true }

test('whole-day edits stream instead of blocking on a REST rewrite', () => {
  assert.equal(shouldStreamPlanRevision({ action: 'revise_week' }), true)
  assert.equal(shouldStreamPlanRevision({ action: 'revise_days', field: null, days: ['Wednesday'] }), true)
  assert.equal(shouldStreamPlanRevision({ action: 'revise_days', field: 'during', days: ['Wednesday'] }), false)
  assert.equal(shouldStreamPlanRevision({ action: 'create' }), false)
})

test('clear first requests skip the routing hop', () => {
  assert.equal(isClearlySpecifiedPlanRequest('make a lesson plan'), false)
  assert.equal(isClearlySpecifiedPlanRequest('Plan Week 03 around voice, tone, and rhetorical devices using The Cask.'), true)
  assert.equal(isClearlySpecifiedPlanRequest('Build a lesson plan about quadratic vertex form for graphing practice'), true)
  assert.equal(isClearlySpecifiedPlanRequest('Help me plan this week.'), false)
})

test('advice does not dispatch an artifact; explicit creation wins over open plan', () => {
  assert.equal(planOperation({ text: 'Try modeling.' }, 'p1'), null)
  assert.equal(planOperation({ toolCalled: true, planAction: action }, 'p1').action, 'create')
  assert.throws(() => planOperation({ toolCalled: true }, 'p1'), /incomplete/)
  assert.equal(planOperation({ toolCalled: true }, 'p1', { voice: true }).action, 'revise_week')
})

test('stale revision targets bind to the open plan instead of failing the turn', () => {
  const bound = planOperation({ toolCalled: true, planAction: { ...action, action: 'revise_week', target_plan_id: 'stale-plan' } }, 'p1')
  assert.equal(bound.action, 'revise_week')
  assert.equal(bound.target_plan_id, 'p1')
  assert.throws(() => planOperation({ toolCalled: true, planAction: { ...action, action: 'revise_days', target_plan_id: 'p2' } }, null), /active plan changed/)
  const plan = { days: [{ name: 'Wednesday' }, { name: 'Friday' }] }
  assert.deepEqual(revisionDayIndices(plan, ['Friday']), [1])
  assert.throws(() => revisionDayIndices(plan, ['Monday']), /no Monday/)
})

test('a truncated action still starts work once without retrying chat', async () => {
  let completed = 0
  let dispatched = 0
  const actions = []
  const { hook, calls } = await harness([[action], [action, done]], {
    onDone: () => completed++, onGeneratePlan: () => dispatched++, onAction: (payload) => actions.push(payload),
  })
  const result = await hook.start([{ role: 'user', content: 'Build a separate plan' }], { activePlanId: 'old-plan', requestId: 'r1' })
  assert.equal(result.planAction.action, 'create')
  assert.equal(actions.length, 1)
  assert.equal(completed, 1)
  assert.equal(dispatched, 1)
  assert.deepEqual(calls.map((c) => c.attempt), [0])
  assert.ok(calls.every((c) => c.request_id === 'r1' && c.active_plan_id === 'old-plan'))
  assert.equal(calls[0].plan_open, false)
})

test('plan overlay flag reaches the chat stream', async () => {
  const { hook, calls } = await harness([[{ chunk: 'Updating the week.' }, done]])
  await hook.start([{ role: 'user', content: 'Ask questions' }], { activePlanId: 'p1', planOpen: true })
  assert.equal(calls[0].plan_open, true)
  assert.equal(calls[0].active_plan_id, 'p1')
})

test('exhausted truncated streams never dispatch or complete', async () => {
  let completed = 0
  let dispatched = 0
  const { hook } = await harness([[{ chunk: 'Still thinking' }], [{ chunk: 'Still thinking' }], [{ chunk: 'Still thinking' }], [{ chunk: 'Still thinking' }]], {
    onDone: () => completed++, onGeneratePlan: () => dispatched++,
  })
  await assert.rejects(hook.start([], { requestId: 'r2' }), /closed unexpectedly/)
  assert.equal(completed, 0)
  assert.equal(dispatched, 0)
})

test('failed stream after an action never hands off a mutation', async () => {
  let dispatched = 0
  const { hook } = await harness([[action, { error: { code: 'invalid_plan_target', message: 'Wrong target' } }]], { onGeneratePlan: () => dispatched++ })
  await assert.rejects(hook.start([]), /Wrong target/)
  assert.equal(dispatched, 0)
})

test('single-day actions retain target metadata and do not become plan creation', async () => {
  const event = { tool_call: 'update_lesson_day', day: 'Wednesday', field: 'assessment', feedback: 'Use an exit ticket', target_plan_id: 'p1' }
  const { hook } = await harness([[event, done]])
  const result = await hook.start([])
  assert.equal(result.toolCalled, true)
  assert.equal(result.dayRevisionRequested.targetPlanId, 'p1')
  assert.equal(result.dayRevisionRequested.field, 'assessment')
})

test('frames for another request or retry attempt cannot dispatch', async () => {
  const { hook } = await harness([[{ ...action, request_id: 'old' }, { ...action, attempt: 2 }, { chunk: 'Advice.' }, done]])
  const result = await hook.start([], { requestId: 'current' })
  assert.equal(result.toolCalled, false)
  assert.equal(result.text, 'Advice.')
})

test('stopping a delayed response suppresses completion and mutation', async () => {
  let release
  let dispatched = 0
  const waiting = new Promise((resolve) => { release = resolve })
  const { hook } = await harness([async () => {
    await waiting
    return new Response(`data: ${JSON.stringify(action)}\n\ndata: ${JSON.stringify(done)}\n\n`)
  }], { onGeneratePlan: () => dispatched++ })
  const pending = hook.start([])
  hook.stop()
  release()
  assert.equal(await pending, null)
  assert.equal(dispatched, 0)
})

test('quiz revision uses the open quiz when the model omits the id', () => {
  assert.equal(quizRevisionId({ revisesCurrent: true, targetQuizId: 'q1' }, { id: 'q1' }), 'q1')
  assert.equal(quizRevisionId({ revisesCurrent: true }, { id: 'q1' }), 'q1')
  assert.equal(quizRevisionId({ revisesCurrent: false, targetQuizId: 'q1' }, { id: 'q1' }), null)
})


test('saved quiz metadata survives different completion wording without guessing a plan', () => {
  const quiz = { id: 'quiz-123', plan_id: null }
  const receipt = quizReceipt(quiz, 'Ready whenever you are.')
  assert.deepEqual(readQuizReceipt(receipt), { content: 'Ready whenever you are.', quiz: { id: quiz.id, planId: null } })
  assert.equal(readQuizReceipt('Built a quiz.').quiz, null)
})

test('typed chat recovers quiz arguments dumped as plain text', async () => {
  const dumped = { chunk: JSON.stringify({ question_types: ['multiple_choice'], num_questions: 5, instruction: 'Five inference items' }) }
  let dispatched = 0
  const { hook } = await harness([[dumped, done]], { onGeneratePlan: () => dispatched++ })
  const result = await hook.start([])
  assert.equal(result.quizRequested.numQuestions, 5)
  assert.equal(result.quizRequested.instruction, 'Five inference items')
  assert.equal(dispatched, 1)
})

test('artifact action waits until the chat reply has landed', async () => {
  const order = []
  const { hook } = await harness([[
    { chunk: 'I’ll make a 5-question multiple-choice check.' },
    action,
    done,
  ]], {
    onAction: (payload) => order.push(`action:${payload.planAction.action}`),
    onDone: () => order.push('done'),
    onGeneratePlan: () => order.push('generate'),
  })
  const result = await hook.start([], { requestId: 'r-overlap' })
  assert.deepEqual(order, ['generate', 'done', 'action:create'])
  assert.match(result.text, /5-question/)
})

test('truncated tool streams still emit onAction only once', async () => {
  const actions = []
  const { hook } = await harness([[action], [action, done]], {
    onAction: (payload) => actions.push(payload),
  })
  await hook.start([], { requestId: 'r-once' })
  assert.equal(actions.length, 1)
})

test('also_quiz on a plan action requests the quiz in the same turn', async () => {
  const actions = []
  const { hook } = await harness([[{ ...action, also_quiz: true }, done]], {
    onAction: (payload) => actions.push(payload),
  })
  const result = await hook.start([], { requestId: 'r-both' })
  assert.equal(actions.length, 1)
  assert.equal(result.planAction.also_quiz, true)
  assert.equal(result.quizRequested.numQuestions, 5)
  assert.equal(result.quizRequested.questionTypes[0], 'multiple_choice')
  assert.equal(result.quizRequested.instruction, action.instruction)
})
