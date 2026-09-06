# Engineering decisions

This document records the decisions most likely to come up in an Applied AI
Engineer interview. It focuses on tradeoffs and failure modes, not a list of
libraries.

## 1. Retrieval before generation

**Decision:** Ground standards claims in a retrieved corpus rather than asking
the model to recall standards from memory.

**Why:** Standard identifiers are sparse, repetitive, and course-specific. A
fluent model response can still cite the wrong code. Retrieval supplies source
text and metadata that can be audited after generation.

**Tradeoff:** Ingestion, embeddings, metadata quality, and threshold calibration
become part of the product. That complexity is intentional because a refusal is
safer than an unsupported standards claim.

## 2. Scope retrieval by course and grade

**Decision:** Course, grade, state, and source type are explicit retrieval
filters, not just prompt instructions.

**Why:** Semantic similarity alone can return a nearby standard from another
subject or grade. Scope filters protect the meaning of the selected class before
the model sees any context.

**Tradeoff:** The corpus must carry clean metadata and some legitimate crosswalks
need deliberate source-stratum handling. Those cases are tested rather than left
to embedding similarity.

## 3. Use structured outputs and post-generation validation

**Decision:** The model returns a strict lesson-plan schema, then the backend
validates both shape and citation grounding.

**Why:** The frontend, document builder, and persistence layer need a stable
contract. Schema validation catches missing fields; grounding audits catch
plausible but unsupported standard codes.

**Tradeoff:** The schema is more rigid than free-form chat. That is appropriate
for an artifact that becomes a teacher's working document.

## 4. Separate preview state from durable state

**Decision:** Stream generation progress, but only persist a validated final plan.

**Why:** SSE disconnects and upstream timeouts are normal failure modes. A partial
response should not become a saved plan or a downloadable document.

**Tradeoff:** Reconnect and job-state logic add frontend and backend complexity,
but they make failure recoverable and testable.

## 5. Keep document generation behind a job boundary

**Decision:** DOCX generation is queued and polled rather than treated as a
  synchronous side effect of the chat response.

**Why:** Template rendering and LibreOffice conversion are slower and more
  memory-intensive than ordinary API work. A job boundary lets the UI show
  progress and report a recoverable failure.

**Tradeoff:** The product must manage job status, retries, and durable artifact
  storage. That is a better failure mode than blocking the whole chat request.

## 6. Prefer deterministic evaluation to anecdotal demos

**Decision:** Keep retrieval recall, grounding, schema, security, streaming, and
  artifact tests in the release workflow.

**Why:** A polished demo can hide regressions. The evaluation suite turns the
  project's reliability claims into repeatable checks.

**Tradeoff:** Golden cases need maintenance when the standards corpus changes.
  Current and historical baselines are kept separate so corpus drift is visible
  rather than silently converted into a green result.

## 7. Keep a no-network path honest

**Decision:** The documented offline gate runs only deterministic suites and
  never attempts embeddings or a model call.

**Why:** A command named `--offline` must work on a clean machine without
  credentials or network access. Live retrieval quality remains a separate,
  explicitly configured check.

**Tradeoff:** Offline checks cannot prove embedding quality. They prove the
  contracts that do not require a live service and make that boundary explicit.

## 8. Use a read-only recruiter demo

**Decision:** Provide seeded content behind a server-enforced read-only account.

**Why:** Recruiters should be able to inspect the product without creating an
  account, adding payment information, spending generation credits, or changing
  real teacher data.

**Tradeoff:** The demo needs stable fixture records and an explicitly configured
  deployment secret. It must never be implemented as a frontend-only convention.
