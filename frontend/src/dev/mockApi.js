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

/* GET /api/standards' list view — routes/standards.py's _slim(), which is a
   strictly narrower record than the per-code lookup STANDARDS above returns.
   Two strands, because StandardsPage derives its filter chips from whatever
   distinct `strand` values come back and a single-strand corpus leaves the
   "All / <strand>" switcher with nothing to switch between. */
const STANDARDS_LIST = [
  { code: 'ELA21.11.R2', description: 'Analyze how an author develops and refines a point of view.', source_type: 'state', strand: 'Reading', domain: 'Literature', reporting_category: 'Craft & Structure', source_document: 'Alabama Course of Study: ELA (2021)', source_page_or_section: 'Grade 11, R2' },
  { code: 'RHS-2', description: 'Make strategic use of digital media in presentations.', source_type: 'state', strand: 'Reading', domain: 'Informational', reporting_category: 'Integration', source_document: 'Alabama Course of Study: ELA (2021)', source_page_or_section: 'Grade 11, RHS-2' },
  { code: 'CLE-4', description: 'Analyze and select evidence to develop a claim.', source_type: 'state', strand: 'Writing', domain: 'Argument', reporting_category: 'Evidence', source_document: 'Alabama Course of Study: ELA (2021)', source_page_or_section: 'Grade 11, CLE-4' },
  { code: 'R.TST.701', description: 'Cite strong and thorough textual evidence to support analysis.', source_type: 'act', strand: 'Reading', domain: 'Close Reading', reporting_category: 'Textual Evidence', source_document: 'ACT College & Career Readiness Standards', source_page_or_section: 'Reading, 701' },
  { code: 'ORG 403', description: 'Use transitions to clarify the relationships between ideas.', source_type: 'act', strand: 'Writing', domain: 'Organization', reporting_category: 'Transitions', source_document: 'ACT College & Career Readiness Standards', source_page_or_section: 'English, 403' },
]

/* ── in-memory state ─────────────────────────────────────────────────────── */
let seq = 0
const uid = (p) => `${p}_${++seq}`

const state = {
  // onboarding_seen_at set (unlike a brand-new account) so preview.html lands
  // on the real app shell — App.jsx's ClassRoutes redirects to the onboarding
  // wizard for as long as this is unset, and nothing in this mock ever set it.
  me: { name: 'Josh Cole', custom_instructions: '', avatar: null, school: 'florence-high-school', onboarding_seen_at: '2026-01-01T00:00:00+00:00' },
  // Default: billing live, weekly usage cap already hit — i.e. the paywall
  // state, because that is the one worth being able to look at. Flip
  // may_generate back to true (or billing_enabled to false) to leave it.
  // ?trial=expired instead shows the OTHER paywall trigger — a still-free
  // trial account past entitlement.py's TRIAL_ENFORCEMENT_START cutoff,
  // where there's no cap left to reset (token_cap: null) and trial_expired
  // is what actually gates. ?trial=3 shows the pre-expiry countdown in
  // AccountMenu's UsageMeter instead (still under the weekly cap, N days
  // left). Shape matches entitlement.Entitlement.as_dict() (backend/entitlement.py).
  entitlement: (() => {
    const trialParam = new URLSearchParams(window.location.search).get('trial')
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mock.subscribed')) {
      return {
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
        trial_expired: false,
        trial_days_remaining: null,
      }
    }
    if (trialParam === 'expired') {
      return {
        may_generate: false,
        subscribed: false,
        status: null,
        plans_used: 4,
        tokens_used: 0,
        token_cap: null,
        tokens_remaining: null,
        usage_window_days: 7,
        billing_enabled: true,
        period_end: null,
        burst_limited: false,
        unlimited: false,
        trial_expired: true,
        trial_days_remaining: null,
      }
    }
    if (trialParam) {
      const days = Math.max(0, parseInt(trialParam, 10) || 0)
      return {
        may_generate: true,
        subscribed: false,
        status: null,
        plans_used: 2,
        tokens_used: 4_000,
        token_cap: 20_000,
        tokens_remaining: 16_000,
        usage_window_days: 7,
        billing_enabled: true,
        period_end: null,
        trial_expired: false,
        trial_days_remaining: days,
      }
    }
    return {
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
      trial_expired: false,
      trial_days_remaining: null,
    }
  })(),
  // school on each mirrors backend db.py migration 25 — c2 is deliberately
  // pinned to the calendar-LESS school (springfield-ms) while the account
  // default stays Florence, so switching the active class between the two
  // is what actually exercises "a class can follow a different calendar
  // than the account default," not just two classes that happen to agree.
  classes: [
    { id: 'c1', name: 'AP Language & Composition', subject: 'AP_Lang', grade: '11', sort_order: 0, school: 'florence-high-school' },
    { id: 'c2', name: 'AP Physics 1', subject: 'Science', grade: '11', sort_order: 1, school: 'springfield-ms' },
  ],
  // Two, not one, so the onboarding/admin picker under test actually has a
  // real choice to render — the real backend starts with one (Florence);
  // a second here is what exercises the picker as a picker.
  // has_calendar mirrors whether backend/context/calendars/<id>.md exists.
  // Springfield is deliberately calendar-less: a school row can be added by
  // admin before anyone authors its year, and that state has to be visible
  // rather than silently emptying the week board.
  schools: [
    { id: 'florence-high-school', name: 'Florence High School', created_at: '2026-01-01T00:00:00+00:00', has_calendar: true },
    { id: 'springfield-ms', name: 'Springfield Middle School', created_at: '2026-01-02T00:00:00+00:00', has_calendar: false },
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
    { id: 'seed1', title: 'Week 03 — voice and tone', class_id: 'c1', updated_at: '2026-08-07', week_number: 3 },
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
  // quizzes[planId] is an array — a plan can have several (db.py migration
  // 26). plan1 seeds with one already built, so ArtifactRail's quiz list has
  // something to render without needing to drive the chat_stream tool-call
  // path first every time.
  quizzes: {
    plan1: [
      {
        id: 'quiz1',
        title: 'Week 03 Quiz — Voice & Tone',
        question_types: ['multiple_choice', 'true_false', 'short_answer', 'matching'],
        has_qti: true,
        warnings: [],
        // Real shape (schema.QUESTION_JSON_SCHEMA) — quiz_json is what
        // ArtifactDetailPanel's quiz view actually renders, and list_quizzes
        // returns it hydrated on every row, not just get_quiz by id.
        quiz_json: {
          title: 'Week 03 Quiz — Voice & Tone',
          questions: [
            {
              type: 'multiple_choice',
              prompt: "Which term describes the narrator's own attitude toward the events of the story?",
              standard_code: 'RHS-2A',
              choices: ['Tone', 'Diction', 'Syntax', 'Ethos'],
              correct_index: 0,
              correct_bool: false,
              accepted_answers: [],
              pairs: [],
            },
            {
              type: 'true_false',
              prompt: 'Diction and syntax are two of the tools a writer uses to establish tone.',
              standard_code: 'RHS-2A',
              choices: [],
              correct_index: -1,
              correct_bool: true,
              accepted_answers: [],
              pairs: [],
            },
            {
              type: 'short_answer',
              prompt: 'Name one connotative word choice from Monday’s reading and the tone it creates.',
              standard_code: '',
              choices: [],
              correct_index: -1,
              correct_bool: false,
              accepted_answers: ['(open response)'],
              pairs: [],
            },
            {
              type: 'matching',
              prompt: 'Match each rhetorical term to its definition.',
              standard_code: 'RHS-1',
              choices: [],
              correct_index: -1,
              correct_bool: false,
              accepted_answers: [],
              pairs: [
                { term: 'Ethos', match: 'An appeal to credibility' },
                { term: 'Pathos', match: 'An appeal to emotion' },
                { term: 'Logos', match: 'An appeal to logic' },
              ],
            },
          ],
        },
      },
    ],
  },
  // "Share via Google" (backend/routes/drive.py + plans.py's /share). Mirrors
  // the entitlement toggle above: sessionStorage flips it for a dev session,
  // since the real flow needs an actual Google OAuth round trip this harness
  // can't perform. enabled: true always — the mock is what exercises the
  // "disconnected" and "connected" UI, not the config-gate itself, which has
  // no mock-worthy state of its own (it's just a bool read from settings).
  drive: {
    connected: typeof sessionStorage !== 'undefined' && sessionStorage.getItem('mock.driveConnected') === 'true',
  },
  // planId -> [{email, role, created_at}], plus the Doc link once "created".
  // Seeded empty; a share POST below fills it in, same shape
  // db.list_plan_shares/plans.drive_web_link return for real.
  planShares: {},
  planDriveFiles: {},
  // planId -> published? Seeded empty: a plan is private until the "share
  // publicly" consent step runs, and /api/plans/public/:id 404s until then.
  publicPlans: {},
  // Flat array, filtered by class_id — see docList below. Seeded with one
  // document for c1 so the rail's "Built from" group has a row to open;
  // ArtifactDetailPanel's document view had no mock coverage before this,
  // since nothing had ever put a document here at load time.
  documents: [
    {
      id: 'doc1',
      class_id: 'c1',
      kind: 'pacing_guide',
      original_name: 'AP Lang pacing guide.pdf',
      chars: 18420,
      uploaded_at: '2026-08-01T00:00:00+00:00',
    },
  ],
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

  /* ── admin ───────────────────────────────────────────────────────────────
     Every list below is seeded NON-EMPTY on purpose. AdminPage's review
     sections each open with `if (isLoading || isError || !rows.length) return
     null` — an empty list doesn't render an empty state, it renders nothing at
     all, and the Approve / Reject / Retry / Mark Active / Attempts buttons
     don't exist in the DOM to be clicked. Seeded empty, scripts/test-buttons
     .mjs would report full coverage of a page that was mostly absent.

     Mutable, and the handlers really do splice: approving a submission has to
     remove the row, the same way every other mutation in this file applies. */
  calendarSubmissions: [
    {
      id: 'calsub1',
      school_id: 'springfield-middle-school',
      submitted_at: '2026-08-20T14:00:00+00:00',
      source_kind: 'pdf',
      source_name: 'SMS 2026-27 calendar.pdf',
      status: 'pending',
      weeks: [
        { week: 1, start: '2026-08-03', end: '2026-08-07' },
        { week: 2, start: '2026-08-10', end: '2026-08-14' },
      ],
    },
  ],
  // analysis_status covers two of TEMPLATE_STATUS_STYLE's five branches —
  // the clean one and the warnings one — so the badge has something other
  // than a single look under test.
  pendingTemplates: [
    {
      id: 'tpl1',
      school_id: 'springfield-middle-school',
      school_name: 'Springfield Middle School',
      analysis_status: 'analyzed_with_warnings',
      uploader_name: 'Dana Reyes',
      uploader_email: 'dreyes@springfield.k12',
      uploaded_by: 'u9',
      created_at: '2026-08-18T09:00:00+00:00',
    },
  ],
  autoActivatedTemplates: [
    {
      id: 'tpl2',
      school_id: 'northside-high-school',
      school_name: 'Northside High School',
      analysis_status: 'analyzed',
      uploader_name: 'Pat Ellis',
      uploader_email: 'pellis@northside.k12',
      uploaded_by: 'u10',
      created_at: '2026-08-10T09:00:00+00:00',
      analyzed_at: '2026-08-10T09:04:00+00:00',
    },
  ],
  // Two jobs, deliberately: 'succeeded' is the only status that renders the
  // Approve button (`canApprove`), and 'failed_needs_human' is the one that
  // renders error_message. One job alone would leave one of the two unreached.
  builderJobs: [
    {
      id: 'job1',
      school_id: 'springfield-middle-school',
      school_name: 'Springfield Middle School',
      status: 'succeeded',
      attempt_count: 2,
      created_at: '2026-08-19T11:00:00+00:00',
      error_message: null,
    },
    {
      id: 'job2',
      school_id: 'eastview-high-school',
      school_name: 'Eastview High School',
      status: 'failed_needs_human',
      attempt_count: 3,
      created_at: '2026-08-17T11:00:00+00:00',
      error_message: 'Ran out of attempts — the header row never rendered on one page.',
    },
  ],
  autoVerifiedJobs: [
    {
      id: 'job3',
      school_id: 'northside-high-school',
      school_name: 'Northside High School',
      status: 'succeeded',
      attempt_count: 1,
      created_at: '2026-08-11T11:00:00+00:00',
      finished_at: '2026-08-11T11:06:00+00:00',
      verified_at: '2026-08-11T11:06:00+00:00',
      uploader_name: 'Pat Ellis',
      uploader_email: 'pellis@northside.k12',
      error_message: null,
    },
  ],
  // db.get_app_settings()'s shape. Mutated by PUT /api/admin/settings, which
  // is what makes the Settings tab's Save round-trip real rather than a toast.
  appSettings: {
    free_weekly_token_cap: 150_000,
    subscriber_weekly_token_cap: 2_000_000,
    updated_at: '2026-08-01T00:00:00+00:00',
    updated_by: 'jc@x.org',
  },
  // One entry per branch of describeAuditEntry — including `settings_update`,
  // whose renderer reaches into detail.before/after and calls
  // .toLocaleString() on both caps. A row missing that nesting throws inside
  // render, which is a crash screen, not a failed fetch.
  auditLog: [
    {
      id: 'audit1',
      action: 'settings_update',
      actor_email: 'jc@x.org',
      target: null,
      created_at: '2026-08-21T15:00:00+00:00',
      detail: {
        before: { free_weekly_token_cap: 120_000, subscriber_weekly_token_cap: 1_800_000 },
        after: { free_weekly_token_cap: 150_000, subscriber_weekly_token_cap: 2_000_000 },
      },
    },
    { id: 'audit2', action: 'comp_grant', actor_email: 'jc@x.org', target: 'kim@x.org', created_at: '2026-08-20T15:00:00+00:00', detail: {} },
    { id: 'audit3', action: 'school_add', actor_email: 'jc@x.org', target: 'northside-high-school', created_at: '2026-08-19T15:00:00+00:00', detail: { name: 'Northside High School' } },
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
/* Requests that matched no route. Read by scripts/test-buttons.mjs, which fails
   the run if a click lands here — see the fallthrough at the end of `route`. */
const unhandled = []
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

  /* Routing lives in its own function, with a thin recording wrapper around it
     below. Inline, the only way to know what a route returned was to touch all
     forty-odd `return` statements — and the button suite's central question is
     "what did this click actually get back," so the status has to be recorded
     in one place or not at all. */
  const route = async (path, method, body, init, url) => {
    /* The entitlement rides on /me exactly as it does in production, so the
       paywall can be driven here. Tune it live:
         window.__mock.state.entitlement = { may_generate: false, subscribed: false,
           status: null, plans_used: 4, tokens_used: 150000, token_cap: 150000,
           tokens_remaining: 0, usage_window_days: 7, billing_enabled: true } */
    /* One shape, one place. /auth/me and PUT /auth/avatar both return the full
       public user (routes/auth.py), and SettingsPage's avatar mutation writes
       whatever the PUT returns straight into the qk.me cache with no refetch —
       so an avatar response that omitted a field would blank the account
       everywhere it is read, not just on the avatar picker. */
    const publicUser = () => ({
      id: 'u1',
      name: state.me.name,
      email: 'jc@x.org',
      is_admin: true,
      has_password: true,
      custom_instructions: state.me.custom_instructions,
      school: state.me.school,
      avatar: state.me.avatar,
      onboarding_seen_at: state.me.onboarding_seen_at,
      entitlement: state.entitlement,
    })
    if (path === '/api/auth/me') return json(publicUser())
    if (path === '/api/health')
      // routes/misc.py returns the diagnostic body only to a signed-in
      // caller; this harness is always signed in, so that is the shape here.
      return json({
        ok: true,
        model: 'gpt-5',
        api_key_set: true,
        database: 'PostgreSQL',
        plans_dir: '/data/plans',
        retrieval_floor: 0.55,
        retrieval_top_k: 12,
        require_login: true,
        cookie_secure_forced: false,
        database_url_len: 110,
        builder_found: true,
      })
    if (path === '/api/auth/forgot-password') return json({ ok: true })
    if (path === '/api/auth/logout' && method === 'POST') return json({ ok: true })
    if (path === '/api/auth/sign_out_everywhere' && method === 'POST') return json({ ok: true })
    if (path === '/api/auth/delete_account' && method === 'POST') return json({ ok: true })
    if (path === '/api/auth/onboarding-seen' && method === 'POST') {
      state.me.onboarding_seen_at = new Date().toISOString()
      return json({ ok: true })
    }
    if (path === '/api/auth/avatar') {
      state.me.avatar = body?.avatar ?? null
      return json(publicUser())
    }
    if (path === '/api/auth/reset-password') return json({ id: 'u1', name: 'Josh Cole', email: 'jc@x.org', is_admin: true, has_password: true, entitlement: state.entitlement })
    if (path === '/api/auth/change-password') return json({ ok: true })
    if (path === '/api/admin/accounts') return json({ accounts: state.accounts })
    const compMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/comp$/)
    if (compMatch && method === 'POST') {
      const acct = state.accounts.find((a) => a.id === compMatch[1])
      if (acct) acct.subscription_status = body?.comped ? 'comped' : null
      return json({ account: acct || null })
    }
    const capMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/cap$/)
    if (capMatch && method === 'POST') {
      const acct = state.accounts.find((a) => a.id === capMatch[1])
      if (acct) acct.custom_weekly_token_cap = body?.cap ?? null
      return json({ account: acct || null })
    }
    const extendBetaMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/extend-beta$/)
    if (extendBetaMatch && method === 'POST') {
      const acct = state.accounts.find((a) => a.id === extendBetaMatch[1])
      return json({ account: acct || null })
    }
    const endBetaMatch = path.match(/^\/api\/admin\/accounts\/([^/]+)\/end-beta$/)
    if (endBetaMatch && method === 'POST') {
      const acct = state.accounts.find((a) => a.id === endBetaMatch[1])
      return json({ account: acct || null })
    }
    if (path === '/api/admin/beta-accounts' && method === 'POST') {
      await wait(200)
      // The generated password is the whole point of the response — it is
      // shown once and never again, so returning it is what makes the
      // "copy this password" panel reachable.
      return json({ email: body?.email, name: body?.name, password: 'copper-lantern-4417', days: body?.days ?? 30 })
    }
    if (path === '/api/admin/usage-trend')
      return json({
        weeks: [
          { week_start: '2026-07-06', tokens: 210_000 },
          { week_start: '2026-07-13', tokens: 340_000 },
          { week_start: '2026-07-20', tokens: 180_000 },
          { week_start: '2026-07-27', tokens: 520_000 },
          { week_start: '2026-08-03', tokens: 610_000 },
          { week_start: '2026-08-10', tokens: 455_000 },
          { week_start: '2026-08-17', tokens: 700_000 },
        ],
      })
    if (path === '/api/admin/qa/standards-check')
      // One flagged plan, exercising BOTH of the section's conditional lines
      // (hallucinated and mismatched). Empty would render the green "no
      // issues" branch instead, which is the branch that needs no fixture.
      return json({
        flagged: [
          {
            plan_id: 'plan1',
            week_label: 'Week 03 — Aug 17-21, 2026',
            email: 'jc@x.org',
            subject: 'AP Lang',
            grade: 11,
            hallucinated: ['4.C'],
            mismatched: ['ELA21.9.R2'],
          },
        ],
      })
    if (path === '/api/admin/calendar-submissions' && method === 'GET')
      return json({ submissions: state.calendarSubmissions })
    const calDecide = path.match(/^\/api\/admin\/calendar-submissions\/([^/]+)\/(approve|reject)$/)
    if (calDecide && method === 'POST') {
      await wait(200)
      const i = state.calendarSubmissions.findIndex((s) => s.id === calDecide[1])
      const [row] = i >= 0 ? state.calendarSubmissions.splice(i, 1) : [null]
      return json({ ...(row || {}), status: calDecide[2] === 'approve' ? 'confirmed' : 'rejected' })
    }
    if (path === '/api/admin/school-templates/pending' && method === 'GET')
      return json({ templates: state.pendingTemplates })
    if (path === '/api/admin/school-templates/auto-activated' && method === 'GET')
      return json({ templates: state.autoActivatedTemplates })
    const tplAnalysis = path.match(/^\/api\/admin\/school-templates\/([^/]+)\/analysis$/)
    if (tplAnalysis && method === 'GET') {
      await wait(150)
      return json({
        findings: [
          { severity: 'warning', check_name: 'header_row', message: 'The header row spans two cells on page 2.' },
          { severity: 'info', check_name: 'font', message: 'Body font resolved to Calibri 11.' },
        ],
        analysis: {
          sections: [
            { name: 'Standards', description: 'Cited codes, one per line.', source_evidence: 'ALCOS / ACT' },
            { name: 'Do Now', description: 'Opening bell-ringer.', source_evidence: 'Do Now:' },
          ],
          overall_confidence: 0.82,
          recommended_for_auto_use: false,
        },
      })
    }
    const tplReanalyze = path.match(/^\/api\/admin\/school-templates\/([^/]+)\/reanalyze$/)
    if (tplReanalyze && method === 'POST') {
      await wait(400)
      return json({ id: tplReanalyze[1], analysis_status: 'analyzed' })
    }
    const activateTpl = path.match(/^\/api\/admin\/schools\/([^/]+)\/activate-template$/)
    if (activateTpl && method === 'POST') {
      await wait(200)
      const i = state.pendingTemplates.findIndex((t) => t.school_id === activateTpl[1])
      if (i >= 0) state.pendingTemplates.splice(i, 1)
      return json({ status: 'ok' })
    }
    if (path === '/api/admin/builder-codegen/pending' && method === 'GET')
      return json({ jobs: state.builderJobs })
    if (path === '/api/admin/builder-codegen/auto-verified' && method === 'GET')
      return json({ jobs: state.autoVerifiedJobs })
    const builderApprove = path.match(/^\/api\/admin\/builder-codegen\/([^/]+)\/approve$/)
    if (builderApprove && method === 'POST') {
      await wait(200)
      const i = state.builderJobs.findIndex((j) => j.id === builderApprove[1])
      const [job] = i >= 0 ? state.builderJobs.splice(i, 1) : [null]
      return json({ school: { id: job?.school_id || null, name: job?.school_name || null } })
    }
    const builderRetry = path.match(/^\/api\/admin\/builder-codegen\/([^/]+)\/retry$/)
    if (builderRetry && method === 'POST') {
      await wait(200)
      const job = state.builderJobs.find((j) => j.id === builderRetry[1])
      if (job) job.status = 'queued'
      return json({ status: 'queued' })
    }
    const builderJob = path.match(/^\/api\/admin\/builder-codegen\/([^/]+)$/)
    if (builderJob && method === 'GET') {
      await wait(150)
      // Two attempts: one with a render (the download link) and both judges,
      // one rejected before rendering (the "see the spec below" branch).
      return json({
        id: builderJob[1],
        attempts: [
          {
            id: 'att1',
            attempt_number: 1,
            passed: false,
            render_image_path: null,
            layout_spec: { rows: 5, columns: ['Day', 'Standards', 'Do Now'] },
            judge1: null,
            judge2: null,
          },
          {
            id: 'att2',
            attempt_number: 2,
            passed: true,
            render_image_path: '/tmp/att2.png',
            layout_spec: { rows: 5, columns: ['Day', 'Standards', 'Do Now', 'Assessment'] },
            judge1: { pass: true, confidence: 0.91, reasoning: 'Every field landed in its labelled cell.', visual_defects: [], per_field_checks: [{ field: 'do_now', correct_cell: true }] },
            judge2: { pass: true, confidence: 0.87, reasoning: 'Header repeats correctly on page 2.', visual_defects: [], per_field_checks: [{ field: 'standards', correct_cell: true }] },
          },
        ],
      })
    }
    if (path === '/api/admin/settings' && method === 'GET') return json(state.appSettings)
    if (path === '/api/admin/settings' && method === 'PUT') {
      await wait(200)
      state.appSettings = {
        ...state.appSettings,
        free_weekly_token_cap: Number(body?.free_weekly_token_cap ?? state.appSettings.free_weekly_token_cap),
        subscriber_weekly_token_cap: Number(body?.subscriber_weekly_token_cap ?? state.appSettings.subscriber_weekly_token_cap),
        updated_at: new Date().toISOString(),
      }
      return json(state.appSettings)
    }
    if (path === '/api/admin/audit-log' && method === 'GET') return json({ entries: state.auditLog })
    if (path === '/api/admin/entitled-statuses')
      return json({ statuses: ['active', 'comped', 'past_due', 'trialing'] })
    if (path === '/api/admin/billing')
      return json({
        billing_enabled: true,
        counts: { active: 12, trialing: 3, past_due: 1, comped: 2, canceled: 4, none: 31 },
        paying_accounts: 15,
        price: { amount: 1200, currency: 'USD', interval: 'month', interval_count: 1 },
        mrr_cents: 18_000,
        // Non-empty, so "Payment at risk" renders its list rather than its
        // empty state — the list is the half with per-row markup to get wrong.
        past_due_accounts: [{ id: 'u7', name: 'Kim Alvarez', email: 'kalvarez@x.org' }],
      })

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
    if (path === '/api/weeks') {
      // class_school, mirrored: the requested class's OWN school if it has
      // one (db.py migration 25), else the account default -- not the
      // account default unconditionally, which is what this used to read
      // before a class could pin its own.
      const classId = new URL(url, location.origin).searchParams.get('class_id')
      const cls = state.classes.find((c) => c.id === classId)
      const schoolId = (cls && cls.school) || state.me.school
      const school = state.schools.find((x) => x.id === schoolId) || state.schools[0]
      const info = { id: school.id, name: school.name, has_calendar: school.has_calendar }
      // Switching to a calendar-less school (in settings, or by switching to
      // a class pinned to one) really does empty the board here, so the
      // chat's own degraded state is reachable in the mock.
      if (!school.has_calendar) return json({ class: null, school: info, weeks: [], current_week: null })
      return json({ class: null, school: info, weeks: state.weeks, current_week: 3 })
    }
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
      // Stamped with the account's current default, same as db.create_class
      // — a fresh class starts with an honest answer, editable after.
      const created = { id, name, subject: body.subject, grade: body.grade, sort_order, school: state.me.school }
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
      if (body?.school != null) state.me.school = body.school
      return json({
        id: 'u1',
        email: 'jc@x.org',
        name: state.me.name,
        custom_instructions: state.me.custom_instructions,
        school: state.me.school,
      })
    }

    if (path === '/api/schools' && method === 'GET') return json(state.schools)

    if (path === '/api/admin/schools' && method === 'POST') {
      await wait(200)
      if (state.schools.some((s) => s.id === body.id)) {
        return new Response(
          JSON.stringify({ error: { code: 'already_exists', message: `A school with id '${body.id}' already exists.` } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      }
      const created = { id: body.id, name: body.name, created_at: '2026-01-01T00:00:00+00:00' }
      state.schools.push(created)
      return json(created)
    }

    const schoolDelete = path.match(/^\/api\/admin\/schools\/([^/]+)$/)
    if (schoolDelete && method === 'DELETE') {
      await wait(150)
      const id = decodeURIComponent(schoolDelete[1])
      // Same shape as the real backend's block-while-in-use check, so the
      // confirm-then-409 path under test in AdminPage is actually reachable.
      if (state.me.school === id) {
        return new Response(
          JSON.stringify({ error: { code: 'school_in_use', message: '1 account(s) still use this school.' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )
      }
      state.schools = state.schools.filter((s) => s.id !== id)
      return new Response(null, { status: 204 })
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
        state.documents.push({
          id,
          class_id: classId,
          kind,
          original_name: f?.name || 'upload.pdf',
          chars: 12345,
          uploaded_at: new Date().toISOString(),
        })
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
    const pinMatch = path.match(/^\/api\/chats\/([^/]+)\/pin$/)
    if (pinMatch && method === 'PATCH') {
      await wait(120)
      const chat = state.chats.find((c) => c.id === pinMatch[1])
      if (!chat) return new Response('{}', { status: 404 })
      chat.is_pinned = !!body?.is_pinned
      return json(chat)
    }
    if (path === '/api/chats/import' && method === 'POST') {
      await wait(300)
      return json({ imported: 0, skipped: 0 })
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
      // week_number is pinned at creation (backend db.py migration 24) and
      // read back off this list by ChatPage's conversationWeek — so the fake
      // has to persist it, not just echo it, or the composer's week dropdown
      // resets itself the moment the chat is created.
      state.chats.unshift({
        id,
        title: body.title,
        class_id: body.class_id ?? null,
        week_number: body.week_number ?? null,
        updated_at: 'now',
      })
      state.messages[id] = []
      return json({ id, title: body.title, week_number: body.week_number ?? null })
    }

    // PATCH /api/chats/:id/week — re-point an existing conversation.
    const weekMatch = path.match(/^\/api\/chats\/([^/]+)\/week$/)
    if (weekMatch && method === 'PATCH') {
      const chat = state.chats.find((c) => c.id === weekMatch[1])
      if (!chat) return new Response('{}', { status: 404 })
      chat.week_number = body.week_number
      return json({ ...chat })
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

    /* ── plans ─────────────────────────────────────────────────────────────
       /weeks BEFORE the {plan_id} matcher below, for exactly the reason
       routes/plans.py has the same note above its own registration: "weeks"
       matches [^/]+ perfectly well. It was landing in the plan lookup, finding
       no plan called "weeks", and 404ing — so PlansPage showed an empty
       library and its whole button set (select, share, download, delete) never
       rendered. */
    if (path === '/api/plans/weeks' && method === 'GET') {
      await wait(latency.getPlan)
      // db.list_plan_weeks: one entry per week, newest revision as `latest`,
      // the rest collapsed into `revisions`.
      const weeks = Object.entries(state.plans).map(([id, p], i) => ({
        week_number: i === 0 ? 3 : 12,
        week_label: p.week_of,
        unit: i === 0 ? 'Unit 2 · weeks 3–6' : 'Satire',
        latest: { id, week_label: p.week_of, unit: i === 0 ? 'Unit 2 · weeks 3–6' : 'Satire', course: p.course, created_at: '2026-08-17T12:00:00+00:00' },
        revisions: [],
      }))
      return json({ weeks })
    }

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

    const publicLink = path.match(/^\/api\/plans\/([^/]+)\/public_link$/)
    if (publicLink && method === 'POST') {
      await wait(200)
      // The consent step (backend migration 39): until a plan is published,
      // GET /api/plans/public/:id 404s.
      state.publicPlans[publicLink[1]] = !!body?.public
      return json({ id: publicLink[1], is_public: !!body?.public, shared_at: new Date().toISOString() })
    }
    const publicPlan = path.match(/^\/api\/plans\/public\/([^/]+)$/)
    if (publicPlan && method === 'GET') {
      await wait(latency.getPlan)
      const p = state.plans[publicPlan[1]]
      if (!p || !state.publicPlans[publicPlan[1]]) return new Response('{}', { status: 404 })
      return json({ id: publicPlan[1], plan_json: p, week_label: p.week_of, teacher: p.teacher, course: p.course })
    }
    const forkPlan = path.match(/^\/api\/plans\/([^/]+)\/fork$/)
    if (forkPlan && method === 'POST') {
      await wait(400)
      const id = uid('plan')
      state.plans[id] = { ...state.plans[forkPlan[1]] || Object.values(state.plans)[0] }
      return json({ id, week_label: state.plans[id].week_of })
    }
    const rebuildPlan = path.match(/^\/api\/plans\/([^/]+)\/rebuild$/)
    if (rebuildPlan && method === 'POST') {
      await wait(600)
      return json({ id: rebuildPlan[1], docx_path: `/plans/${rebuildPlan[1]}.docx` })
    }

    const quizListMatch = path.match(/^\/api\/plans\/([^/]+)\/quizzes$/)
    if (quizListMatch && method === 'GET') {
      await wait(150)
      return json(state.quizzes[quizListMatch[1]] || [])
    }

    const quizCreateMatch = path.match(/^\/api\/plans\/([^/]+)\/quiz$/)
    if (quizCreateMatch && method === 'POST') {
      // Slower than most mock writes on purpose — this is a real model call
      // (llm.generate_quiz) plus a local zip write in production, and the
      // "Building quiz…" row in ArtifactRail is the thing under test here,
      // not instant success.
      await wait(1200)
      const planId = quizCreateMatch[1]
      const types = body.question_types || ['multiple_choice']
      const quiz = {
        id: uid('quiz'),
        title: `${(state.plans[planId] || {}).week_of || 'Week'} Quiz`,
        question_types: types,
        has_qti: true,
        warnings: [],
      }
      state.quizzes[planId] = [quiz, ...(state.quizzes[planId] || [])]
      return json(quiz)
    }

    const quizDeleteMatch = path.match(/^\/api\/plans\/([^/]+)\/quizzes\/([^/]+)$/)
    if (quizDeleteMatch && method === 'DELETE') {
      await wait(150)
      const [, planId, quizId] = quizDeleteMatch
      state.quizzes[planId] = (state.quizzes[planId] || []).filter((q) => q.id !== quizId)
      return new Response(null, { status: 204 })
    }

    if (path === '/api/drive/status') {
      await wait(150)
      return json({ enabled: true, connected: state.drive.connected })
    }
    if (path === '/api/drive/disconnect' && method === 'POST') {
      state.drive.connected = false
      sessionStorage.removeItem('mock.driveConnected')
      return json({ ok: true })
    }

    if (path === '/api/canvas/export_quiz' && method === 'POST') {
      await wait(500)
      return json({ status: 'success', message: 'Quiz successfully synced to Canvas!' })
    }
    if (path === '/api/bell_ringer' && method === 'POST') {
      await wait(500)
      return json({
        prompt: 'Rank these three openings by how much you trust the speaker, and say why.',
        standard_code: 'ELA21.11.R2',
      })
    }
    if (path === '/api/documents/global' && method === 'GET') return json([])

    if (path === '/api/decisions' && method === 'POST') {
      await wait(250)
      // Three of the four CORE_CHECKLIST slots filled, plus one extra —
      // DecisionStack renders settled slots, unsettled slots and off-checklist
      // decisions differently, and all three branches need a fixture.
      return json({
        decisions: [
          { label: 'Week', value: 'Week 03 — Aug 17-21' },
          { label: 'Anchor text', value: '"The Cask of Amontillado"' },
          { label: 'Skill focus', value: 'Dramatic irony' },
          { label: 'Grouping', value: 'A/B partners' },
        ],
      })
    }

    if (path === '/api/suggestion' && method === 'POST') {
      await wait(300)
      return json({
        prompt: 'Want to swap Wednesday’s ungrounded 4.C for a code retrieval actually supplied?',
        reason: 'Wednesday cites a standard that is not in the corpus.',
      })
    }

    if (path === '/api/revise_days' && method === 'POST') {
      await wait(600)
      const p = state.plans[body.plan_id] || Object.values(state.plans)[0]
      for (const i of body.day_indices || []) {
        const d = p.days[i]
        if (d && body.field) p.days[i] = { ...d, [body.field]: `${body.feedback} — rewritten.` }
      }
      return json({ id: body.plan_id, plan_json: p, warnings: WARNINGS, retrieved_ids: RETRIEVED, week_label: p.week_of })
    }

    if (path === '/api/set_day_field' && method === 'POST') {
      // No latency: this is the direct-edit path, not a model call — see
      // service.set_day_field. A delay here would misrepresent it as one.
      const p = state.plans[body.plan_id] || Object.values(state.plans)[0]
      const d = p.days[body.day_index]
      if (d) p.days[body.day_index] = { ...d, [body.field]: body.value }
      return json({ id: body.plan_id, plan_json: p, warnings: WARNINGS, retrieved_ids: RETRIEVED, week_label: p.week_of })
    }

    if (path === '/api/voice/session' && method === 'POST') {
      await wait(200)
      // A token this harness cannot actually open a WebRTC session with —
      // the point is that the button's request path and its failure handling
      // are exercised, not that Realtime connects.
      return json({ token: 'mock-ephemeral-token', model: 'gpt-realtime', expires_at: Date.now() + 60_000 })
    }
    if (path === '/api/voice/usage' && method === 'POST') return json({ ok: true })
    if (path === '/api/transcribe' && method === 'POST') {
      await wait(400)
      return json({ text: 'Let’s build week three around dramatic irony.' })
    }

    const confirmedCal = path.match(/^\/api\/school-calendars\/confirmed\/([^/]+)$/)
    if (confirmedCal && method === 'GET') {
      await wait(150)
      const school = state.schools.find((s) => s.id === confirmedCal[1])
      // A school with no calendar 404s, exactly as routes/school_calendars.py
      // does — that is what the settings panel's "no calendar yet" state reads.
      if (!school || !school.has_calendar) return new Response('{}', { status: 404 })
      return json({ weeks: state.weeks.map((w) => ({ week: w.week, start: w.start, end: w.end, no_school: w.no_school })) })
    }
    const pendingCal = path.match(/^\/api\/school-calendars\/pending$/)
    if (pendingCal && method === 'GET') return json({ submissions: [] })
    const calDecideUser = path.match(/^\/api\/school-calendars\/([^/]+)\/(confirm|reject)$/)
    if (calDecideUser && method === 'POST') {
      await wait(200)
      return json({ id: calDecideUser[1], status: calDecideUser[2] === 'confirm' ? 'confirmed' : 'rejected' })
    }

    const shareListMatch = path.match(/^\/api\/plans\/([^/]+)\/shares$/)
    if (shareListMatch && method === 'GET') {
      await wait(150)
      const planId = shareListMatch[1]
      return json({ web_link: state.planDriveFiles[planId] || null, shares: state.planShares[planId] || [] })
    }

    const shareCreateMatch = path.match(/^\/api\/plans\/([^/]+)\/share$/)
    if (shareCreateMatch && method === 'POST') {
      // Slower than a plain write, same reasoning as quiz creation above —
      // the first share on a plan is a real upload-and-convert in
      // production, not instant.
      await wait(800)
      const planId = shareCreateMatch[1]
      if (!state.planDriveFiles[planId]) {
        state.planDriveFiles[planId] = `https://docs.google.com/document/d/mock-${planId}/edit`
      }
      const share = { email: body.email, role: body.role || 'reader', created_at: new Date().toISOString() }
      state.planShares[planId] = [share, ...(state.planShares[planId] || [])]
      return json({ web_link: state.planDriveFiles[planId], shares: state.planShares[planId] })
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
      const wantsQuiz = /\bquiz\b/i.test(last)
      // Mirrors backend/llm.py's real rule: generate_quiz only fires once the
      // teacher's own message already names a type AND a count — otherwise
      // ask_clarifying_questions asks the two things missing.
      const quizTypeNamed = /\b(multiple.choice|true.false|short.answer|matching|a mix)\b/i.test(last)
      const quizCountNamed = /\b\d+\b/.test(last)
      const quizNeedsClarify = wantsQuiz && !(quizTypeNamed && quizCountNamed)
      const wantsPlan = /\b(plan|week|build|unit|lesson)\b/i.test(last)
      // Vague, on purpose: enough words to want a plan at all, but nothing
      // naming what the week is actually about — no text/topic, no skill, no
      // chapter/unit number. Real routing is the model's own judgment call
      // (backend/llm.py's system prompt); this is just enough of a stand-in
      // to drive the ask_clarifying_questions branch in the mock harness.
      const isVague = wantsPlan && last.trim().split(/\s+/).length <= 8 && !/\d|ch\.|chapter/i.test(last)
      return sse(
        quizNeedsClarify
          ? [
              [{ tool_call: 'ask_clarifying_questions', questions: [
                { id: 'quiz_type', text: 'What kind of questions?', options: ['Multiple choice', 'True or false', 'Short answer', 'Matching', 'A mix'] },
                { id: 'quiz_count', text: 'About how many?', options: ['5', '10', '15', '20'] },
              ] }, 300],
              [{ done: true }, 60],
            ]
          : wantsQuiz
          ? [
              [{ chunk: 'Sure — building a multiple choice quiz over this week now.' }, 120],
              [{ tool_call: 'generate_quiz', question_types: ['multiple_choice', 'true_false'], num_questions: 6 }, 120],
              [{ done: true }, 60],
            ]
          : isVague
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

    /* ── standards ───────────────────────────────────────────────────────────
       ORDER MATTERS, and it is the same trap routes/standards.py registers
       around: `/{code:path}` matches "coverage" and "stats" perfectly well, so
       anything that isn't a literal code has to be claimed BEFORE the
       catch-all at the bottom of this block. Both of these were reaching it —
       /coverage came back as a 404 "code not in the corpus", which the heatmap
       read as "every standard used zero times" and rendered without complaint. */
    if (path === '/api/standards' && method === 'GET') {
      await wait(120)
      return json({ items: STANDARDS_LIST, total: STANDARDS_LIST.length })
    }

    // batch and global, like coverage and stats below, are literal segments the
    // {code:path} catch-all would otherwise swallow. Everything /api/standards
    // lives in this block, in this order, for that reason.
    if (path === '/api/standards/batch' && method === 'GET') return json(STANDARDS)
    if (path.startsWith('/api/standards/global')) return json({ standards: STANDARDS_LIST })

    if (path === '/api/standards/coverage') {
      // code -> citation count. Deliberately spans the heatmap's four colour
      // bands (0, 1-2, 3-5, 6+) so no band goes unrendered.
      await wait(80)
      return json({ 'ELA21.11.R2': 7, 'RHS-2': 4, 'CLE-4': 2, 'R.TST.701': 1 })
    }

    if (path === '/api/standards/stats') {
      return json({
        total: STANDARDS_LIST.length,
        by_source_type: { state: 3, act: 2 },
        by_source_document: {
          'Alabama Course of Study: ELA (2021)': 3,
          'ACT College & Career Readiness Standards': 2,
        },
      })
    }

    if (path === '/api/standards/gaps') {
      return json({
        sections: [
          { title: 'AP Language & Composition', body_md: 'Ingested verbatim from the CED.' },
          { title: 'World Languages', body_md: 'Not ingested — cite by description, not by code.' },
        ],
        intro_md: 'What the corpus does and does not contain.',
        ungroundable_families: ['WL', 'FA'],
      })
    }

    if (path === '/api/standards/search' && method === 'POST') {
      await wait(200)
      const q = (body?.query || '').toLowerCase()
      const hits = STANDARDS_LIST.filter((s) => s.description.toLowerCase().includes(q) || s.code.toLowerCase().includes(q))
      return json({
        floor: 0.42,
        // Distance ASCENDING — nearest first. The floor only reads as a floor
        // if the list it cuts is ordered against it.
        results: (hits.length ? hits : STANDARDS_LIST).slice(0, body?.top_k || 10).map((s, i) => ({
          ...s,
          distance: 0.18 + i * 0.09,
        })),
      })
    }

    const lessonsMatch = path.match(/^\/api\/standards\/(.+)\/lessons$/)
    if (lessonsMatch) {
      await wait(120)
      const code = decodeURIComponent(lessonsMatch[1]).toUpperCase()
      // ELA21.11.R2 alone has history, so StandardRow's "you haven't used this
      // standard yet" copy stays reachable for every other code.
      return json(
        code === 'ELA21.11.R2'
          ? [{ plan_id: 'plan1', week_label: 'Week 03 — Aug 17-21, 2026', day_name: 'Monday', created_at: '2026-08-17T00:00:00+00:00' }]
          : []
      )
    }

    if (path.startsWith('/api/standards/') && path !== '/api/standards/stats') {
      const code = decodeURIComponent(path.slice('/api/standards/'.length)).replace(/\s+/g, ' ').trim().toUpperCase()
      const record = STANDARDS[code]
      // 4.C falls here — same as the real backend does for a code retrieval
      // never supplied, and the one path Citation.jsx's "Not in the standards
      // corpus" copy exists for but nothing was ever exercising.
      return record ? json(record) : new Response('{}', { status: 404 })
    }

    /* NOT `return json({})`.
     *
     * This used to hand an empty 200 to any endpoint the mock didn't
     * recognise, which is the most dangerous possible default. mockApi covers
     * about half of what src/lib/api.js calls, so roughly thirty endpoints
     * silently "succeeded" with `{}` — and a button whose mutation resolves is
     * a button that looks like it worked. Every test written on top of that
     * would have passed while the feature was dead.
     *
     * A 501 instead: recorded, and loud enough that scripts/test-buttons.mjs
     * fails the run. Deliberately a response rather than a throw — the app's
     * own error handling (toastContext, ErrorBoundary) is part of what's under
     * test, and a button that reports a server failure gracefully IS working.
     * Add the route rather than muting this. */
    unhandled.push({ path, method, body })
    return new Response(
      JSON.stringify({ error: `mockApi has no handler for ${method} ${path}` }),
      { status: 501, headers: { 'Content-Type': 'application/json' } }
    )
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    if (!url.startsWith('/api') && !url.includes('/api/')) return real(input, init)
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    const method = (init.method || 'GET').toUpperCase()
    // Only JSON bodies parse. Uploads send FormData, and JSON.parse on it threw
    // before any route matched — so every upload failed inside the mock and the
    // app dutifully reported "Could not read that file".
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    /* Pushed before the await and mutated after, so `calls` stays in request
       order. Ordering by completion would scramble exactly the races the
       per-endpoint `latency` knobs exist to reproduce. */
    const call = { path, method, body, at: performance.now(), status: null }
    calls.push(call)
    const res = await route(path, method, body, init, url)
    call.status = res.status
    return res
  }

  // Handle for the test driver.
  window.__mock = {
    state,
    latency,
    calls,
    unhandled,
    reset: () => {
      calls.splice(0)
      unhandled.splice(0)
    },
  }
}
