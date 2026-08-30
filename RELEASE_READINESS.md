# FlexEd Academy release readiness

The repository has a repeatable release gate, but a local green build cannot
prove that Google OAuth, Google Drive, email, Stripe, Render, or real school
templates are configured correctly. Run the local gate from the project root:

```bash
node scripts/release_readiness.mjs
```

To include the deployed-site browser smoke test:

```bash
RELEASE_URL=https://flexedacademy.com node scripts/release_readiness.mjs
```

## What is covered automatically

- Backend compilation, lint, unit/contract tests, schema and grounding guards.
- Frontend lint, token/class checks, production build, focused behavior tests,
  and authenticated Playwright coverage when E2E credentials are supplied.
- Stream reconnect behavior: one dropped SSE connection is retried without
  creating a second transcript message.
- DOCX integrity: the browser validates the ZIP signature and polls a queued
  document job instead of downloading an API error as `download.json`.
- Public liveness and authenticated-route smoke checks in the scheduled Uptime
  workflow.

## Required pilot checks

Use a disposable teacher account and one real template at Florence and Weeden.
Record the result for each item before calling the release production-ready:

1. A new teacher can select a school, choose an existing template, or upload a
   personal template without changing the school default.
2. A school candidate can be analyzed, explicitly approved, made the master,
   and later retired without changing already-generated plans.
3. Two teachers at the same school can use different personal templates.
4. A vague chat request receives a focused question; a specified request does
   not ask how many days the template already defines.
5. A dropped/reconnected chat turn visibly retries and appears once.
6. A generated plan downloads as a valid `.docx`; a queued build waits and a
   failed build gives a recoverable message.
7. Save to the connected Google Drive and share to a second Google account.
8. Research mode displays working source links and the response remains useful
   if the scholarly lookup is unavailable.
9. Sign out, sign back in as another account, and verify no classes, chats,
   plans, or cached template choices leak across the account boundary.

## Production operator checklist

- Set a unique `SESSION_SECRET`; never run production with the local default.
- Configure `DATABASE_URL`, `OPENAI_API_KEY`, Google OAuth client IDs, and the
  `DRIVE_REDIRECT_URL`/Google Cloud authorized redirect URI pair.
- Configure durable Supabase storage for uploads and generated documents.
- Configure Resend sender/API key, Sentry DSN, and Stripe together if billing
  is enabled.
- Confirm Render health checks `/api/health/ready` and the scheduled Uptime
  workflow are green after deployment.
- Keep the first real-school rollout small and review generated plans before
  teachers distribute them to students.
