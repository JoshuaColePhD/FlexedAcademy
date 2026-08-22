# Known gaps in the source documents

Recorded so the pipeline never fabricates coverage it does not have. The
retrieval and generation steps are expected to say "no relevant standard was
retrieved" rather than invent a code — these are the places where that is the
*correct* answer.

## AP Lang skills — Units 8 and 9 missing

`APLangSkills.pdf` is titled "AP English Language — Unit 1-7 Skills" and covers
Units 1–7 of 9. Skills introduced in Units 8–9 are absent. Codes 1.A–8.C are
complete *as scoped to Units 1–7*; the frequency counts are Units 1–7 counts
only and will understate a skill's true course-wide weight.

No codes are invented for Units 8–9. A query about Unit 8 or 9 content should
retrieve nothing from `ap_skills` and the generator should say so.

**To close:** source the Units 8–9 skills page from the same Bedford/Freeman &
Worth publisher material, add to `source_docs/`, re-run steps 1–2.

## ACT Standards — Math, Reading, and Science freshly scraped; English unchanged

Previously, ACT standards were missing or truncated (missing Reading codes,
missing Math/Science). As of 2026-08-22, three of the four core ACT sections —
**Math, Reading, and Science** — have been directly scraped from `act.org` via
HTML tables (`scripts/01b_scrape_act_standards.py`) into local ground-truth
files (`act-math-standards.md`, `act-reading-standards.md`,
`act-science-standards.md`). No LLM is in that extraction path, so these three
are deterministic and citable with zero hallucination risk.

**English was NOT re-scraped** — `scripts/01b_scrape_act_standards.py`'s `URLS`
dict only has Math, Reading, and Science entries. `act-english-standards.md`
is still the same file "pasted by Josh 2026-08-03" from the district's own ACT
reference (verified unchanged — same content, same file timestamp). That file
was already fine on its own terms (see the "Ideas for Progress" gap below,
which is a property of that original paste, not a new problem); the
`act-english-standards.CONTAMINATED.md` file in `quarantine/` is a *different*,
already-excluded document (AI-altered AP Lang skills mislabeled as ACT
English) and was never part of what changed today. Recorded here because an
earlier version of this note claimed all four sections were freshly scraped,
which overstated what actually happened — worth closing for real if English
coverage needs the same act.org-sourced treatment as the other three.

- **English** is mapped to `AP_Lang` and `ELA`.
- **Math** is mapped to `Math`.
- **Science** is mapped to `Science`.
- **Reading** is mapped dynamically to `Social_Studies`, `AP_Lang`, and `ELA` courses (e.g., History courses).

*Note: The "Ideas for Progress" sections found in older reference sheets are supplementary suggestions, not citable standards with codes, and are out of scope for the grounding pipeline.*

## ALCOS — Grade 11 only, for the `alcos_ela.pdf` parse

`alcos_ela.pdf` covers all grades K–12 across 147 pages. Only Grade 11 (PDF pp.
133–138) plus the Grades 9–12 Recurring Standards are parsed by
`01_parse_chunks.py` into the `AP_Lang` course. Grades 9, 10, and 12 are
deliberately excluded from *that* parse — this is scope, not a gap. Note that each
grade re-uses standard numbers 1–30, so grade must always be part of a chunk's
identity, never the bare number.

Grades 9, 10 and 12 **are** now covered, separately, by the `ELA` framework — see
below. The two do not conflict: `AP_Lang` holds the hand-audited Grade 11 parse
with its `Grade11-*` codes, `ELA` holds the state's `ELA21.*` codes for all four
high school grades, and retrieval filters by course so a request only ever sees
one of them.

## Alabama Course of Study frameworks — coverage and caveats

Added 2026-08-04 by `01d_ingest_alcos_case.py`: 11 frameworks, **grades 9-12
only**, 2,997 standards, 10,363 chunks (one per grade a standard covers),
alongside the original AP Lang and ACT chunks — 11,435 in the store in total.

Source is the ALSDE CASE 1.0 feed at `alabamastandards.org` — the state's own
structured copy of the same documents in `_Shared/Alabama Standards/`, with no LLM
in the extraction path. Each framework's `officialSourceURL` names the PDF it was
cut from.

Grade scope is a deliberate default, not a gap: this is a high school app, so K-8
is dropped at ingest rather than filtered at query time. That keeps the store, the
Standards browser and the Grade Level dropdown agreeing on what exists, instead of
carrying 9,000 chunks no teacher here can select. Widen it with `--grades 0-12`
(K-12 measures 19,701 chunks) and re-run `02_embed_store.py`.

### Verification against the PDFs is not 100%, and the number means something

Every statement is checked two ways against `pdftotext` output of the local PDF:
byte-exact (`verbatim_ok`) and words-in-order ignoring punctuation
(`wordwise_ok`). Across grades 9-12: **91.3% byte-exact, 93.3% wording intact,
6.7% unmatched.** (K-12 was 87.7% / 90.5% — the elementary grades are laid out in
denser tables and extract worse, so narrowing to high school improved this.)

A miss is *not* a fabricated standard — there is no model that could have
fabricated one. Causes, in order of frequency:

- **Table reflow.** Poppler emits table cells in an order the sentence doesn't
  follow. Harmless.
- **Punctuation drift in the feed.** ALSDE wrote `less/fewer than ,` with a space
  before the comma; the PDF has none. Harmless, and why `wordwise_ok` exists.
- **The feed and the PDF genuinely disagree.** These are real and worth knowing:
  `PE19.K.1.2` reads "first appear in grade 2" in the feed and "grade 3" in the
  PDF; several PE list items lose an "and" where a bulleted list was flattened
  into one string. When in doubt, **the PDF is the document of record.**
- **PDF revision skew.** The Science CASE package cites the 2023 V1.0 file while
  ALSDE now ships V1.1 (which is what we hold).

Per-framework rates are in `source_docs/ALCOS_INGEST_REPORT.json`. Chunks that
miss carry the reason in `notes` and are surfaced in the Standards browser, so a
teacher can check any individual standard against the PDF.

Worth singling out: **Physical Education is 50.8% byte-exact / 61.2% wording.**
That is far below every other framework and is dominated by the "APE
Recommendations" rows. Do not treat PE standard text as PDF-faithful without
checking it. Math (85.1% wording) and Counseling (83.0%) are the next weakest.

**ELA — Josh's actual subject — is 100% byte-exact and 100% wording intact at
grades 9-12.** So are DLCS and Social Studies (wording), with Health at 100%
wording and Science at 99.2%.

### The relevance floor is calibrated for AP Lang only

`RETRIEVAL_MAX_DISTANCE=0.78` was measured against the AP Lang corpus and **does
not transfer to every framework.** Re-measured 2026-08-04 against the grade 9-12
corpus — nearest off-domain match, versus the hardest in-domain probe:

| Framework | Hardest in-domain | Nearest off-domain | Safe at 0.78? |
|---|---|---|---|
| Health | 0.528 | 0.884 | yes |
| Counseling | 0.385 | 0.884 | yes |
| Social Studies | 0.449 | 0.875 | yes |
| Arts | 0.254 | 0.858 | yes |
| AP Lang | 0.462 | 0.838 | yes |
| ELA | 0.488 | 0.838 | yes |
| DLCS | 0.546 | 0.827 | yes |
| Math (Algebra w/ Finance) | 0.352 | 0.827 | yes |
| World Languages | 0.359 | 0.812 | yes |
| **PE** | 0.380 | **0.762** | **no** |
| **Science** | 0.407 | **0.752** | **no** |
| **Math** | 0.468 | **0.746** | **no** |

For Math, Science and PE the floor does not reject off-domain input: Math grounds
`asdf qwerty zxcv` at 0.746, Science grounds "pizza recipe with sourdough crust"
at 0.752. A lesson request in those three could be answered from irrelevant
standards rather than refused.

**The floor is a property of the corpus, not of the subject.** PE measured 0.887 —
comfortably safe — while K-8 was loaded, and moved inside the floor when the corpus
narrowed to grades 9-12. Re-measure after any change to grade scope, framework set,
chunking, or embedding model.

**Closed 2026-08-22.** Real teacher-phrased positives were written for each of
the three (`PER_COURSE_POSITIVES`/`PER_COURSE_OFF_DOMAIN` in
`scripts/06_threshold_sweep.py` — the script's own AP-Lang-flavored defaults
are meaningless for these subjects; half the default OFF_DOMAIN list is
actually in-domain for Math and Science). Re-measured and set in `.env`:

```
RETRIEVAL_FLOORS='{"Math": 0.52, "Science": 0.55, "PE": 0.60, "AP_Lang": 0.64}'
```

Math (0.407 .. 0.624) and PE (0.498 .. 0.697) both have a wide, comfortable
margin. **Science's margin is narrow (0.525 .. 0.583, 0.058 wide)** — the first
off-domain probe tried, "balancing chemical equations in stoichiometry",
turned out not to be off-domain at all (`SC23.CHEM.4` is a real Alabama
Science standard covering exactly stoichiometric ratios), which is itself the
useful finding: the general ALCOS Science course's own Chemistry strand sits
close enough to genuinely-off-domain chemistry-flavored queries that this
floor has less room for future drift than the other two. Re-measure this one
first if grade scope, chunking, or the embedding model ever change.

AP_Lang got its own override rather than inheriting a fresh global default:
its underlying content changed today (`AP English Language and Composition`
was re-ingested from the real CED, replacing what the original 0.78
measurement below was run against), so re-measuring it produced 0.64 — a real
drift caused by new content, not a mistake in the original 0.78 measurement.

Separately, closed 2026-08-22: `RETRIEVAL_MAX_DISTANCE` was documented as
"measured at 0.78" below but was **never actually set** in the real `.env` —
only in `.env.example` as a template — so every course without its own
`RETRIEVAL_FLOORS` entry (every ALCOS framework except AP_Lang above, every
individual AP course, everything) had been running on
`backend/config.py`'s fallback default of 0.65 since this table was written.
0.65 is tighter than every "safe at 0.78" framework's own hardest in-domain
probe below, so nothing was made unsafe by that gap — but it could have been
silently rejecting legitimate in-domain queries for any framework whose
hardest positive fell between 0.65 and 0.78 (this table's own AP Lang row
shows 0.462, safely under 0.65, but KNOWN-GAP-adjacent jargon-heavy AP Lang
phrasing was separately measured up to 0.71-0.73 — right in the gap). Now set
to 0.78 for real.

### School Counseling is structurally odd

The CASE package types both its 12 domain *labels* and all ~190 of its actual
standards as `Domain`. The ingest resolves this by graph shape (a labelled node
with children is scaffolding; a leaf that reads like a sentence is a standard)
rather than by type name. If ALSDE restructures that package, re-check the count.

### Not ingested

- **Career & Technical Education** — 16 cluster frameworks, available in the same
  CASE feed and as PDFs at `alabamaachieves.org/cte/cte-course-of-study/`.
- **Alternate Achievement Standards (AAS)**, **WIDA**, and the **ACT/NAEP
  assessment frameworks** listed on `alabamastandards.org`.
- **Superseded editions** (2010 Social Studies, 2015 Science, 2017 Arts, 2018
  DLCS, 2009 PE). PDFs are kept in
  `_Shared/Alabama Standards/_Superseded/` but only Algebra with Finance (2015)
  is ingested, as `Math_AWF`.
- **Grades K-8.** Present in the same CASE packages and one flag away
  (`--grades 0-12`); excluded because this is a high school app.

## AP French, German, and Italian Language & Culture — no standards at all

Checked 2026-08-22 against ALSDE's own course catalog
(`RD_edurep_subcode_202199_CourseCodeList_v1.0.pdf`, ALSDE course codes
24114E1000, 24264E1000, etc.): these are ALSDE-recognized, offerable AP courses.
Every other College Board world-language course in that catalog (Chinese,
Japanese, Latin, Spanish Language, Spanish Literature) has an ingested
CED and its own course identity here. French, German, and Italian do not — no source PDF
was ever pulled for them. If a Florence class is taught under these course
names, retrieval returns nothing to ground it, which is the correct behavior
(no codes exist to fabricate), not a bug in retrieval.

**To close:** source each CED PDF from College Board, add to `source_docs/`,
re-run steps 1–2 the same way AP Chinese/Japanese/Latin were ingested.

## Quarantined file

`source_docs/quarantine/act-english-standards.CONTAMINATED.md` — supplied under
the ACT filename but actually AI-altered AP Lang skills, with fabricated
standard text and assistant chat output embedded in it. Kept for the record,
excluded from parsing. See `SPOT_CHECK_step1.md` findings 1–3.
