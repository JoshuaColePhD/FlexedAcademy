# FlexedAcademy

FlexedAcademy is a standards-grounded AI lesson-planning platform for high-school teachers. It turns a teacher's weekly request into a structured, standards-aligned lesson plan, shows the sources behind the standards it cites, and exports the result as a district-formatted Word document.

Live product: [flexedacademy.com](https://flexedacademy.com)

## What it does

- Generates weekly lesson plans from teacher prompts and class context.
- Grounds standards claims in source documents instead of relying on model memory.
- Displays cited standards, source metadata, and grounding warnings for review.
- Supports teacher-owned pacing guides and school-specific lesson-plan templates.
- Provides conversational coaching, plan revision, quiz generation, and DOCX/QTI exports.
- Supports multiple teachers, classes, authentication, account controls, and usage entitlements.

## Why this is an AI-engineering project

The central problem is not text generation alone. Standards contain low-frequency codes, repeated numbering schemes, and course-specific meanings that language models can easily confuse. FlexedAcademy treats retrieval, validation, and refusal as first-class product behavior:

```text
Teacher request
      ↓
Class / course / grade resolution
      ↓
Query expansion + embedding
      ↓
Course- and grade-scoped pgvector retrieval
      ↓
Relevance floor and scope checks
      ↓
Grounded context supplied to the model
      ↓
Strict structured lesson-plan response
      ↓
Schema validation + citation grounding audit
      ↓
Postgres persistence + DOCX generation
```

## Engineering highlights

- Built a retrieval-augmented generation pipeline with source metadata, verbatim standard text, course/grade filters, query expansion, and measured relevance thresholds.
- Added layered grounding controls: out-of-scope grade refusal, off-domain refusal, source-type-aware retrieval, and post-generation detection of missing, borrowed, or hallucinated standard codes.
- Uses OpenAI Structured Outputs with strict JSON schemas so the frontend and document builders receive a predictable contract rather than free-form model text.
- Handles streaming generation over Server-Sent Events, reconnects, upstream timeouts, rate limits, model refusals, response truncation, token accounting, and database-backed completion caching.
- Built a standards-ingestion path using ALSDE CASE packages and PDF verification. The current corpus contains 2,997 standards and 11,435 chunks across 11 Alabama frameworks for grades 9–12, with AP Language as the most thoroughly calibrated path.
- Built a template-aware document pipeline that validates plans before rendering, supports school-specific templates, and persists generated documents through a durable queue.
- Added tenant-aware authentication, class scoping, account export/deletion, session invalidation, plan-sharing controls, rate limiting, and security regression tests.

## Evaluation

The repository includes deterministic unit, contract, retrieval, grounding, security, and artifact tests. The recorded retrieval baseline contains 143 teacher-style cases:

```text
Recall@5:  138 / 143
Recall@60: 142 / 143
```

The evaluation suite also covers:

- Cross-course and cross-class grounding isolation
- Off-domain refusal behavior
- Structured plan shape and required fields
- Grounded versus non-retrieved versus hallucinated citations
- Streaming reconnect behavior
- DOCX integrity and queued document recovery
- Account takeover, session invalidation, public-plan access, and SPA file exposure

Run the fast local checks from the repository root:

```bash
./venv/bin/python eval/run_all.py --fast
./venv/bin/python scripts/05_eval_harness.py --offline
```

## Technology

- Python 3.12, FastAPI, Pydantic, OpenAI API
- Postgres/Supabase with pgvector
- React, Vite, React Router, TanStack Query
- Server-Sent Events for streamed generation
- `python-docx` and LibreOffice-compatible document generation
- Google OAuth and Google Drive integration
- Stripe billing, Resend email, Sentry monitoring, and Render deployment

## Repository layout

```text
backend/       FastAPI application, retrieval, LLM orchestration, persistence
frontend/      React application and responsive teacher-facing UI
data/raw/      Source standards documents and CASE packages
data/eval/     Golden retrieval cases and evaluation data
eval/          Regression and quality-test suites
scripts/       Standards ingestion, embedding, audits, and release checks
```

## Explore the implementation

The deployed product is the primary way to experience FlexedAcademy. The repository is provided so technical reviewers can inspect the implementation, evaluation strategy, and engineering decisions without needing to reproduce the hosted environment.

- [LLM orchestration and structured generation](backend/llm.py)
- [Retrieval, relevance floors, and grounding audits](backend/retrieval.py)
- [Generate → validate → persist pipeline](backend/service.py)
- [Evaluation suite and retrieval baseline](eval/README.md)
- [Deployment and production-readiness notes](DEPLOYING.md)

## Recruiter package

- [Product walkthrough video](docs/recruiter/FlexedAcademy_Walkthrough.mp4)
- [Applied-AI case study](docs/recruiter/FlexedAcademy_Case_Study.md)
- [Sample generated lesson plan](docs/recruiter/FlexedAcademy_Sample_Lesson_Plan.docx)

### Optional demo access

The deployed sign-in page can expose a one-click “Explore demo” account for
recruiters and potential customers. It uses the same application shell and
seeded sample plan as the live product, but server-side enforcement disables
generation, edits, uploads, sharing, billing, and other mutations. No payment
or local setup is required.

To enable it, set `DEMO_ACCOUNT_EMAIL` and `DEMO_ACCOUNT_PASSWORD` as secrets in
the deployment environment, optionally set `DEMO_ACCOUNT_NAME`, and redeploy.
The password is never committed to GitHub or sent to the frontend. Without
those two values, the demo remains completely disabled.

For developers who want to run the system locally, the full setup requires Python 3.12+, Node.js, Postgres/Supabase with pgvector, and an OpenAI API key. See [.env.example](.env.example), [DEPLOYING.md](DEPLOYING.md), and the scripts in `eval/` for configuration and validation details. Never commit `.env`, API keys, database files, uploaded templates, generated plans, or local model caches.

## Known limitations

AP Language is the calibrated reference path. Other frameworks are ingested and course-scoped, but their retrieval thresholds and source verification coverage are not identical. The system depends on external model and embedding APIs, and grounded citations do not guarantee that every generated instructional activity is pedagogically optimal. Generated plans should be reviewed by a qualified teacher before distribution.

The application is teacher-facing. Users should not enter student names or other identifying information into prompts. Production privacy, OAuth, billing, storage, and school-template checks require environment configuration and pilot verification in addition to passing local tests.

## Project status

FlexedAcademy is deployed and actively developed. This repository is a portfolio and engineering reference for a production-oriented AI application; deployment credentials, hosted databases, generated documents, and other environment-specific assets are intentionally kept outside version control.
