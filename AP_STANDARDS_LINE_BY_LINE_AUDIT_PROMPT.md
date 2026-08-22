# System prompt: line-by-line accuracy review of the AP standards re-ingest — FlexedAcademy

Paste everything below into your agent (Gemini Antigravity) as its system/task prompt. It is self-contained: the agent has no memory of any prior conversation about this repo.

---

## Your task

On 2026-08-22, every AP/College Board course in the **FlexedAcademy** standards corpus was re-ingested from scratch, straight from the 40 official College Board Course and Exam Description (CED) PDFs, using a chunked LLM extraction pipeline (`scripts/01c_ingest_ap_ceds.py`). The pipeline already enforces one guarantee automatically: every accepted standard's `description` text is a verbatim (whitespace/punctuation-normalized) substring of its source PDF — anything the model paraphrased instead of quoting exactly was mechanically rejected at ingest time. **You do not need to re-verify that a description's words appear in the PDF; that part is already guaranteed by code, not by trust.**

What is NOT guaranteed, and IS your job to check by actually reading each course's PDF and comparing it against that course's stored chunks:

1. **Correct `code`.** Does the stored code match what the CED itself labels this exact standard (e.g. "CHA-3.E.1", "Skill 2.A", "KC-5.3.I.B")? A code can be a real code from the document while still being attached to the wrong description, or vice versa.
2. **Correct `strand`.** Does the stored strand/unit/topic label match where this standard actually sits in the CED's own structure, not a generic or borrowed label?
3. **Correct course attribution.** Every chunk should genuinely belong to the course it's filed under — not bled in from a neighboring section of the same PDF that covers a different exam component (e.g. a scoring rubric row that isn't actually a course standard).
4. **Completeness relative to the PDF**, course by course: does the set of stored codes look like a reasonable, representative coverage of that CED's own framework (its Units/Topics/Skills/Learning Objectives), or are entire sections of the CED's framework visibly absent from what's stored? (See "Known coverage gaps" below — some of this is already expected and already being backfilled; your job is to find anything BEYOND what's already known.)
5. **Not double-counted or contradictory.** The same code should not appear twice with materially different, non-restated text (a few identical-content repeats across CED units are normal and expected — see "What NOT to flag" below).

## Where the data lives

```
data/processed/ap_chunks.json
```

This file holds every AP/College Board chunk (currently ~5,700-5,900, still growing slightly as known gaps get backfilled — check the current count when you start; don't assume a stale number). Every chunk relevant to you has `"source_type": "college_board"`. Fields:

```
code                    the standard's identifier as YOU should verify it matches the source
description             the standard's text (already verbatim-verified against the PDF)
course                  which course this is filed under (see the mapping table below)
grade                   always 11 (a placeholder default — not meaningful, don't flag it)
source_type             "college_board" for everything you're reviewing
source_document         the exact PDF filename this came from, in data/raw/source_docs/
source_page_or_section  the section header the model reported finding it under — spot-check
                        this against the real PDF, it is model-reported and NOT independently
                        verified the way `description` is
strand                  the unit/topic label — also model-reported, also worth checking
embed_text              a derived display string — ignore, it's just code+strand+description concatenated
```

## Source PDFs and the course-name mapping

Every source PDF is in `data/raw/source_docs/`, named like `ap-<course-slug>-course-and-exam-description.pdf`. The exact mapping from filename to the `course` value used in the data is the `_FILENAME_TO_COURSE` dictionary near the top of `scripts/01c_ingest_ap_ceds.py` — read that dictionary directly rather than guessing from the filename; a few are non-obvious (both `ap-physics-c-mechanics-...pdf` and `ap-physics-c-electricity-and-magnetism-...pdf` map to the single course `"AP Physics C"`; `ap-world-history-modern-...pdf` maps to `"AP World History"`, not "AP World History: Modern").

## What NOT to flag (avoid false positives)

- **The same standard's text repeated verbatim across multiple CED units with only a code/strand difference.** Some AP courses (especially History) restate a generic skill statement (e.g. "Explain how a historical development or process relates to another") once per unit. That's a real, intentional pattern in how College Board writes these documents, not a duplication bug.
- **`grade: 11` on every chunk.** Deliberate placeholder, not a real grade-level claim (AP courses aren't scoped by grade in the same way ALCOS content is). Don't flag this.
- **Chunks with `code` values like bare `"?"` or very short generic codes** for language courses (Chinese, French, German, Italian, Japanese, Spanish, Latin) — these CEDs often describe performance expectations in prose without a College-Board-assigned short code, and the model may not have been able to invent one it could verify. Only flag these if the description text itself looks fabricated or wrong (it shouldn't be, per the verbatim guarantee, but read a sample to be sure).
- **Missing Units 8-9 content for anything unrelated to this ingest** — that's a different, pre-existing, already-documented gap (see `data/raw/KNOWN_GAPS.md`, "AP Lang skills — Units 8 and 9 missing"), not part of what changed today.

## Known coverage gaps already being addressed — don't waste time rediscovering these as if they were new findings, but DO verify they were actually closed by the time you check

The extraction pipeline lost individual batches to request timeouts (not fabrication — the content is just missing, which is the safe failure mode). As of this prompt being written, these had known incomplete coverage and were being backfilled with `scripts/01c_ingest_ap_ceds.py --only "<course name>"` — by the time you run, check the actual current per-course chunk count in `ap_chunks.json` rather than trusting this list, since it may already be resolved:

AP African American Studies, AP Art History, AP Art and Design, AP Computer Science Principles, AP Cybersecurity, AP Latin, AP Macroeconomics, AP Microeconomics, AP Music Theory, AP Physics 2, AP Physics C, AP Precalculus, AP Seminar, AP Statistics, AP Chemistry, AP Physics 1, AP Research, AP Business & Personal Finance, AP Computer Science A, AP Human Geography, AP Environmental Science.

**AP Art and Design specifically has had a persistently, suspiciously low yield across multiple ingest attempts** (as few as 6-8 standards from an 84,000-character source document) even when none of its batches failed outright — this looks like a real problem with how well this particular CED's structure matches the extraction prompt (Art and Design's CED is organized very differently from a typical Skills/Learning-Objectives course — it's largely a portfolio-requirements and scoring-rubric document). Worth a close read of the actual PDF to determine whether 6-8 standards is genuinely all there is to extract, or whether real content is being missed.

## Methodology

For each of the 40 courses:

1. Open its source PDF from `data/raw/source_docs/` and get a real sense of its overall framework structure (how many units, how many total learning objectives/skills/codes it actually defines).
2. Pull every chunk for that course from `ap_chunks.json`.
3. Spot-check a meaningful sample (for a course under ~100 chunks, check all of them; for larger courses, check at least 30-40%, weighted toward anything that looks structurally odd — very short descriptions, codes that don't match the pattern of nearby codes, strands that don't match any real unit name in the PDF) — code and strand against the actual PDF page you can find it on.
4. Note anything wrong per the checklist above, and note overall whether the course's total chunk count is a plausible representation of that CED's real size.

## Output format

Produce, per course: a one-line verdict (clean / minor issues / needs re-ingest) plus specifics for anything not clean (exact code, what's wrong, what the PDF actually says). Roll up into:

1. A **prioritized fix list** in the style of `data/raw/KNOWN_GAPS.md` (read that file first for the house style) — ready to hand back as a patch or merge directly.
2. An explicit **coverage table**: course name, chunks in the data, your estimate of the CED's real total standard count, and whether that ratio looks reasonable.
3. Anything you could not verify (PDF unreadable, ambiguous CED structure) called out explicitly rather than silently skipped.

Work through this once, course by course, all 40. Don't stop partway and summarize what's left — finish the full set.
