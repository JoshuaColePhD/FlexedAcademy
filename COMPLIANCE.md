# FERPA compliance notes

This app is teacher-facing, not student-facing: nothing in the schema
(`backend/db.py`) has a column for a student's name, grade, essay, or
disciplinary record, and every table is scoped to a teacher's own
`user_id`. FERPA exposure is therefore narrower than a student data
platform's, but not zero — this doc lists what's actually at stake, what
the code now does about it, and the one action item that isn't a code
change.

## Where student information can enter this app

The only path in is a teacher pasting or typing it — most likely a
student essay excerpt or quote in a chat message asking for feedback, or
in a lesson-plan request. There is no field anywhere that asks for a
student's name.

**Action for every teacher using this app:** don't include a student's
name or other identifying detail in anything typed into the app. Ask
about the writing or the standard, not the student. This is stated on
the in-app privacy page (`/privacy`) and cannot be enforced by the code —
there's no reliable way to detect "this text names a student" — so it's a
usage guideline, not a technical control.

## Third-party data flows

Every chat message, lesson-plan request, curriculum upload, and quiz
prompt is sent to **OpenAI's API** (`backend/llm.py`) to generate a
response. Voice features send audio/text to OpenAI's transcription and
TTS endpoints. Billing (when enabled) sends only payment-relevant fields
to Stripe — never plan, chat, or curriculum content.

**Action item — not a code change, needs to happen outside this repo:**
execute OpenAI's Data Processing Addendum (DPA) for this account before
any content that could include student-identifiable text reaches their
API in production use. OpenAI publishes a self-serve DPA teams can accept
from their account's Data Controls settings. Do this once per OpenAI
account/org this app's `OPENAI_API_KEY` belongs to, and keep a record of
the acceptance date. Nothing in this codebase can execute a legal
agreement on your behalf — this has to be done by whoever administers
that OpenAI account.

## What the code does today

- **Auth fails closed.** `REQUIRE_LOGIN` defaults to `true`
  (`backend/config.py`) and Render's blueprint pins it there
  (`render.yaml`); a missing/invalid session cookie gets a 401, never a
  silent shared account. The `false` bypass only exists for local
  single-developer iteration.
- **Cookies are HTTPS-only in production.** `COOKIE_SECURE=true` in
  `render.yaml`; session tokens are HMAC-signed and re-checked against a
  live `session_version` column on every request (`backend/deps.py`), so
  "sign out of all devices" actually invalidates already-issued cookies.
- **Row-level security.** Every tenant-scoped table (`classes`, `chats`,
  `plans`, `messages`, `curriculum_maps`, `plan_feedback`, `quizzes`) has
  RLS enabled with a policy scoping rows to `current_setting('app.user_id')`
  (`backend/db.py` migration 20), so a connection that isn't the app's own
  owner role sees nothing.
- **TLS enforced on the database connection.** `backend/db.py`'s
  `_dsn_with_tls()` appends `sslmode=require` to `DATABASE_URL` when the
  operator's connection string didn't already specify one, so a bare
  connection string still gets an encrypted connection rather than
  silently falling back to plaintext.
- **No student content in logs.** Nothing in `backend/llm.py` or the
  route handlers logs message/prompt bodies; `logging.basicConfig`
  (`backend/server.py`) is INFO by default in production
  (`LOG_LEVEL`), so turning on DEBUG anywhere is an explicit, visible
  config change, not an accident.
- **Self-service export and delete.** `GET /api/account/export` returns
  everything a teacher's account owns as JSON; `POST
  /api/auth/delete_account` (re-verifies password first) permanently and
  immediately deletes the account and everything under it
  (`backend/db.py`'s `export_user_data` / `delete_user_account`).
- **Audit log.** `audit_log` (`backend/db.py` migration 27) records who
  did what and when: admin comping/uncomping an account, admin
  school create/delete, and a teacher's own export or account deletion.
  Viewable at `/admin` → Audit log, or via `GET /api/admin/audit-log`.
  This is a real access/action trail, distinct from the server's own
  request log (`logs/backend.log`), which is operational, not a
  compliance record.
- **In-app privacy policy.** `/privacy` (linked from the landing page
  footer and the account menu) explains in plain language what's stored,
  what goes to OpenAI, and how to export or delete an account.

## Not attempted here (and why)

- **Redacting/blocking student names in prompts.** No general, reliable
  way to detect a name in free text without both false positives (common
  words as "names") and false negatives (typos, nicknames). Handled as a
  usage guideline instead (above), not a filter.
- **A signed subprocessor/DPA registry in-app.** The DPA is a one-time
  organizational action (see above), not a per-request runtime concern —
  there's nothing for the app itself to track or enforce at request time.
