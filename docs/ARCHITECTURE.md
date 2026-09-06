# FlexEd Academy architecture

FlexEd is a production-oriented AI application for standards-grounded lesson
planning. Its central design goal is traceability: a generated standard should
be connected to the source text and retrieval decision that supported it.

## System flow

```text
Teacher request
  ↓
Class / course / grade resolution
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
layer ownership filters for user data, read-only server enforcement for the
recruiter demo, signed sessions, rate limits, and account export/deletion paths.
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
