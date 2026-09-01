# FlexedAcademy — standards-grounded lesson plans

A retrieval-augmented generation pipeline that drafts weekly lesson plans
**grounded in real standards documents**, not in an LLM's memory of what
standards probably say, and delivers them as the district's own .docx.

Every generated claim about a standard traces back to a chunk of an actual
source document, with a code and a page/section citation.

## Why RAG instead of just prompting Claude

Ask a model "what is Alabama ELA standard 14 for grade 11?" and it will answer
fluently and often wrongly — standard numbering is arbitrary, low-frequency text
that models compress badly. RAG changes the question from *recall* to *reading
comprehension*: we retrieve the verbatim standard text first, then ask the model
to write a lesson section using only what it was handed. Hallucinated standard
codes become a checkable failure rather than an invisible one, which is exactly
what the eval harness and the post-generation grounding audit check.

## Status

Multi-teacher, deployed. React frontend + FastAPI backend, served from one
process (the API also serves `frontend/dist`). Postgres/Supabase with pgvector;
sessions are signed cookies with PBKDF2 or Google OAuth.

The frontend is organised around the WEEK, not around a chat. Home is the year
as a five-column grid; each week has its own URL (`/c/:classId/week/:n`) and is
where generation happens. Chat is a separate destination for thinking a week
through, on `/api/chat_stream`. Mobile is review-and-check: read the plan as day
cards, check the citations, download the .docx — building a plan is desktop.

As of 2026-08-04 the corpus is no longer AP Lang only: all 11 Alabama Course of
Study subject frameworks are ingested for **grades 9-12** (2,997 standards; 11,435
chunks in the store with AP Lang and ACT). K-8 is deliberately excluded — this is a
high school app — and is one flag away if that changes. AP Lang remains the
calibrated, fully-tested path; see "Multi-subject" below for what is and isn't
trustworthy in the rest.

| Step | What | State |
|---|---|---|
| 0 | Environment + git | done |
| 1 | Parse + chunk 3 source docs (164 chunks, all `verbatim_ok`) | done |
| 2 | Embed + store in pgvector | done |
| 3 | Grounded retrieval — relevance floor, per-source-type, query expansion | done |
| 4 | Generation with citation constraint + post-hoc grounding audit | done |
| 5 | FCS `.docx` output via the canonical `build-lesson-plan` skill | done |
| 6 | Eval harness — retrieval, floor, docx contract, generation | done |
| 7 | Web UI: chat, plans library, standards browser, class settings | done |
| 8 | All 11 Alabama COS frameworks (grades 9-12) via the ALSDE CASE feed, PDF-verified | done |

## Running it

```bash
./run.sh                      # backend on 127.0.0.1:8010
cd frontend && npm run dev    # UI on :5174, proxies /api to the backend
```

Port 8010, not 8000: the local oMLX LLM server owns 8000 on this machine.
`OPENAI_API_KEY` in `.env` is required for generation and transcription —
see `.env.example` for every setting and its default.

```bash
python scripts/05_eval_harness.py --offline   # retrieval + floor + docx, no API key
python scripts/06_threshold_sweep.py          # re-tune the floor (AP_Lang by default)
curl localhost:8010/api/health                # diagnose any misconfiguration
curl localhost:8010/api/frameworks            # what subjects/grades are loaded
```

Refresh the project snapshot in the Obsidian vault after meaningful work:

```bash
./venv/bin/python scripts/sync_obsidian_flexed.py
```

The sync exports Git status and recent commit history only. It does not copy
source code, secrets, databases, logs, or generated binaries into Obsidian.

Iris_OS-wide capture runs automatically in the background. The shared command
is optional when you want an immediate or curated summary, decision, artifact,
or next step:

```bash
python3 "../../Scripts/sync_iris_obsidian.py" \
  --project flexed-academy \
  --summary "Describe what changed and why" \
  --next "State the next action"
```

The repository's tracked `.githooks/post-commit` hook also records each commit
subject in the Obsidian activity log once hooks are enabled locally:

```bash
git config --local core.hooksPath .githooks
```

This is connective metadata, not a second source tree: code, secrets, data,
logs, and generated binaries stay in the repository or their appropriate
external stores.

Rebuilding the corpus from scratch:

```bash
python scripts/01_parse_chunks.py             # AP Lang + ALCOS Grade 11 -> chunks.json
python scripts/01b_ingest_act_standards.py    # ACT -> act_chunks.json
python scripts/01d_ingest_alcos_case.py       # 11 Alabama frameworks, grades 9-12
#   ... --grades 0-12                        # widen to K-12 if ever needed
python scripts/02_embed_store.py              # full rebuild of the vector store
```

`02_embed_store.py` now **rebuilds by default** rather than upserting. It used to
add to whatever was already in the collection, so the store accumulated rows from
runs whose chunk files had since been overwritten — the live collection held
12,085 chunks that no file in the repo could account for, two of them hand-written
placeholder standards (`SCI.9.1`, `MATH.10.1`) seeded by a scaffolding script.
`/api/health` reports `chunks`; if that disagrees with the corpus, the store is
not reproducible from the repo and should be rebuilt.

Re-run the threshold sweep if the embedding model or chunking ever changes —
`RETRIEVAL_MAX_DISTANCE` is specific to `text-embedding-3-small` in pgvector cosine space
and means nothing otherwise.

## How grounding actually works

Three layers, because no single one is sufficient:

1. **Relevance floor** (0.65, measured not guessed). Off-domain queries — algebra,
   recipes, gibberish — sit at 0.82+ and are refused outright rather than answered
   from the nearest five standards.
2. **Prompt constraints** from `source_docs/KNOWN_GAPS.md`. A floor cannot catch
   "give me Unit 8 skills": that query returns real, in-domain, wrong-for-the-question
   standards at distance 0.52. Only an explicit rule catches it.
3. **Post-generation audit.** Every standard code in the output is checked against
   what retrieval actually supplied. Anything else is flagged in the UI margin.
   This is the only layer that is verifiable after the fact rather than trusted.

Plus a **scope guard**: a query naming a grade other than 11 is refused. "Grade 9
ELA standards" measures 0.411 — nearer than most genuinely relevant queries,
because the corpus *is* ELA standards — and since every grade re-uses standard
numbers 1–30, answering it would be confidently wrong.

And **query expansion**: teacher phrasing embeds badly against abstract skill
statements. "Week 6 voice and tone with The Cask of Amontillado" puts every AP
skill at 0.81–0.89, outside the floor; rephrased as "how word choice and syntax
convey tone" the same skills land at 0.41. Without this the generator gets no AP
codes and invents them — it once produced "2.C", a code the parser notes does not
exist.

## Multi-subject

The Subject Framework and Grade Level dropdowns in **My Class** are built from
`/api/frameworks`, which is derived from the chunks — a framework is offered only
while it is actually ingested, so the UI cannot present a subject retrieval would
fail to ground. Retrieval filters on `course` + `grade` before distance, which is
what lets 12 frameworks share one collection without competing.

Two things to know before trusting a non-AP-Lang subject:

1. **The 0.65 relevance floor is calibrated for AP Lang and does not transfer.**
   Math, Science and PE measurably fail to reject off-domain input at that floor (Math
   grounds gibberish at 0.746). Per-course floors exist (`RETRIEVAL_FLOORS`) but
   are deliberately unset until measured. Run
   `python scripts/06_threshold_sweep.py --course Math --grade 11`.
   The floor is a property of the **corpus**, not the subject: PE was safely
   outside it at 0.887 until the corpus narrowed to grades 9-12. Re-measure after
   any change to grade scope, chunking, or embedding model.
2. **PDF verification is 93.3% overall, not 100%** — and 61% for Physical
   Education. ELA is 100%. Every chunk carries `verbatim_ok` / `wordwise_ok` and a
   reason when it misses.

Both are written up in full in `source_docs/KNOWN_GAPS.md`. Per-framework numbers
are in `source_docs/ALCOS_INGEST_REPORT.json`.

### Why the CASE feed rather than parsing the PDFs with an LLM

The Course of Study PDFs in `../_Shared/Alabama Standards/` are the documents of
record. They are also published as CASE 1.0 packages by ALSDE itself at
`alabamastandards.org` (the site ALEX embeds under "Standards"), and each
package's `officialSourceURL` names the PDF it was cut from.

Feeding 300-page PDFs to gpt-5.6-luna — as `01_parse_universal.py` does for small
targeted documents — would put a paraphrase risk on every one of ~7,500 standards
and cost real money on every rebuild. The CASE feed is the state's own structured
copy of the same text with no model in the loop, so the standard text is
authoritative by construction. The PDFs are still used, as the verification
target.

Note that ALEX itself hosts no PDFs and offers no PDF export — it serves standards
as CASE JSON and Canvas/PowerSchool CSV. The PDFs come from
`alabamaachieves.org/acad-stand/`.

## Source documents

The three original AP Lang sources live in `source_docs/`; the Alabama frameworks
are cached CASE packages in `source_docs/case/` verified against the PDFs in
`../_Shared/Alabama Standards/`.

1. **`alcos_ela.pdf`** — Alabama Course of Study: English Language Arts, 147pp,
   all grades. Only **Grade 11** content standards (pp. 134–139, standards 1–30
   across Critical / Digital / Language / Research Literacy) are in scope, plus
   the **Recurring Standards for Grades 9–12** (R1–R7), tagged separately.
2. **`APLangSkills.pdf`** — AP Lang skills by strand (RHS, CLE, REO, STL) →
   Reading/Writing sub-skill → lettered codes (1.A … 8.C).
3. **`act-english-standards.md`** — ACT English/Writing reporting categories
   (TOD, ORG, KLA, SST, USG, PUN) with codes grouped by score band.

### Known gaps in the sources — do not paper over these

- `APLangSkills.pdf` covers **Units 1–7 of 9 only.** Units 8–9 skills are
  absent. No codes are fabricated for them; the gap is recorded in
  `source_docs/KNOWN_GAPS.md` and surfaced by the parser.
- ACT markdown: the **"Ideas for Progress"** category has no codes, and ACT
  **Reading**-specific codes (distinct from English/Writing) are not included.
- Content-integrity caveat: an earlier version of the AP Lang skills document
  was run through an AI "cleanup" tool that silently altered standard *content*
  and left assistant artifact text behind. Nothing in this pipeline rewords a
  standard. Parsing normalizes structure only (whitespace, headers, code
  labels); substantive text is carried through verbatim, and step 1 includes a
  side-by-side raw-vs-parsed spot check before any of it is trusted.

## Metadata schema

Every chunk carries:

```json
{
  "code": "2.A | TOD 502 | R3 | Grade11-14",
  "description": "verbatim standard text",
  "course": "AP_Lang",
  "grade": 11,
  "state": "AL",
  "source_type": "state_course_of_study | ap_skills | act_standards | act_recurring",
  "source_document": "filename",
  "source_page_or_section": "traceability back to the original"
}
```

`course` / `state` / `grade` are populated with one value each in Phase 1. They
exist anyway because Phase 2 scopes retrieval by them for other teachers and
courses — adding a metadata field to a populated vector store later means a full
re-index, so it is much cheaper to carry them from the first commit.

## Layout

```
FlexedAcademy/
  backend/           FastAPI app
    routes/          auth, classes, generate, plans, standards, curriculum, misc
    schoolcal.py     reads context/calendars/<school_id>.md -> weeks AND days
    db.py            Postgres + pgvector, append-only MIGRATIONS list
  frontend/src/
    pages/           CalendarPage, WeekPage, ChatPage, ClassPage, auth/, onboarding/
    components/      AppShell, calendar/YearGrid, PlanDayCards, LessonPlanTable, …
    hooks/useAppData.js   TanStack Query layer (there is no global store)
    lib/             breakpoints, planShape, queue, dates, queryKeys, api
    styles/tokens.css     the single source of truth for design tokens
  scripts/           01_parse_chunks.py … 05_eval_harness.py
  eval/              eval test cases
  venv/              gitignored
```

`npm run check` in `frontend/` runs lint, then two custom checks that fail the
build: `check-tokens.mjs` (a `var(--x)` used but never declared) and
`check-classes.mjs` (a semantic className no stylesheet defines — the bug that
left the crash screen rendering unstyled for months).

This project **does** sit inside Google Drive (it lives under `Iris_OS/Projects/`),
which the original note here said it wouldn't. What actually matters is which
files are exposed to sync:

- `venv/` and `node_modules/` are gitignored and rebuildable. Note that the venv
  bakes an absolute path into `pyvenv.cfg`, so MOVING this folder breaks it —
  recreate with `python3 -m venv venv && venv/bin/pip install -e .` rather than
  wondering why psycopg2 has vanished.
- **The database is not in the tree at all** — it is Postgres (Supabase), which
  removes the old SQLite-on-Drive hazard entirely: WAL mode kept `-wal`/`-shm`
  sidecars that Drive uploaded independently and forked into `app.db (1)`.
- Generated `.docx` in `plans/` are the opposite case: written once then read, so
  syncing them is the point.

Git (private GitHub remote) is still the backup mechanism.
