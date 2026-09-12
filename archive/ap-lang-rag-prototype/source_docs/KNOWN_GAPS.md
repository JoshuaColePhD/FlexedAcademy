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

## ACT — "Ideas for Progress" category has no codes

The ACT source was cut off mid-paste where a fifth category, "Ideas for
Progress," began. Only score-range column headers (1–12 through 28–32) came
through; no codes or descriptions. Nothing from this category is citable.

## ACT — Reading-specific codes not included

The ACT file covers **English/Writing** only (TOD, ORG, KLA, SST, USG, PUN).
ACT **Reading** codes are a separate set and are not here.

This matters concretely: `build-lesson-plan/reference/ap-lang-curriculum.md`
cites ACT codes in the `CLR` and `IKI` families (e.g. "CLR 501", "IKI 601").
Neither family appears in the ACT English/Writing file. Those codes **cannot be
grounded in any document we currently hold** — if a generated lesson plan needs
one, it must come from a source we don't have yet.

## ALCOS — Grade 11 only

`alcos_ela.pdf` covers all grades K–12 across 147 pages. Only Grade 11 (PDF pp.
133–138) plus the Grades 9–12 Recurring Standards are parsed. Grades 9, 10, and
12 are deliberately excluded — this is scope, not a gap. Note that each grade
re-uses standard numbers 1–30, so grade must always be part of a chunk's
identity, never the bare number.

## Quarantined file

`source_docs/quarantine/act-english-standards.CONTAMINATED.md` — supplied under
the ACT filename but actually AI-altered AP Lang skills, with fabricated
standard text and assistant chat output embedded in it. Kept for the record,
excluded from parsing. See `SPOT_CHECK_step1.md` findings 1–3.
