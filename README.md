<div align="center">

<img src="logo/blue_check_logo.svg" alt="FlexEd Academy" width="84" />

# FlexEd Academy

### Standards-grounded lesson planning that shows its work.

Tell FlexEd what to teach this week. Get back a five-day, standards-aligned plan — with every cited
standard traced to the source it came from — formatted in your district's own template and ready to
download as a Word doc.

[![Quality](https://github.com/JoshuaColePhD/FlexedAcademy/actions/workflows/quality.yml/badge.svg)](https://github.com/JoshuaColePhD/FlexedAcademy/actions/workflows/quality.yml)
[![Security](https://github.com/JoshuaColePhD/FlexedAcademy/actions/workflows/security.yml/badge.svg)](https://github.com/JoshuaColePhD/FlexedAcademy/actions/workflows/security.yml)
[![Uptime](https://github.com/JoshuaColePhD/FlexedAcademy/actions/workflows/uptime.yml/badge.svg)](https://github.com/JoshuaColePhD/FlexedAcademy/actions/workflows/uptime.yml)

[**Try it → flexedacademy.com**](https://flexedacademy.com) · [Case study](docs/recruiter/FlexedAcademy_Case_Study.md) · [Architecture](docs/ARCHITECTURE.md)

</div>

---

## See it in 40 seconds

Open a week, read the five-day plan with its **cited standards**, check the **sources** behind them,
grab the district-formatted **DOCX** — light mode or dark.

![FlexEd Academy walkthrough](docs/recruiter/FlexedAcademy_Walkthrough.gif)

<sub>Shown as a GIF because GitHub only embeds video players for files uploaded through its own UI. Full quality: [MP4](docs/recruiter/FlexedAcademy_Walkthrough.mp4) · [WebM](docs/recruiter/FlexedAcademy_Walkthrough.webm). On the live site, click **Explore demo (read-only)** — no setup, no signup.</sub>

---

## What you get

| | |
| --- | --- |
| **A full week, in one prompt** | Five days of standards-aligned planning from a single teacher request and class context. |
| **Citations you can trust** | Standards pulled from real source documents — not model memory — with verbatim text and provenance. |
| **Receipts for every claim** | See exactly which standards were used, where they came from, and any grounding warnings. |
| **Your district's format** | Renders into school-specific lesson-plan templates and exports DOCX (plus QTI for quizzes). |
| **Talk to it** | Coaching, day-by-day revisions, quiz generation, and teacher-owned pacing guides. |
| **Built for real classrooms** | Multi-teacher accounts, class scoping, usage limits, billing, and account controls. |

## Why it's more than a model wrapper

The hard part isn't writing text — models do that all day. The hard part is **trust**. Standards are
full of look-alike codes and course-specific meanings a model will confidently get wrong. FlexEd is
built to refuse rather than guess, and to prove where every cited standard came from:

```text
Teacher request
      ↓
Class / course / grade resolution
      ↓
Query expansion + embedding
      ↓
Course- and grade-scoped pgvector retrieval
      ↓
Relevance floor and scope checks     ──►  refuse rather than guess
      ↓
Grounded context supplied to the model
      ↓
Strict structured lesson-plan response (OpenAI Structured Outputs)
      ↓
Schema validation + citation grounding audit
      ↓
Postgres persistence + templated DOCX generation
```

## Under the hood

- **Retrieval that means it** — source metadata, verbatim standard text, course/grade filters, query expansion, and measured relevance thresholds.
- **Grounding, not vibes** — out-of-scope grade refusal, off-domain refusal, source-type-aware retrieval, and post-generation detection of missing, borrowed, or hallucinated codes.
- **A contract, not a blob** — OpenAI Structured Outputs with strict JSON schemas, so the UI and document builders always get predictable data.
- **Streaming that survives the real world** — reconnects, upstream timeouts, rate limits, refusals, truncation, token accounting, and database-backed completion caching.
- **Standards, verified** — ingested from ALSDE CASE packages with PDF checks. The Alabama artifact holds 7,456 unique standards and 19,701 grade-scoped chunks across 11 frameworks at `--grades 0-12` (defaults to 9–12); AP Language is the most calibrated path.
- **Documents that hold up** — plans are validated before rendering, school templates are supported, and every document is built through a durable queue.
- **A real platform** — authentication, class scoping, account export/deletion, session invalidation, plan sharing, rate limiting, and security regression tests.

## Grounding is a claim, so it's tested like one

Deterministic unit, contract, retrieval, grounding, security, and artifact tests back the whole
pipeline. The release retrieval gate is generated from the live corpus:

```text
Current recall@5:  61 / 61
Current recall@20: 61 / 61
```

<sub>The older 143-case set is kept only as a historical drift diagnostic — many of its AP codes no longer exist in the current corpus.</sub>

The suite also covers cross-course and cross-class isolation, off-domain refusal, plan shape,
grounded vs. non-retrieved vs. hallucinated citations, streaming reconnects, DOCX integrity and
queued-document recovery, and security cases (account takeover, session invalidation, public-plan
access, SPA file exposure).

```bash
./venv/bin/python eval/run_all.py --fast
./venv/bin/python scripts/05_eval_harness.py --offline   # no network required
```

The Alabama standards artifact ships with its own dependency-free quality gate — framework roster,
metadata, state/grade scope, duplicate identities, source URLs, PDF verification, and report
consistency:

```bash
./venv/bin/python scripts/check_alabama_ingest.py
```

<details>
<summary>How embedding rebuilds stay safe</summary>

Rebuilds keep a local content-addressed cache keyed by the embedding model, dimensions, and document
text, so interrupted or repeated runs reuse unchanged vectors. The staged Supabase cutover validates
the full replacement corpus before it goes live: each rebuild uses a unique staging identifier,
builds HNSW/full-text indexes after loading, and only then performs the atomic table swap — retries
never write a partial live corpus.

</details>

## Tech stack

- **Backend** — Python 3.12, FastAPI, Pydantic, OpenAI API
- **Data** — Postgres / Supabase with `pgvector`
- **Frontend** — React, Vite, React Router, TanStack Query
- **Streaming** — Server-Sent Events for streamed generation
- **Documents** — `python-docx` and LibreOffice-compatible generation
- **Integrations** — Google OAuth & Drive, Stripe billing, Resend email, Sentry, Render
- **Interop** *(experimental, not yet in production)* — an in-progress MCP Streamable HTTP connector with OAuth 2.1/PKCE and an Apps SDK lesson-plan widget

## MCP / ChatGPT connection (experimental — not yet enabled in production)

> **Status:** work in progress. The pieces below exist in the codebase, but the connector is still
> being built and hardened and is **not turned on in production**. Read this as where it's headed,
> not a shipped feature.

FlexEd includes an in-progress remote MCP server (`/mcp/`) meant to let a ChatGPT custom app, Claude
connector, or MCP client authenticate with OAuth discovery, approve access in the teacher's FlexEd
account, and then call the same retrieval → generation → grounding → database → DOCX pipeline the web
app uses. The planned Apps SDK surface covers class/week context, plan listing and retrieval, plan
generation, day-level revision, a secure DOCX capability URL, and an in-chat lesson-plan widget.

For local experimentation, log in and `POST /api/mcp/token` for a short-lived per-user bearer token
and the MCP URL, and set `MCP_PUBLIC_URL` to the public HTTPS origin for a shared deployment. Never
commit `MCP_ACCESS_TOKEN`, `SESSION_SECRET`, or any generated connector token.

## Repository layout

```text
backend/     FastAPI application, retrieval, LLM orchestration, persistence
frontend/    React application and responsive teacher-facing UI
data/raw/    Source standards documents and CASE packages
data/eval/   Golden retrieval cases and evaluation data
eval/        Regression and quality-test suites
scripts/     Standards ingestion, embedding, audits, and release checks
```

Start here: [LLM orchestration](backend/llm.py) · [retrieval & grounding audits](backend/retrieval.py) · [generate → validate → persist](backend/service.py) · [evaluation suite](eval/README.md) · [deployment notes](DEPLOYING.md).

## For reviewers

1. Open the [live product](https://flexedacademy.com) and click **Explore demo (read-only)**.
2. Skim the [portfolio brief](docs/recruiter/PORTFOLIO_BRIEF.md) for the problem, the evidence, and the story.
3. Read the [architecture](docs/ARCHITECTURE.md) and [engineering decisions](docs/DECISIONS.md).
4. Run `./venv/bin/python scripts/05_eval_harness.py --offline` — the no-network regression gate.
5. See the [production evidence snapshot](docs/recruiter/PRODUCTION_EVIDENCE.md), [case study](docs/recruiter/FlexedAcademy_Case_Study.md), and [sample lesson plan](docs/recruiter/FlexedAcademy_Sample_Lesson_Plan.docx).

The read-only demo runs the same app shell and a seeded sample plan as production, but server-side
enforcement disables generation, edits, uploads, sharing, and billing. To turn it on for a
deployment, set `DEMO_ACCOUNT_EMAIL` and `DEMO_ACCOUNT_PASSWORD` as secrets (optionally
`DEMO_ACCOUNT_NAME`) and redeploy; without those values it stays off.

Running locally needs Python 3.12+, Node.js, Postgres/Supabase with `pgvector`, and an OpenAI API key
— see [.env.example](.env.example) and [DEPLOYING.md](DEPLOYING.md). Never commit `.env`, API keys,
databases, uploaded templates, generated plans, or local model caches.

## Honest limitations

AP Language is the calibrated reference path; other frameworks are ingested and course-scoped, but
their thresholds and source-verification coverage differ. The system leans on external model and
embedding APIs, and grounded citations don't guarantee every activity is pedagogically optimal —
**a qualified teacher should review any plan before using it**. The app is teacher-facing; don't put
student names or other identifying information into prompts.

## Status

FlexEd is deployed and actively developed. This repo is a portfolio and engineering reference for a
production-oriented AI application — deployment credentials, hosted databases, generated documents,
and other environment-specific assets are intentionally kept out of version control.
