# Reliability recovery — September 21, 2026

The broader recovery changes are now included in the full workspace release candidate. Final CI and deployment verification are recorded in its release PR. The focused ACT citation-format fix and its release tests were merged in [PR #107](https://github.com/JoshuaColePhD/FlexedAcademy/pull/107), based on current master and separate from the workspace redesign. After explicit user approval, Render deployed merge commit `2bd4c96970b8300cfc00ee67502a5358687d67a8` as deployment `dep-daoiuv7lk1mc7387tjdg`, marked live at 2026-09-21 13:23:11 UTC.

The hotfix commit `ed65bde81a7083c7b3a7960c54cb589ed55cbed8` passed all five GitHub checks: backend, frontend, local-quality, npm-audit, and pip-audit. It changes only ACT citation validation, its tests, and CI coverage. The deployed Render service reports automatic deployment on master commits. That focused hotfix did not include the wider chat/recovery changes below; those are part of the subsequent full workspace release.

After deployment, `https://flexedacademy.com/api/health` and `/api/health/ready` both returned HTTP 200 with `{"ok":true}`; the public app page returned HTTP 200 with its application shell. No paid production lesson generation was initiated during this verification.

The reported screenshot showed a weekly lesson rejected because Monday's ACT alignment omitted the primary-standard link, followed by a chat connection failure. The local code reproduced the validation failure and exposed an unprotected context-loading phase in the chat stream. Production logs were not available, so the exact cause of that particular connection failure remains unconfirmed.

## Changes

- A follow-up screenshot exposed a deterministic false rejection: `Supports primary Skill Category 7` was rejected solely because the code lacked square brackets. Explicit primary links now accept either bracketed or bare codes and equivalent whitespace/case. Exact code boundaries remain enforced, so `Skill Category 70` cannot satisfy a reference to `Skill Category 7`. This avoids a paid correction call for an already-valid link. Missing-link errors offer a retry instead of asking teachers to edit validator syntax.
- New and revised weeks get one targeted correction attempt when an ACT alignment fails validation. The correction can change only ACT cells, uses the retrieved source standards, and has a 30-second provider timeout with no SDK retries. Every corrected cell passes the existing grounding audit before any plan write. Invalid repairs remain failures; the app does not invent evidence or save an unsupported alignment.
- Chat heartbeats cover queueing, database/context loading, and model output. Disconnects cancel queued work and close the active model stream. The worker retains admission capacity until it actually exits, preventing a reconnect from bypassing concurrency limits while abandoned work continues.
- Revision validation and saving also emit heartbeats, including during ACT correction.
- Streaming requests recognize temporary HTML gateway errors and share session-expiry handling with the regular API client. Retries preserve the logical request ID, use bounded exponential backoff with jitter, honor `Retry-After`, and stop automatically for long backoffs or explicit nonretryable errors. Stopping also cancels the backoff wait.
- Provider billing/quota and configuration errors do not trigger automatic retries. Provider logs retain status, error code, request ID, and bounded diagnostic wording. This follows the [OpenAI error guidance](https://developers.openai.com/api/docs/guides/error-codes).
- A terminal success event completes chat or lesson generation immediately, even if a gateway leaves the HTTP connection open. The browser closes its reader instead of timing out and repeating completed work.

## Verification

Offline regression coverage includes:

- The reported missing ACT link, repairing all teaching days in one pass, preserving lesson content, rejecting invented source codes and out-of-scope patches, and avoiding repair calls for valid lessons.
- Heartbeats during blocked context loading, owner identity in worker threads, cancellation while queued or loading context, and closing a provider stream on cancellation.
- Distinguishing transient overload from quota/authentication/configuration failures.
- Gateway recovery with one saved lesson and one user message, stable request IDs, cancellation during backoff, and completion without waiting for connection closure.
- Existing chat creation/revision/quiz flows and stable composer geometry across views.

Tests use local fixtures and simulated providers. They do not spend on live generation or connect to the production database. Database integration tests require the existing disposable localhost PostgreSQL fixture or the isolated CI job. Before release, run those integration checks on the final revision and verify a real lesson generation and revision in staging; monitor production failures by release and error code after deployment.
