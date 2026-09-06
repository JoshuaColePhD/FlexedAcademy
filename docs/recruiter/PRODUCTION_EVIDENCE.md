# FlexEd Academy production evidence

This is a dated evidence snapshot, not a claim of customer adoption.

## Verified September 6, 2026

| Check | Result |
|---|---|
| Public homepage | HTTP 200 |
| Public liveness endpoint | HTTP 200, `{"ok":true}` |
| Deployment readiness endpoint | HTTP 200, `{"ok":true}` |
| Read-only recruiter demo | Enabled; demo availability and login returned HTTP 200 |
| Custom domain and TLS | `flexedacademy.com` and `www.flexedacademy.com` verified in Render; certificate issued for apex |
| Authenticated browser path | Existing class and 5-day lesson plan rendered |
| Browser console | No warning or error entries during inspection |
| Backend fast regression gate | 10 suites passed |
| Frontend quality gate | Lint, token/class checks, and production build passed |
| Standards artifact gate | 19,701 chunks, 0 errors, 2 known source-fidelity warnings |

## Recorded quality baselines

- Current canonical retrieval baseline: 61/61 recall@5 and 61/61 recall@20.
- Historical 143-case diagnostic: retained separately because corpus changes
  made some older expectations intentionally stale.
- Security, grounding, scoped-revision, entitlement, streaming, and DOCX
  contract tests run in the repository's fast gate.

## What this does not prove

These checks do not substitute for a disposable-account pilot. Before claiming
production adoption, test Google OAuth, password recovery, Drive save/share,
Stripe if enabled, real school templates, account switching, and artifact
recovery using the checklist in [`RELEASE_READINESS.md`](../../RELEASE_READINESS.md).

For a recruiter-facing portfolio, add measured pilot evidence here only after it
exists: number of teachers, plans generated, successful export rate, median
generation time, p95 latency, approximate cost per plan, and summarized user
feedback. Never add invented traction or identifiable student data.
