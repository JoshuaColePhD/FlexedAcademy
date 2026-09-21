# Teacher adoption and operational readiness

Release preparation: September 21, 2026. The workspace, onboarding, voice and recovery changes are being released together after integration with production master. The release PR records the final checks and deployment status.

## What a teacher can do

- Complete two-step onboarding: choose a state, grade and course, then supply a real topic and teaching week. Calendar and template configuration are optional. An unfinished draft resumes for the same account. Unsupported standards coverage is disclosed before generation.
- Open a specific saved plan from the Library, including a plan whose original conversation is missing.
- Keep the conversation visible while opening Materials or the lesson reader. The composer keeps its dimensions across views and shows the current lesson context inside its top edge.
- Consult by voice through a compact audio strip above the composer; see a saved change and undo it without overwriting a concurrent revision. Version history begins at rollout; earlier overwritten content cannot be reconstructed.
- The separate **Teach & review** section was removed from the visible workspace at the teacher's request. Its delivery/history services remain covered by backend tests; the full review and next-week UI is not an exposed feature in this release.
- Upload a teaching source, see saved/queued/processing/ready status, inspect extracted passages and retry a failed read. A document is not marked ready merely because its original file uploaded.

## Operational changes

- Initialized pgvector through a compatible psycopg connection class. Authentication lookup runs off the event loop; the verified owner context propagates to the route and to worker threads.
- Plan revisions and version snapshots are transactional. DOCX jobs carry the revision and a claim token, periodically recover abandoned work, and publish only the version they built. New document and material jobs are enqueued with their parent database writes.
- Generation requests have durable identities and fingerprints. A restart can recover a committed deterministic plan; an interrupted unsaved model call requires an explicit retry. Cancellation closes the upstream stream and retains capacity until the worker exits. A completed save wins over a late cancellation.
- Stripe event handling serializes by the affected object and commits idempotency with the applied update. Equal-time events reconcile current subscription state.
- Paid standards, calendar, template and material operations apply entitlement and concurrency controls. Parsing/embedding calls have bounded retries. Citation lookups batch database reads; course context informs query expansion.
- Normal frontend requests share one total deadline, including retry and response-body reading. Failed account loading presents recovery instead of permanent loading. Plan changes invalidate library and coverage queries.
- Markdown, math, checkout, onboarding tools and monitoring load behind the surfaces that need them. The bundler does not pull shared dependencies into the lazy math chunk. Initial production HTML assets measured **190,455 gzip bytes of JavaScript** and **64,596 gzip bytes of CSS** in the local build, compared with the reviewed JavaScript baseline of roughly **338 KB**. This is a payload measurement, not a measured improvement in real-user LCP/INP.
- Configured Sentry tracing can collect sampled page/navigation timings and web vitals. Activation events record first-plan requests/completions/failures, citation views, export, revision and completion of a week started through the next-week action. They omit prompt text, filenames and student details.
- CI runs frontend checks, behavioral browser tests, offline backend/evaluation tests and disposable pgvector integration tests. The Render blueprint requests waiting for checks through its supported [autoDeployTrigger setting](https://render.com/docs/blueprint-spec#autodeploytrigger); the live service setting must also be verified. Uptime checks no longer create a workflow-trigger loop. The version endpoint reports release identity.

## Local walkthrough

```bash
cd frontend
npm run dev -- --host 127.0.0.1 --port 5174
```

First run: `http://127.0.0.1:5174/preview.html?fresh=1&persist=1`

Existing lesson: `http://127.0.0.1:5174/preview.html?fresh=0&persist=1&trial=7&at=/c/c1/chat/seed1%3Fplan=plan1`

These preview routes use deterministic sample responses. Opt-in `persist=1` retains preview work in this tab's session. Explicit `fresh=1` or `fresh=0` starts a new fixture. They do not run paid generation or connect the production database. The preview entry is excluded from production builds.

## Verification and remaining release work

The integrated backend suite passed **307 tests** locally; **16 database-dependent tests skipped** without a disposable PostgreSQL server. The offline evaluator passed all 15 suites. Frontend unit checks, lint, token/class checks and production compilation passed. The complete browser suite and disposable PostgreSQL checks run against the final release revision; their authoritative results are recorded in the release PR. Dependency deprecation warnings and existing frontend lint warnings remain.

Before deployment, run the PostgreSQL CI job against the exact final changes and review its migration, tenant-isolation and concurrency results. No local mock is evidence that a production migration or paid model run succeeded. Sentry collection requires the deployment's public DSN. Live Google/Stripe account flows require the existing disposable staging credentials. Process-local admission limits still require a distributed design before horizontally scaling model workers.

Run the existing generation-quality audit on an approved isolated corpus/account with a chosen model-spend budget. Add a held-out set of actual teacher requests; do not derive every test prompt from the standard it is supposed to retrieve. Include ambiguous course names, a shortened week, no pacing guide, an unreadable upload, a revision, and unsupported standards coverage. Keep development examples separate from the held-out sample.

Have teachers review anonymized baseline and revised outputs in randomized order. Score whether the target is teachable, activities practice it, the assessment tests it, timings fit, materials exist, and cited standards genuinely support the activity. Record minutes of editing before use and the preferred version. A green citation audit alone does not establish lesson usefulness.

For the first pilot cohort, establish actual baselines for setup completion, time to a useful first draft, first-week export/use and return to plan the following week. Distinguish generating a second plan from the specific next-week action event; the latter alone is not a retention rate. Review failure reasons before setting conversion targets. This field validation remains necessary because implementation and synthetic fixtures cannot prove teacher desirability.

Storage operations should periodically reconcile unreferenced legacy/crash artifacts using an inventory, a dry run and a grace period. Never delete an object still referenced by a current plan, template, upload or pending document job.
