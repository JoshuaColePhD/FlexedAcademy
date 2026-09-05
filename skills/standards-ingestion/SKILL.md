---
name: standards-ingestion
description: "Ingest or refresh a U.S. state's academic standards in FlexedAcademy using verified official sources, state-specific parsing, deterministic quality gates, provenance, cached embeddings, staged vector storage, and safe live cutover. Use when adding a state or refreshing an existing standards corpus; not for ordinary retrieval tuning."
---

# State Standards Ingestion

Use this skill to add a state standards corpus to FlexedAcademy without making
state-specific assumptions part of the shared ingestion path.

The reusable contract is:

`official sources -> state adapter -> normalized chunks -> quality gate -> cached embeddings -> staged database -> retrieval checks -> atomic cutover`

Keep each state's source manifest, parser, and quality rules separate. Reuse the
shared embedding and staging workflow wherever the normalized chunk contract is
compatible.

## Before changing anything

- Inspect the repository's current ingestion scripts, database schema, and
  existing state adapters.
- Identify the state's official standards publisher and the authoritative
  framework, course, grade-band, and version identifiers.
- Prefer a machine-readable official source such as CASE, JSON, XML, or XLSX.
  Use PDFs only when they are the authoritative source or no reliable structured
  source exists.
- Record source URLs or file paths, retrieval dates, versions, licenses or usage
  notes, and SHA-256 hashes in the state manifest. See
  [state-adapter.md](references/state-adapter.md).
- Do not guess a course, grade, framework, or code mapping. Stop and report an
  unmapped source instead.

## Build a state adapter

Create a state-specific manifest and parser rather than adding conditionals for
the new state to an Alabama-specific script. The adapter must emit the shared
chunk shape used by `scripts/02_embed_store.py`:

- stable `id` derived from state, framework, course identity, grade or grade
  band, and standard code;
- exact source wording in `document`;
- metadata containing at least `state`, `course`, `grade`, `code`,
  `source_type`, `framework`, `source_version`, source snapshot or package
  hashes, and an ingestion timestamp;
- an explicit distinction between primary course standards and companion
  material such as ACT alignments or AP skills.

The manifest must also carry a **`course_map`**: which `(subject_code, grade)` a
teacher can select binds to which framework, plus an `unmapped` list with a
reason for anything the state does not publish. Author it by reading the state's
own course catalogue against the frameworks the fetch actually returned — never
infer it from the `course` strings a parse happened to emit, which is how one
state's "ELA" silently resolves to another state's idea of ELA. A subject that
cannot be bound with confidence stays unmapped, and a teacher who selects it is
told there are no standards yet rather than handed the nearest-looking framework.

If the same logical ID has different source text, preserve both records with a
deterministic collision suffix and report the collision. Never silently choose
one description.

## Quality gate before embeddings

Add a deterministic `check_<state>_ingest.py` or equivalent gate. It should
check, as applicable:

- every source file is declared and mapped;
- expected frameworks, courses, grade bands, and source types are present;
- required metadata is nonempty and internally consistent;
- standard codes are parseable and stable;
- documents contain source wording rather than parser scaffolding;
- counts are within declared expectations;
- duplicate IDs and differing text are reported;
- source hashes match the manifest;
- no unexpected course or grade leakage occurs;
- the `course_map` is total in BOTH directions — no binding pointing at a
  framework that produced no chunks, and no parsed standard that no binding can
  reach. Each catches a different silent failure: a dangling target is a subject
  whose retrieval finds nothing, and an orphan chunk is a standard that is
  embedded, paid for, and unreachable.

The gate must fail closed on errors. Warnings are acceptable only when they are
explicit, explainable, and recorded in the report. Keep a small fixture or
contract test for the adapter and run the state gate before creating embeddings.

## Embed and stage safely

Use the shared `scripts/02_embed_store.py` after the state adapter has produced
validated processed chunks.

- Use the configured embedding model and dimensions recorded by the script; do
  not mix vectors from different models or dimensions.
- Let the content-addressed local cache reuse vectors for unchanged documents.
- Build ONE state's corpus at a time. Each state has its own table —
  `chunks_al`, `chunks_ga`, plus `chunks_national` for the AP/College Board/ACT
  rows every state shares — registered in `standards_corpora`, which is the only
  place a corpus table name may come from. `scripts/02_embed_store.py --state` is
  how a rebuild says which one it means. Rebuilding one state must not touch
  another state's rows or its index.
- Do not write a full rebuild directly into a live corpus table. The default
  rebuild path must create a uniquely named staging table, load all rows, build
  vector and full-text indexes after loading, validate the staged count, then
  atomically swap it into place.
- Preserve the live table when embedding, database, or index work fails. Clean
  up only the exact failed staging table after verifying its name.
- Treat a live Supabase write as a separate authorized action. Use the project's
  Supabase workflow for DDL and verification; never expose database or API
  secrets in logs, reports, or committed files.

## Validate after cutover

Before declaring the state live, verify all of the following against the live
database:

1. Live row count matches the validated processed corpus.
2. Missing embeddings equal zero.
3. Every row has the expected embedding model, dimensions, and source snapshot.
4. Stable vector and full-text indexes exist on `chunks`.
5. No staging table remains, and `standards_corpora` matches the tables that
   actually exist.
5b. Every state that was NOT being rebuilt still has its original row count.
6. The schema version is unchanged or intentionally migrated.
7. Current-corpus recall passes at top-5 and top-20.
8. Cross-course and off-domain refusal checks pass.
9. The state-specific gate and database-free regression suite pass.

For meaningful retrieval changes, run `eval/test_retrieval_ab.py` or an
equivalent read-only comparison using the same queries for both variants. Report
recall, expected rank, wrong-course hits, false positives, and latency. Do not
call a test a historical corpus comparison unless an old corpus snapshot or
reproducible export actually exists.

## Reporting and stopping conditions

Report the source coverage, row counts, warnings, API usage estimate, and exact
validation results. Distinguish parser/source fidelity from retrieval quality:
perfect retrieval on a weakly parsed source is not a successful ingestion.

Stop before cutover if source identity, course/grade mapping, wording fidelity,
row parity, embedding metadata, or retrieval safety is uncertain. Leave the
live corpus unchanged and report the specific blocker.

Relevant repository entry points:

- `scripts/fetch_state_sources.py` — the ONLY networked step: snapshots a
  state's CASE packages and source PDFs with hashes, and refuses to invent a
  course binding (new frameworks arrive as `course: TODO`)
- `scripts/state_manifests/*.yaml` — one file per state: sources, provenance,
  and the reviewed `course_map`
- `scripts/state_manifest.py` — manifest loader and structural validation
- `scripts/case_adapter.py` — the shared, state-agnostic CASE 1.0 parse
- `scripts/ingest_case_state.py` — the generic driver; `--dry-run` compares a
  re-parse against the previous report and is how a refactor proves it did not
  move an existing state
- `scripts/check_state_ingest.py` — deterministic state quality gate, including
  `course_map` totality
- `scripts/02_embed_store.py --state` — cached embedding and staged cutover for
  one corpus
- `eval/alabama_parity.py` — capture/compare gate proving an existing state's
  retrieval is unchanged across a corpus migration, distances included
- `eval/test_current_golden_recall.py` — current-corpus recall gate
- `eval/test_retrieval_ab.py` — read-only ranking comparison
