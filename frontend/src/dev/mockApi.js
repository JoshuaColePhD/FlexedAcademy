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

/* Keyed by the same normalized form Citation.jsx uses (lib/codes.js) — one
   entry per RETRIEVED code, each with its own real-looking text. This used to
   be a single canned response returned for EVERY code, so every citation
   popover — grounded or not — showed identical "Analyze how an author
   develops a point of view" text. That made the one thing this app is
   supposed to prove (a citation shows what it actually says) untestable in
   the mock: 4.C's popover looked exactly as trustworthy as ELA21.11.R2's. */
const STANDARDS = {
  'ELA21.11.R2': {
    description: 'Analyze how an author develops and refines a point of view.',
    source_document: 'Alabama Course of Study: ELA (2021)',
    source_page_or_section: 'Grade 11, R2',
    verbatim_ok: true,
  },
  'RHS-2': {
    description: 'Make strategic use of digital media in presentations to add interest and enhance understanding.',
    source_document: 'Alabama Course of Study: ELA (2021)',
    source_page_or_section: 'Grade 11, RHS-2',
    verbatim_ok: true,
  },
  'CLE-4': {
    description: 'Analyze and select evidence to develop a claim, distinguishing it from opposing claims.',
    source_document: 'Alabama Course of Study: ELA (2021)',
    source_page_or_section: 'Grade 11, CLE-4',
    verbatim_ok: true,
  },
  'R.TST.701': {
    description: 'Cite strong and thorough textual evidence to support analysis of what a text says explicitly and inferentially.',
    source_document: 'ACT College & Career Readiness Standards',
    source_page_or_section: 'Reading, 701',
    verbatim_ok: true,
  },
  'ORG 403': {
    description: 'Use transitions to clarify the relationships between ideas and claims.',
    source_document: 'ACT College & Career Readiness Standards',
    source_page_or_section: 'English, 403',
    verbatim_ok: true,
  },
}

/* ── in-memory state ─────────────────────────────────────────────────────── */
let seq = 0
const uid = (p) => `${p}_${++seq}`

const state = {
  me: { name: 'Josh Cole', custom_instructions: '' },
  // Default: billing live, weekly usage cap already hit — i.e. the paywall
  // state, because that is the one worth being able to look at. Flip
  // may_generate back to true (or billing_enabled to false) to leave it.
  // Shape matches entitlement.Entitlement.as_dict() — token-capped, not
  // plan-counted (backend/entitlement.py).
  entitlement:
    typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mock.subscribed')
      ? {
          may_generate: true,
          subscribed: true,
          status: 'active',
          plans_used: 6,
          tokens_used: 40_000,
          token_cap: 2_000_000,
          tokens_remaining: 1_960_000,
          usage_window_days: 7,
          billing_enabled: true,
          period_end: '2026-09-12T14:00:00+00:00',
        }
      : {
          may_generate: false,
          subscribed: false,
          status: null,
          plans_used: 4,
          tokens_used: 150_000,
          token_cap: 150_000,
          tokens_remaining: 0,
          usage_window_days: 7,
          billing_enabled: true,
          period_end: null,
        },
  classes: [
    { id: 'c1', name: 'AP Language & Composition', subject: 'AP_Lang', grade: '11', sort_order: 0 },
    { id: 'c2', name: 'AP Physics 1', subject: 'Science', grade: '11', sort_order: 1 },
  ],
  accounts: [
    { id: 'u1', email: 'jc@x.org', name: 'Josh Cole', subscription_status: 'comped', is_admin: true,
      created_at: '2026-08-06T21:54:36+00:00', plans_built: 7, last_plan_at: '2026-08-08T01:44:46+00:00', tokens_used: 812_400 },
    { id: 'u2', email: 'trial.teacher@example.com', name: 'Trial Teacher', subscription_status: null, is_admin: false,
      created_at: '2026-08-07T12:00:00+00:00', plans_built: 1, last_plan_at: '2026-08-07T12:30:00+00:00', tokens_used: 148_900 },
    { id: 'u3', email: 'paying.teacher@example.com', name: 'Paying Teacher', subscription_status: 'active', is_admin: false,
      created_at: '2026-08-01T09:00:00+00:00', plans_built: 12, last_plan_at: '2026-08-08T08:00:00+00:00', tokens_used: 1_204_600 },
  ],
  chats: [
    { id: 'seed1', title: 'Week 03 — voice and tone', class_id: 'c1', updated_at: '2026-08-07' },
    { id: 'stranded', title: 'plan week 12 on satire', class_id: 'c1', updated_at: '2026-08-06' },
    { id: 'physics', title: 'Kinematics week', class_id: 'c2', updated_at: '2026-08-05' },
    // Never attributed — must appear under BOTH classes, not vanish.
    { id: 'legacy', title: 'an old chat with no class', class_id: null, updated_at: '2026-08-01' },
    // Padding past SEARCH_THRESHOLD (AppShell.jsx) and spanning every date
    // bucket (Today/Yesterday/This week/Older) — the four chats above alone
    // never exercised either the search box or the Today/Yesterday buckets.
    { id: 'gatsby1', title: 'Gatsby — symbolism week', class_id: 'c1', updated_at: '2026-08-10' },
    { id: 'gatsby2', title: 'Gatsby — the green light', class_id: 'c1', updated_at: '2026-08-10' },
    { id: 'rhetoric1', title: 'Rhetorical triangle intro', class_id: 'c1', updated_at: '2026-08-09' },
    { id: 'cask1', title: 'Cask of Amontillado — irony', class_id: 'c1', updated_at: '2026-08-08' },
    { id: 'unit4', title: 'Unit 4 kickoff planning', class_id: 'c1', updated_at: '2026-07-20' },
    { id: 'satire2', title: 'Satire — A Modest Proposal', class_id: 'c1', updated_at: '2026-07-18' },
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
  // GET /api/weeks — db.week_board()'s shape. Week 03 is built and links to
  // seed1 (the has_plan-and-openable case); week 12 is built but with no
  // chat_id (the pre-chat_id-tracking orphan case, plain text not a link);
  // week 02 is past and never built (the "missed" case); the rest are
  // upcoming, and week 06 is a whole-week closure.
  weeks: [
    { week: 1, start: '2026-08-03', end: '2026-08-07', no_school: false, has_plan: false, is_current: false, is_past: true, plan_id: null, chat_id: null, unit: null },
    { week: 2, start: '2026-08-10', end: '2026-08-14', no_school: false, has_plan: false, is_current: false, is_past: true, plan_id: null, chat_id: null, unit: null },
    { week: 3, start: '2026-08-17', end: '2026-08-21', no_school: false, has_plan: true, is_current: true, is_past: false, plan_id: 'plan1', chat_id: 'seed1', unit: 'Voice, Tone & Rhetorical Devices' },
    { week: 4, start: '2026-08-24', end: '2026-08-28', no_school: false, has_plan: false, is_current: false, is_past: false, plan_id: null, chat_id: null, unit: null },
    { week: 5, start: '2026-08-31', end: '2026-09-04', no_school: false, has_plan: false, is_current: false, is_past: false, plan_id: null, chat_id: null, unit: null },
    { week: 6, start: '2026-09-07', end: '2026-09-11', no_school: true, has_plan: false, is_current: false, is_past: false, plan_id: null, chat_id: null, unit: null },
    { week: 7, start: '2026-09-14', end: '2026-09-18', no_school: false, has_plan: false, is_current: false, is_past: false, plan_id: null, chat_id: null, unit: null },
    { week: 12, start: '2026-10-19', end: '2026-10-23', no_school: false, has_plan: true, is_current: false, is_past: false, plan_id: 'planOrphan', chat_id: null, unit: 'Satire' },
  ],
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
         window.__mock.state.entitlement = { may_generate: false, subscribed: false,
           status: null, plans_used: 4, tokens_used: 150000, token_cap: 150000,
           tokens_remaining: 0, usage_window_days: 7, billing_enabled: true } */
    if (path === '/api/auth/me')
      return json({
        id: 'u1',
        name: state.me.name,
        email: 'jc@x.org',
        is_admin: true,
        has_password: true,
        custom_instructions: state.me.custom_instructions,
        entitlement: state.entitlement,
      })
    if (path === '/api/auth/forgot-password') return json({ ok: true })
    if (path === '/api/auth/reset-password') return json({ id: 'u1', name: 'Josh Cole', email: 'jc@x.org', is_admin: true, has_password: true, entitlement: state.entitlement })
    if (path === '/api/auth/change-password') return json({ ok: true })
    if (path === '/api/admin/accounts') return json({ accounts: state.accounts })
    const compMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/comp$/)
    if (compMatch && method === 'POST') {
      const acct = state.accounts.find((a) => a.id === compMatch[1])
      if (acct) acct.subscription_status = body?.comped ? 'comped' : null
      return json({ account: acct || null })
    }
    if (path === '/api/billing/price')
      return json({
        price: { amount: 1000, currency: 'USD', interval: 'month', interval_count: 1 },
        free_weekly_token_cap: 150_000,
      })
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
      return json([...state.classes].sort((a, b) => a.sort_order - b.sort_order))
    if (path === '/api/weeks')
      return json({ class: null, weeks: state.weeks, current_week: 3 })
    if (
      path === '/api/curriculum_progress' &&
      new URL(url, location.origin).searchParams.get('subject') !== 'AP Lang'
    )
      return json({ map: null, weeks: [], summary: null })
    if (path === '/api/curriculum_progress') {
      // A pacing guide on file for AP Lang (c1) — two weeks not yet planned,
      // so Greeting's second and third suggestions should pull from here
      // instead of the generic fallback pair.
      const weeks = [
        { week_label: 'Week 03', unit: 'Voice, Tone & Rhetorical Devices', target_start: '2026-08-17',
          target_end: '2026-08-21', standards: ['RHS-2A'], notes: '', has_plan: true, status: 'done' },
        { week_label: 'Week 04', unit: 'Voice, Tone & Rhetorical Devices', target_start: '2026-08-24',
          target_end: '2026-08-28', standards: ['RHS-2B'], notes: "The Cask of Amontillado — irony",
          has_plan: false, status: 'current' },
        { week_label: 'Week 05', unit: 'Power of Language', target_start: '2026-08-31',
          target_end: '2026-09-04', standards: [], notes: 'Begin Gatsby, ch. 1-3',
          has_plan: false, status: 'upcoming' },
      ]
      return json({
        map: { id: 'map1', original_name: 'AP Lang pacing guide.pdf', uploaded_at: '2026-08-01T00:00:00+00:00' },
        weeks,
        summary: { total: weeks.length, done: 1, behind: 0, current_week_label: 'Week 04', on_pace: true },
      })
    }
    if (path === '/api/frameworks')
      // `chunks` and `verbatim_ok` are not optional — FrameworkPicker calls
      // .toLocaleString() on chunks directly. Keyed by `id` (findFramework's
      // own lookup field, lib/frameworks.js) — matching /api/routes/misc.py's
      // real shape, not the `subject` name a class row carries.
      return json([
        { id: 'AP_Lang', label: 'AP English Language and Composition (2019)', chunks: 59, verbatim_ok: 59 },
        { id: 'ELA', label: 'Alabama Course of Study: ELA (2021)', chunks: 1240, verbatim_ok: 1180 },
      ])
    if (path === '/api/classes' && method === 'POST') {
      await wait(200)
      const id = uid('class')
      // Mirrors _auto_name: int(grade) is what turns a bad grade into NaN-th.
      const n = Number(body.grade)
      const name = `${body.subject} · ${Number.isFinite(n) ? `${n}th` : `${body.grade}th`}`
      const sort_order = Math.max(-1, ...state.classes.map((c) => c.sort_order)) + 1
      const created = { id, name, subject: body.subject, grade: body.grade, sort_order }
      state.classes.push(created)
      return json(created)
    }
    const classPatch = path.match(/^\/api\/classes\/([^/]+)$/)
    if (classPatch && method === 'PATCH') {
      await wait(150)
      const cls = state.classes.find((c) => c.id === classPatch[1])
      if (!cls) {
        return new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'That class doesn’t exist.' } }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        )
      }
      Object.assign(cls, body)
      return json(cls)
    }
    if (classPatch && method === 'DELETE') {
      await wait(150)
      state.classes = state.classes.filter((c) => c.id !== classPatch[1])
      return new Response(null, { status: 204 })
    }
    if (path === '/api/me' && method === 'PATCH') {
      await wait(120)
      if (body?.name != null) state.me.name = body.name
      if (body?.custom_instructions != null) state.me.custom_instructions = body.custom_instructions
      return json({ id: 'u1', email: 'jc@x.org', name: state.me.name, custom_instructions: state.me.custom_instructions })
    }

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
      // Vague, on purpose: enough words to want a plan at all, but nothing
      // naming what the week is actually about — no text/topic, no skill, no
      // chapter/unit number. Real routing is the model's own judgment call
      // (backend/llm.py's system prompt); this is just enough of a stand-in
      // to drive the ask_clarifying_questions branch in the mock harness.
      const isVague = wantsPlan && last.trim().split(/\s+/).length <= 8 && !/\d|ch\.|chapter/i.test(last)
      return sse(
        isVague
          ? [
              [{ tool_call: 'ask_clarifying_questions', questions: [
                { id: 'text', text: 'What are you teaching this week?', options: ['A text we’re reading', 'A skill, no text yet', 'Test/exam prep'] },
                { id: 'skill', text: 'What should the week build toward?', options: ['Rhetorical analysis', 'Argument & evidence', 'Close reading', 'Writing craft'] },
                { id: 'length', text: 'How many teaching days do you have?', options: ['5', '4', '3'] },
              ] }, 300],
              [{ done: true }, 60],
            ]
          : wantsPlan
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

    if (path.startsWith('/api/standards/') && path !== '/api/standards/stats') {
      const code = decodeURIComponent(path.slice('/api/standards/'.length)).replace(/\s+/g, ' ').trim().toUpperCase()
      const record = STANDARDS[code]
      // 4.C falls here — same as the real backend does for a code retrieval
      // never supplied, and the one path Citation.jsx's "Not in the standards
      // corpus" copy exists for but nothing was ever exercising.
      return record ? json(record) : new Response('{}', { status: 404 })
    }

    return json({})
  }

  // Handle for the test driver.
  window.__mock = { state, latency, calls, reset: () => calls.splice(0) }
}
