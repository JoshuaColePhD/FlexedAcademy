/* A canned backend, for looking at the UI without one.
 *
 * DEV ONLY — Vite builds index.html, so nothing here reaches production.
 *
 * This is a real fake: chats and messages live in memory and every mutation is
 * applied, so chat creation, renaming, deleting and switching exercise the same
 * client state machine the real API does. Latency is per-endpoint and settable
 * from the console (`__mock.latency.addMessage = 800`), which is what makes
 * ordering races reproducible instead of occasional.
 */

const DAY_TITLES = {
  Monday: 'Ethos & audience',
  Tuesday: 'Diction & syntax',
  Wednesday: 'Irony workshop',
  Thursday: 'Socratic seminar',
  Friday: 'Pep rally',
}

const DAYS = [
  {
    name: 'Monday',
    learning_targets: "I can identify how a writer's ethos shapes an audience's trust.",
    standards: 'ELA21.11.R2 -- Analyze how an author develops a point of view',
    act_alignment: 'R.TST.701',
    engagement_strategy: ['Think/Pair/Share'],
    do_now: 'Rank four openings by how much you trust the speaker.',
    during: 'Explicit instruction on ethos, then A/B partners annotate the Poe passage.',
    assessment: 'Exit ticket: one marker, quoted, with a sentence on its effect.',
  },
  {
    name: 'Tuesday',
    learning_targets: 'I can explain how word choice and syntax convey tone.',
    standards: 'RHS-2 -- Make strategic choices in a text',
    act_alignment: 'ORG 403',
    engagement_strategy: ['Gallery Walk', 'Small Groups'],
    do_now: 'Three sentences, same content, different syntax. Which is coldest?',
    during: 'Gallery walk of six passages; groups label diction and syntax moves.',
    assessment: 'Group placard defended in one minute.',
  },
  {
    name: 'Wednesday',
    learning_targets: 'I can trace dramatic irony across a narrative.',
    standards: '4.C -- Trace an ironic structure, ELA21.11.R2',
    act_alignment: 'R.TST.701',
    engagement_strategy: ['Small Groups'],
    do_now: 'What does Fortunato think is happening?',
    during: 'Jigsaw the middle section; each group tracks one ironic reversal.',
    assessment: 'Annotated reversal chart.',
  },
  {
    name: 'Thursday',
    learning_targets: 'I can defend a reading in discussion, citing evidence.',
    standards: 'CLE-4 -- Analyze and select evidence to develop a claim',
    act_alignment: 'ORG 403',
    engagement_strategy: ['Write 1st, Talk 2nd'],
    do_now: 'Write the claim you will defend in one sentence.',
    during: 'Socratic seminar — inner circle 20 min, outer circle tracks moves.',
    assessment: 'Seminar tracker plus a reflection paragraph.',
  },
]

const makePlan = (label) => ({
  week_of: label,
  teacher: 'Josh Cole',
  course: 'AP Language & Composition',
  period: '3rd period',
  days: [
    ...DAYS.map((d) => ({ ...d, no_school: false, title: DAY_TITLES[d.name] })),
    { name: 'Friday', no_school: true, title: 'Pep rally' },
  ],
})

const RETRIEVED = ['ELA21.11.R2', 'RHS-2', 'CLE-4', 'R.TST.701', 'ORG 403']
const WARNINGS = ['Wednesday cites 4.C, which retrieval never supplied — swap in a grounded code.']

/* ── in-memory state ─────────────────────────────────────────────────────── */
let seq = 0
const uid = (p) => `${p}_${++seq}`

const state = {
  // Default: billing live, one free week already spent — i.e. the paywall
  // state, because that is the one worth being able to look at. Flip
  // may_generate back to true (or billing_enabled to false) to leave it.
  entitlement:
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mock.subscribed')
      ? {
          may_generate: true,
          subscribed: true,
          status: 'active',
          plans_used: 1,
          free_allowance: 1,
          free_remaining: 0,
          billing_enabled: true,
        }
      : {
          may_generate: false,
          subscribed: false,
          status: null,
          plans_used: 1,
          free_allowance: 1,
          free_remaining: 0,
          billing_enabled: true,
        },
  chats: [
    { id: 'seed1', title: 'Week 03 — voice and tone', class_id: 'c1', updated_at: '2026-08-07' },
    { id: 'stranded', title: 'plan week 12 on satire', class_id: 'c1', updated_at: '2026-08-06' },
    { id: 'physics', title: 'Kinematics week', class_id: 'c2', updated_at: '2026-08-05' },
    // Never attributed — must appear under BOTH classes, not vanish.
    { id: 'legacy', title: 'an old chat with no class', class_id: null, updated_at: '2026-08-01' },
  ],
  messages: {
    // The pre-fix shape: a plan was built, but no assistant message was ever
    // persisted, so nothing in the transcript names it. Only plans.chat_id knows.
    stranded: [
      { role: 'user', content: 'plan week 12 on satire', plan_id: null },
    ],
    seed1: [
      { role: 'user', content: 'Plan Week 03 — voice and tone with "The Cask of Amontillado."' },
      {
        role: 'assistant',
        content: 'Four teaching days — Friday is a pep rally, so the exit assessment moved to Thursday.',
        plan_id: 'plan1',
      },
    ],
  },
  plans: { plan1: makePlan('Week 03 — Aug 17-21, 2026'), planOrphan: makePlan('Week 12 — Oct 19-23, 2026') },
  planChat: { plan1: 'seed1', planOrphan: 'stranded' },
  documents: [],
}

/* Per-endpoint latency, in ms. Tunable from the console at runtime so a race
   can be forced open rather than waited for. */
const latency = {
  getChat: 60,
  createChat: 120,
  addMessage: 400, // deliberately SLOWER than getChat — see the new-chat race
  listChats: 60,
  renameChat: 150,
  deleteChat: 150,
  getPlan: 80,
  stream: 900,
}

const calls = []
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

function sse(chunks) {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(c) {
        for (const [payload, delay] of chunks) {
          await wait(delay)
          c.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
        }
        c.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

export function installMockApi() {
  const real = window.fetch.bind(window)

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    if (!url.startsWith('/api') && !url.includes('/api/')) return real(input, init)
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const method = (init.method || 'GET').toUpperCase()
    // Only JSON bodies parse. Uploads send FormData, and JSON.parse on it threw
    // before any route matched — so every upload failed inside the mock and the
    // app dutifully reported "Could not read that file".
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ path, method, at: performance.now() })

    /* The entitlement rides on /me exactly as it does in production, so the
       paywall can be driven here. Tune it live:
         window.__mock.entitlement = { may_generate: false, subscribed: false,
           status: null, plans_used: 1, free_allowance: 1, free_remaining: 0,
           billing_enabled: true } */
    if (path === '/api/auth/me')
      return json({ id: 'u1', name: 'Josh Cole', email: 'jc@x.org', entitlement: state.entitlement })
    if (path === '/api/billing')
      return json({ ...state.entitlement, price: { amount: 1200, currency: 'USD', interval: 'month', interval_count: 1 } })
    if (path === '/api/billing/checkout' || path === '/api/billing/portal') {
      // Stripe redirects the browser, so the app reloads and this module's
      // state is rebuilt from scratch — the way it would be in production,
      // where the webhook is what actually changed something. sessionStorage
      // stands in for the webhook so the return-from-checkout path is drivable.
      sessionStorage.setItem('mock.subscribed', '1')
      return json({ url: `${window.location.origin}/preview.html?checkout=success` })
    }
    if (path === '/api/classes' && method === 'GET')
      return json([
        { id: 'c1', name: 'AP Language & Composition', subject: 'AP Lang', grade: '11' },
        { id: 'c2', name: 'AP Physics 1', subject: 'Science', grade: '11' },
      ])
    if (path === '/api/frameworks')
      // `chunks` and `verbatim_ok` are not optional — FrameworkPicker calls
      // .toLocaleString() on chunks directly.
      return json([
        { subject: 'AP_Lang', label: 'AP English Language and Composition (2019)', chunks: 59, verbatim_ok: 59 },
        { subject: 'ELA', label: 'Alabama Course of Study: ELA (2021)', chunks: 1240, verbatim_ok: 1180 },
      ])
    if (path === '/api/classes' && method === 'POST') {
      await wait(200)
      const id = uid('class')
      // Mirrors _auto_name: int(grade) is what turns a bad grade into NaN-th.
      const n = Number(body.grade)
      return json({ id, name: `${body.subject} · ${Number.isFinite(n) ? `${n}th` : `${body.grade}th`}` })
    }
    if (path === '/api/me' && method === 'PATCH') { await wait(120); return json({ ok: true }) }

    /* Class documents, faithful to the real thing: the upload only becomes
       visible if it carried a class_id, which is the bug under test. */
    if (path === '/api/curriculum_map' && method === 'POST') {
      await wait(300)
      const fd = init.body // FormData
      const classId = fd.get?.('class_id')
      const kind = fd.get?.('kind') || 'pacing_guide'
      const f = fd.get?.('file')
      const id = uid('doc')
      if (classId) {
        state.documents = state.documents.filter((d) => !(d.class_id === classId && d.kind === kind))
        state.documents.push({ id, class_id: classId, kind, original_name: f?.name || 'upload.pdf', chars: 12345 })
      }
      return json({ id, weeks_parsed: 12 })
    }
    const docDel = path.match(/^\/api\/curriculum_map\/([^/]+)$/)
    if (docDel && method === 'DELETE') {
      await wait(200)
      state.documents = state.documents.filter((d) => d.id !== docDel[1])
      return new Response(null, { status: 204 })
    }
    const docList = path.match(/^\/api\/classes\/([^/]+)\/documents$/)
    if (docList && method === 'GET') {
      await wait(120)
      return json(state.documents.filter((d) => d.class_id === docList[1]))
    }
    if (path === '/api/extract_text' && method === 'POST') {
      await wait(200)
      const f = init.body?.get?.('file')
      return json({ filename: f?.name || 'syllabus.pdf', text: 'UNIT 2 PACING: weeks 3-6 cover voice and tone.', chars: 46 })
    }

    /* ── chats ───────────────────────────────────────────────────────────── */
    if (path === '/api/chats' && method === 'GET') {
      await wait(latency.listChats)
      const cid = new URL(url, location.origin).searchParams.get('class_id')
      // Mirrors db.list_chats: scoped, but NULL belongs to everyone.
      return json(cid ? state.chats.filter((c) => c.class_id === cid || c.class_id == null) : state.chats)
    }
    if (path === '/api/chats/title' && method === 'POST') {
      // Stands in for the model: returns something that is NOT the raw prompt,
      // so a test can tell the suggestion apart from the placeholder.
      await wait(250)
      return json({ title: 'Gatsby — symbolism week' })
    }
    if (path === '/api/chats' && method === 'POST') {
      await wait(latency.createChat)
      const id = uid('chat')
      state.chats.unshift({ id, title: body.title, class_id: body.class_id ?? null, updated_at: 'now' })
      state.messages[id] = []
      return json({ id, title: body.title })
    }

    const chatMatch = path.match(/^\/api\/chats\/([^/]+)$/)
    if (chatMatch) {
      const id = chatMatch[1]
      if (method === 'GET') {
        await wait(latency.getChat)
        if (!state.chats.find((c) => c.id === id)) return new Response('{}', { status: 404 })
        return json({ id, messages: state.messages[id] || [] })
      }
      if (method === 'PATCH') {
        await wait(latency.renameChat)
        const c = state.chats.find((x) => x.id === id)
        if (c) c.title = body.title
        return json(c || {})
      }
      if (method === 'DELETE') {
        await wait(latency.deleteChat)
        state.chats = state.chats.filter((c) => c.id !== id)
        delete state.messages[id]
        return new Response(null, { status: 204 })
      }
    }

    const msgMatch = path.match(/^\/api\/chats\/([^/]+)\/messages$/)
    if (msgMatch && method === 'POST') {
      await wait(latency.addMessage)
      const id = msgMatch[1]
      ;(state.messages[id] ||= []).push({
        role: body.role,
        content: body.content,
        plan_id: body.plan_id || null,
      })
      return json({ ok: true })
    }

    if (path === '/api/plans' && method === 'GET') {
      await wait(latency.getPlan)
      const chatId = new URL(url, location.origin).searchParams.get('chat_id')
      const ids = Object.keys(state.plans).filter((id) => !chatId || state.planChat[id] === chatId)
      // Mirrors db.list_plans: the list view drops plan_json.
      return json({ items: ids.map((id) => ({ id, week_label: state.plans[id].week_of })), total: ids.length })
    }

    /* ── plans ───────────────────────────────────────────────────────────── */
    const planMatch = path.match(/^\/api\/plans\/([^/]+)$/)
    if (planMatch && method === 'GET') {
      await wait(latency.getPlan)
      const p = state.plans[planMatch[1]]
      if (!p) return new Response('{}', { status: 404 })
      return json({
        id: planMatch[1],
        plan_json: p,
        warnings: WARNINGS,
        retrieved_ids: RETRIEVED,
        unit: 'Unit 2 · weeks 3–6',
        week_label: p.week_of,
      })
    }

    if (path === '/api/generate_stream') {
      // Recorded so a test can assert what the MODEL received, as against what
      // the transcript shows — the two are deliberately different once a file
      // is attached.
      state.lastPrompt = body?.query ?? null
      const planId = uid('plan')
      const label = `Week ${String(seq).padStart(2, '0')} — Aug 17-21, 2026`
      state.plans[planId] = makePlan(label)
      return sse([
        [{ grounding: { codes: RETRIEVED, thin: false, count: 5, floor: 0.65 } }, 200],
        [{ chunk: '{"week_of":"' + label + '","days":[' }, latency.stream / 3],
        [{ chunk: '{"name":"Monday"}' }, latency.stream / 3],
        [
          {
            done: true,
            plan_id: planId,
            plan: state.plans[planId],
            warnings: WARNINGS,
            week_label: label,
            unit: 'Unit 2 · weeks 3–6',
            retrieved_ids: RETRIEVED,
          },
          latency.stream / 3,
        ],
      ])
    }

    /* The conversational model in front of generation. A message asking for a
       week calls the tool (which is what makes ChatPage go on to build);
       anything else just talks back, so both branches are drivable. */
    if (path === '/api/chat_stream') {
      const last = [...(body?.messages || [])].reverse().find((m) => m.role === 'user')?.content || ''
      const wantsPlan = /\b(plan|week|build|unit|lesson)\b/i.test(last)
      return sse(
        wantsPlan
          ? [
              [{ chunk: 'On it — building that week now.' }, 120],
              [{ tool_call: 'generate_lesson_plan' }, 120],
              [{ done: true }, 60],
            ]
          : [
              [{ chunk: 'Happy to talk it through. ' }, 120],
              [{ chunk: 'What are you hoping they walk away with?' }, 120],
              [{ done: true }, 60],
            ]
      )
    }

    const revise = path.match(/^\/api\/plans\/([^/]+)\/revise$/)
    if (revise && method === 'POST') {
      // Slow on purpose: a revision is NOT abortable, and the composer's
      // mid-revision state is the thing under test.
      await wait(1500)
      const p = state.plans[revise[1]] || Object.values(state.plans)[0]
      return json({ id: revise[1], plan_json: p, warnings: WARNINGS, retrieved_ids: RETRIEVED, week_label: p.week_of })
    }

    if (path === '/api/revise_day') {
      await wait(300)
      const p = state.plans[body.plan_id] || Object.values(state.plans)[0]
      const d = p.days[body.day_index]
      if (body.field) p.days[body.day_index] = { ...d, [body.field]: `${body.feedback} — rewritten.` }
      return json({
        id: body.plan_id,
        plan_json: p,
        warnings: WARNINGS,
        retrieved_ids: RETRIEVED,
        week_label: p.week_of,
      })
    }

    if (path.startsWith('/api/standards/'))
      return json({
        description: 'Analyze how an author develops and refines a point of view.',
        source_document: 'Alabama Course of Study: ELA (2021)',
        source_page_or_section: 'Grade 11, R2',
        verbatim_ok: true,
      })

    return json({})
  }

  // Handle for the test driver.
  window.__mock = { state, latency, calls, reset: () => calls.splice(0) }
}
