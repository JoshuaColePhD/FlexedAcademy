# FlexedAcademy: Grounded AI Lesson Planning

## Product

FlexedAcademy is an AI lesson-planning platform for high-school teachers. A teacher describes the week they need, and the system produces a structured, standards-aligned plan that can be reviewed in the browser and exported into a district-style Word document.

The product challenge is not simply generating fluent prose. Standards contain low-frequency identifiers, repeated numbering schemes, and course-specific meanings. A plausible-looking citation can still be wrong, so the system treats retrieval, validation, and refusal as product behavior.

## Architecture

The application is a React/Vite frontend backed by a FastAPI service. Postgres/Supabase stores tenant-scoped users, classes, plans, source metadata, and generated artifacts; pgvector supports semantic retrieval. OpenAI embeddings support indexing and query retrieval, while structured generation produces a predictable lesson-plan contract.

```text
Teacher request
  → class/course/grade resolution
  → query expansion and embedding
  → scoped pgvector retrieval
  → relevance floor and scope checks
  → grounded context in the model prompt
  → strict structured lesson-plan response
  → schema validation and citation audit
  → persistence and DOCX generation
```

The frontend receives streamed progress through Server-Sent Events. The backend keeps the durable write path separate from the stream: a completed plan is validated, persisted, and queued for document generation rather than treating a partial response as finished work.

## Grounding and failure behavior

The retrieval layer stores source text and source metadata, filters by course and grade, expands underspecified queries, and applies a relevance floor. The grounding audit then classifies citations as grounded, non-retrieved, borrowed from another scope, or hallucinated. The application can refuse an out-of-scope request instead of manufacturing a confident citation.

This makes a request traceable end to end:

- Retrieval returns candidate standard chunks and their source identifiers.
- Generation receives only the accepted, scoped context plus the response schema.
- Validation enforces required fields, allowed engagement strategies, and plan shape.
- The grounding audit checks that cited codes are supported by retrieved material.
- Storage records the validated plan, ownership, source identifiers, and document status.
- The frontend displays the plan, citations, warnings, and recoverable errors.

## Evidence and evaluation

The repository includes deterministic unit, contract, retrieval, grounding, security, and artifact tests. The recorded retrieval baseline contains 143 teacher-style cases:

```text
Recall@5:  138 / 143
Recall@60: 142 / 143
```

The current standards corpus contains 2,997 standards and 11,435 chunks across 11 Alabama frameworks for grades 9–12. AP Language is the most thoroughly calibrated path; the README documents that limitation rather than implying uniform performance across every course.

## What is genuinely impressive

The strongest part of the project is the complete applied-AI loop: source ingestion, retrieval, structured generation, validation, grounding audits, tenant-aware persistence, streaming UX, and document export are connected as one product. It demonstrates the engineering judgment required to make an LLM feature inspectable and usable, not just a prompt that returns attractive text.

## Known tradeoffs

The system still depends on external model and embedding APIs, and a grounded citation does not guarantee that every instructional activity is pedagogically optimal. AP Language has the deepest calibration and evaluation coverage. Generated plans should be reviewed by a qualified teacher before distribution, and users should not enter student-identifying information into prompts.

## Links

- [Public GitHub repository](https://github.com/JoshuaColePhD/FlexedAcademy)
- [Live product](https://flexedacademy.com)
- [Product walkthrough video](./FlexedAcademy_Walkthrough.mp4)
- [Sample generated lesson plan](./FlexedAcademy_Sample_Lesson_Plan.docx)

## Optional live demo

The deployed sign-in page can expose a free, read-only “Explore demo” for
recruiters and potential customers. It is
configured with `DEMO_ACCOUNT_EMAIL` and `DEMO_ACCOUNT_PASSWORD` in deployment
secrets, then provisions a seeded AP Language example account. Recruiters can
browse the application, plan history, citations, and document export without
creating an account, adding a payment method, running the code locally, or
consuming generation credits. Server-side middleware rejects all mutations for
that account, including generation, uploads, edits, sharing, and billing.
