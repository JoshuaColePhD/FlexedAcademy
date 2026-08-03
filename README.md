# AP Lang RAG Lesson Plan Generator — Phase 1

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
what the eval harness in step 6 checks.

## Status

Phase 1 (local, single-user, my own AP Lang class). No web UI, no multi-user, no
cloud vector store — those are Phase 2–4.

| Step | What | State |
|---|---|---|
| 0 | Environment + git | done |
| 1 | Parse + chunk 3 source docs | in progress |
| 2 | Embed + store in Chroma | not started |
| 3 | `retrieve(query, top_k)` | not started |
| 4 | Generation with citation constraint | not started |
| 5 | FCS `.docx` output (via existing Iris_OS lesson-plan skill) | not started |
| 6 | Eval harness | not started |

## Setup

```bash
cd ~/Projects/ap-lang-rag
source venv/bin/activate
python -c "import chromadb, sentence_transformers, anthropic"   # sanity check
```

Python 3.12.13. Dependencies: `chromadb`, `sentence-transformers`, `pypdf`,
`anthropic`, `python-docx`.

An `ANTHROPIC_API_KEY` is **not** needed for steps 1–3 — embeddings run locally
on `all-MiniLM-L6-v2`. It becomes necessary at step 4 (generation).

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

Not in iCloud or Google Drive on purpose: `venv/` is ~20k small files and
`chroma_db/` is a live SQLite database — both behave badly under file sync.
Git is the portability mechanism instead.
