# FlexEd Academy architecture

FlexEd is a production-oriented AI application for standards-grounded lesson
planning. Its central design goal is traceability: a generated standard should
be connected to the source text and retrieval decision that supported it.

## Product architecture contract

FlexEd is state-agnostic and teacher-owned by default. Florence High School,
Alabama, and AP Language are calibration data and optional school/course
contexts; they are never universal assumptions in the product.

Every teacher must be able to:

1. Create an account from any U.S. state and establish a class/course with the
   relevant state, framework, grade, and subject metadata.
2. Upload a lesson-plan template and reuse it for future plans. Template
   ingestion must capture both semantic structure and visual design intent,
   including worksheets/tables, merged cells, row and column geometry, labels,
   repeated day/week patterns, fonts, borders, fills, colors, and other
   meaningful formatting—not just extract its text or verify that it is blank.
3. Upload class/course materials such as syllabi, calendars, pacing guides,
   curriculum maps, rubrics, and instructional documents. These materials must
   be parsed, indexed, and scoped to the owning teacher/class/course.
4. Start a new chat and request a lesson plan in ordinary language. The
   generation request must combine the teacher's request with the selected
   standards, class metadata, calendar, uploaded materials, selected template,
   and optional per-class instructional period length. The period length is a
   class setting, is not asked during onboarding, and guides realistic pacing.
5. Receive a standards-grounded plan rendered back into the selected template,
   preserving its intended structure and design while exposing the standards
   sources and any grounding warnings for review.

### Scope hierarchy

Context must be resolved in this order, with narrower scope overriding broader
defaults:

```text
Teacher account
  → School (optional shared context)
    → Class / course
      → State + framework + grade + subject standards
      → Class materials and calendar
      → Selected teacher template
      → Current chat request
```

No generated plan may silently use another teacher's materials or template,
another class's course context, or a hard-coded school's calendar/profile.
Shared school resources require explicit school scope and access checks; a
teacher's personal template and materials remain private unless the product
explicitly supports sharing them.

### Template ingestion boundary

The template analyzer produces a durable, versioned template specification that
the document builder can use deterministically. The LLM may help describe
ambiguous design intent, but it is not the authority for cell placement,
formatting preservation, or artifact validity. A generated plan must be
validated against the template specification before its DOCX is offered to the
teacher. If a template feature cannot be preserved, the system must identify
the limitation and provide a recoverable warning rather than silently falling
back to a Florence-, district-, or neutral-layout document.

### Materials and standards boundary

Uploaded materials provide class/course context and instructional intent; they
do not replace authoritative standards. Standards retrieval must remain scoped
by the class's selected state, framework, grade, subject, and source policy.
The model may use teacher materials to understand pacing, sequence, language,
and constraints, but standards claims must still cite the retrieved standards
source or be marked as ungrounded.

## System flow

```text
Teacher account + class/course setup
  ↓
Template/design ingestion + class-material ingestion
  ↓
State / framework / grade / subject standards selection
  ↓
Teacher request in New Chat
  ↓
Tenant and class-context resolution
  ↓
Query expansion and embedding
  ↓
Course-, grade-, and source-scoped pgvector retrieval
  ↓
Relevance floor and refusal checks
  ↓
Grounded context supplied to the model
  ↓
Strict structured lesson-plan response
  ↓
Schema validation and citation-grounding audit
  ↓
Tenant-scoped persistence in Postgres/Supabase
  ↓
Template-aware rendering and visual/artifact validation
  ↓
Streamed browser preview + queued DOCX artifact
```

## Runtime boundaries

| Boundary | Responsibility | Failure behavior |
|---|---|---|
| React/Vite frontend | Teacher workflow, streamed progress, citations, warnings, artifact download | Recoverable UI error; no partial plan is presented as final |
| FastAPI backend | Authentication, orchestration, validation, rate limits, persistence | Structured error response; request can be retried |
| OpenAI | Query embeddings and structured generation | Timeout/retry/error message; no fabricated fallback citation |
| Supabase/Postgres | Users, classes, plans, source metadata, usage, artifact jobs | Readiness check fails; service remains explicit about unavailable dependencies |
| Supabase Storage | Durable uploaded templates and generated artifacts | Storage error is recoverable and does not silently return an API error as a DOCX |
| Render | Container build and production runtime | Health/readiness and browser smoke checks catch deployment failures |

## Grounding contract

Retrieval is not a cosmetic pre-step. The backend:

1. Resolves the selected class and course before searching.
2. Filters the corpus by the relevant course, grade, state, and source type.
3. Applies a measured relevance floor so unrelated requests can be refused.
4. Uses exact code lookup and stratified source retrieval when appropriate.
5. Passes source identifiers and verbatim text to the model.
6. Audits generated codes as grounded, non-retrieved, borrowed, or invented.
7. Persists the accepted plan together with the retrieval context needed for review.

The result is a system that can say “I could not ground that request” instead of
turning a low-confidence nearest neighbor into a confident-looking citation.

## Streaming and durability

Lesson generation streams progress over Server-Sent Events so the teacher can
see that work is underway. The durable path is separate from the stream:

- Partial tokens are preview state, not a saved plan.
- The final response must pass schema validation.
- A validated plan is persisted with tenant ownership and source IDs.
- DOCX creation is represented as a job and polled until complete.
- A failed artifact job has a recoverable error state rather than returning a
  downloadable JSON error with a `.docx` filename.

## Trust and privacy

The application is designed for teacher-facing workflows. It uses application-
layer ownership filters plus forced Postgres RLS policies for user data,
read-only server enforcement for the recruiter demo, signed sessions, rate
limits, and account export/deletion paths.
Users should not enter student names or other identifying information into
prompts. Local development must use a separate database before generating real
plans; the deployed and local configurations otherwise share Supabase data.

## Reproducibility surfaces

- `frontend/preview.html` runs the real frontend against deterministic fixtures
  without credentials or model calls.
- `eval/run_all.py --fast` runs the no-DB/no-API regression suites used in CI.
- `scripts/05_eval_harness.py --offline` is an equivalent explicit offline gate.
- `scripts/check_alabama_ingest.py` validates the standards artifact structure.
- `scripts/release_readiness.mjs` combines backend, frontend, and optional live
  browser checks into one release command.
- `scripts/smoke_production.mjs` checks what a signed-out visitor actually sees.
