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

## Run locally

Prerequisites:

- Python 3.12+
- Node.js and npm
- A Postgres/Supabase database with pgvector for the full application
- An OpenAI API key for embeddings and generation

Install dependencies and configure the environment:

```bash
python -m venv venv
./venv/bin/pip install -r requirements.lock.txt
cd frontend && npm ci && cd ..
cp .env.example .env
```

Set `OPENAI_API_KEY` and the database settings in `.env`, then start the application:

```bash
./run.sh
```

The API serves the built frontend in production. For frontend development, run `npm run dev` from `frontend/` and use the configured Vite proxy.

Never commit `.env`, API keys, database files, uploaded templates, generated plans, or local model caches. See `.env.example` for configuration options and `DEPLOYING.md` for deployment details.

## Known limitations

AP Language is the calibrated reference path. Other frameworks are ingested and course-scoped, but their retrieval thresholds and source verification coverage are not identical. The system depends on external model and embedding APIs, and grounded citations do not guarantee that every generated instructional activity is pedagogically optimal. Generated plans should be reviewed by a qualified teacher before distribution.

The application is teacher-facing. Users should not enter student names or other identifying information into prompts. Production privacy, OAuth, billing, storage, and school-template checks require environment configuration and pilot verification in addition to passing local tests.

## Project status

FlexedAcademy is deployed and actively developed. This repository is a portfolio and engineering reference for a production-oriented AI application; deployment credentials, hosted databases, generated documents, and other environment-specific assets are intentionally kept outside version control.
