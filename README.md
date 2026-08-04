# AP Lang Planner — standards-grounded lesson plans

A retrieval-augmented generation pipeline that drafts AP Language & Composition
lesson plan sections **grounded in real standards documents**, not in an LLM's
memory of what standards probably say.

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

Local, single-user, my own AP Lang class. There is a web UI (React) and a FastAPI
backend; multi-user and a cloud vector store are still out of scope.

| Step | What | State |
|---|---|---|
| 0 | Environment + git | done |
| 1 | Parse + chunk 3 source docs (164 chunks, all `verbatim_ok`) | done |
| 2 | Embed + store in Chroma | done |
| 3 | Grounded retrieval — relevance floor, per-source-type, query expansion | done |
| 4 | Generation with citation constraint + post-hoc grounding audit | done |
| 5 | FCS `.docx` output via the canonical `build-lesson-plan` skill | done |
| 6 | Eval harness — retrieval, floor, docx contract, generation | done |
| 7 | Web UI: chat, plans library, standards browser, class settings | done |

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
python scripts/06_threshold_sweep.py          # re-tune the relevance floor
curl localhost:8010/api/health                # diagnose any misconfiguration
```

Re-run the threshold sweep if the embedding model or chunking ever changes —
`RETRIEVAL_MAX_DISTANCE` is specific to `all-MiniLM-L6-v2` in Chroma's L2 space
and means nothing otherwise.

## How grounding actually works

Three layers, because no single one is sufficient:

1. **Relevance floor** (0.78, measured not guessed). Off-domain queries — algebra,
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

## Source documents

All three live in `source_docs/` (copied from `~/Desktop/AP_LANG_RAG/`).

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
ap-lang-rag/
  source_docs/       three source documents + KNOWN_GAPS.md
  scripts/           01_parse_chunks.py … 05_eval_harness.py
  chroma_db/         persistent vector store (gitignored, rebuildable)
  eval/              eval test cases
  venv/              gitignored
```

This project **does** sit inside Google Drive (it lives under `Iris_OS/Projects/`),
which the original note here said it wouldn't. What actually matters is which
files are exposed to sync:

- `venv/` (~1.3 GB, ~20k small files) and `chroma_db/` are gitignored and
  rebuildable. Chroma survives sync because it is effectively read-only in normal
  use; if Drive ever leaves a conflict copy, delete the directory and re-run
  `scripts/02_embed_store.py`.
- **`app.db` lives outside the synced tree** — `~/Library/Application
  Support/ap-lang-rag/app.db` by default. SQLite in WAL mode keeps `-wal` and
  `-shm` sidecars that must stay mutually consistent; Drive uploads them
  independently and makes `app.db (1)` on conflict. It holds the only
  irreplaceable data here (your plans and conversations), so it stays out.
- Generated `.docx` in `plans/` are the opposite case: written once then read, so
  syncing them is the point.

Git (private GitHub remote) is still the backup mechanism.
