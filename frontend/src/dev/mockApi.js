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
  chats: [{ id: 'seed1', title: 'Week 03 — voice and tone', updated_at: '2026-08-07' }],
  messages: {
    seed1: [
      { role: 'user', content: 'Plan Week 03 — voice and tone with "The Cask of Amontillado."' },
      {
        role: 'assistant',
        content: 'Four teaching days — Friday is a pep rally, so the exit assessment moved to Thursday.',
        plan_id: 'plan1',
      },
    ],
  },
  plans: { plan1: makePlan('Week 03 — Aug 17-21, 2026') },
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
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method, at: performance.now() })

    if (path === '/api/auth/me') return json({ id: 'u1', name: 'Josh Cole', email: 'jc@x.org' })
    if (path === '/api/classes')
      return json([{ id: 'c1', name: 'AP Language & Composition', subject: 'AP Lang', grade: '11' }])
    if (path === '/api/classes/c1/documents')
      return json([{ id: 'd1', original_name: 'AP Lang pacing guide.pdf', kind: 'pacing_guide' }])

    /* ── chats ───────────────────────────────────────────────────────────── */
    if (path === '/api/chats' && method === 'GET') {
      await wait(latency.listChats)
      return json(state.chats)
    }
    if (path === '/api/chats' && method === 'POST') {
      await wait(latency.createChat)
      const id = uid('chat')
      state.chats.unshift({ id, title: body.title, updated_at: 'now' })
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
