/* A canned backend, for looking at the UI without one.
 *
 * TEMPORARY — used to verify the artifact-rail redesign against the real
 * components. Delete this file and preview.html when done. Nothing in src/
 * imports it except preview.jsx.
 */

const PLAN = {
  week_of: 'Week 03 — Aug 17-21, 2026',
  teacher: 'Josh Cole',
  course: 'AP Language & Composition',
  period: '3rd period',
  days: [
    {
      name: 'Monday',
      no_school: false,
      title: 'Ethos & audience',
      learning_targets: "I can identify how a writer's ethos shapes an audience's trust.",
      standards: 'ELA21.11.R2 -- Analyze how an author develops a point of view',
      act_alignment: 'TOD 502',
      engagement_strategy: ['Think/Pair/Share'],
      do_now: 'Rank four openings by how much you trust the speaker.',
      during:
        'Explicit instruction on ethos, then A/B partners annotate the first two paragraphs of the Poe passage for markers of credibility.',
      assessment: 'Exit ticket: one marker, quoted, with a sentence on its effect.',
    },
    {
      name: 'Tuesday',
      no_school: false,
      title: 'Diction & syntax',
      learning_targets: 'I can explain how word choice and syntax convey tone.',
      standards: 'ELA21.11.R3 -- Evaluate an author’s use of language',
      act_alignment: 'ORG 403',
      engagement_strategy: ['Gallery Walk', 'Small Groups'],
      do_now: 'Three sentences, same content, different syntax. Which is coldest?',
      during: 'Gallery walk of six passages; groups label diction and syntax moves.',
      assessment: 'Group placard defended in one minute.',
    },
    {
      name: 'Wednesday',
      no_school: false,
      title: 'Irony workshop',
      learning_targets: 'I can trace dramatic irony across a narrative.',
      standards: '4.C -- Trace an ironic structure, ELA21.11.R2',
      act_alignment: 'TOD 502',
      engagement_strategy: ['Small Groups'],
      do_now: 'What does Fortunato think is happening?',
      during:
        'Jigsaw the middle section; each group tracks one ironic reversal and reports the moment the reader knows more than the character.',
      assessment: 'Annotated reversal chart.',
    },
    {
      name: 'Thursday',
      no_school: false,
      title: 'Socratic seminar',
      learning_targets: 'I can defend a reading in discussion, citing evidence.',
      standards: 'ELA21.11.R4 -- Participate in collaborative discussion',
      act_alignment: 'ORG 403',
      engagement_strategy: ['Write 1st, Talk 2nd'],
      do_now: 'Write the claim you will defend in one sentence.',
      during: 'Socratic seminar — inner circle 20 min, outer circle tracks moves, then swap.',
      assessment: 'Seminar tracker plus a reflection paragraph.',
    },
    { name: 'Friday', no_school: true, title: 'Pep rally' },
  ],
}

const RETRIEVED = ['ELA21.11.R2', 'ELA21.11.R3', 'ELA21.11.R4', 'TOD 502', 'ORG 403']

const WARNINGS = [
  'Wednesday cites 4.C, which retrieval never supplied — swap in a grounded code.',
]

let plan = structuredClone(PLAN)

const json = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

const planRow = () => ({
  id: 'plan_1',
  plan_json: plan,
  warnings: WARNINGS,
  retrieved_ids: RETRIEVED,
  unit: 'Unit 2 · weeks 3–6',
  week_label: plan.week_of,
})

export function installMockApi() {
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const body = init.body ? JSON.parse(init.body) : null

    if (path === '/api/auth/me') return json({ id: 'u1', name: 'Josh Cole', email: 'jc@x.org' })
    if (path === '/api/classes')
      return json([{ id: 'c1', name: 'AP Language & Composition', subject: 'AP Language & Composition', grade: '11' }])
    if (path === '/api/chats') return json([{ id: 'chat1', title: 'Week 03 — voice and tone' }])
    if (path === '/api/chats/chat1')
      return json({
        id: 'chat1',
        messages: [
          {
            role: 'user',
            content:
              'Plan Week 03 — Aug 18–22. Voice and tone with "The Cask of Amontillado." Friday is a pep rally schedule.',
          },
          {
            role: 'assistant',
            content:
              'Four teaching days — Friday is a 30-minute pep rally schedule, so I moved the exit assessment to Thursday rather than squeezing it into half a period.',
            plan_id: 'plan_1',
          },
        ],
      })
    if (path === '/api/plans/plan_1') return json(planRow())
    if (path === '/api/classes/c1/documents')
      return json([
        { id: 'd1', original_name: 'AP Lang pacing guide.pdf', kind: 'pacing_guide' },
        { id: 'd2', original_name: 'Florence calendar 26-27.pdf', kind: 'calendar' },
      ])

    if (path === '/api/revise_day') {
      // Mirrors the real merge-one-key contract: one field changes, the rest
      // come through untouched.
      const day = plan.days[body.day_index]
      const next = body.field
        ? { ...day, [body.field]: `${body.feedback} — rewritten.` }
        : { ...day, do_now: `${body.feedback} — whole day rewritten.` }
      plan = { ...plan, days: plan.days.map((d, i) => (i === body.day_index ? next : d)) }
      await new Promise((r) => setTimeout(r, 400))
      return json(planRow())
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
}
