# Source integrity spot check — Phase 1, step 1

Run before any parsing, per the standing instruction to verify sources rather
than trust them. Method: extract raw text with `pdftotext -layout` and compare
the authoritative PDF against the markdown file that was supplied alongside it.

**Result: the markdown file supplied as `act-english-standards.md` is not ACT
standards, and its AP Lang content is substantively altered. It is excluded
from the pipeline.** Details below.

---

## Finding 1 — the file is misnamed

`~/Desktop/AP_LANG_RAG/act-english-standards.md` (2,605 bytes) contains **AP
Lang skills**, not ACT standards. It has no TOD/ORG/KLA/SST/USG/PUN codes and
no score bands at all.

The real ACT file — 14,382 bytes, all six reporting categories with codes
grouped by score band 13–15 through 33–36 — is at:

```
~/My Drive/Iris_OS/Skills/build-lesson-plan/reference/act-english-standards.md
```

Both files begin at byte 0 with a different H1, so the Desktop copy is not a
truncation of the Drive copy; it is a different document that inherited the
filename.

## Finding 2 — AI assistant artifact text in the file

Final line of the Desktop markdown, appended to standard 8.C with no separator:

> Use code with caution.Would you like me to generate a matching JSON file
> structure of these skills, or perhaps a YAML format for a different setup in
> VS Code?

This is chat output from an AI tool committed into the file as if it were
source content. A naive parser would have embedded it as part of standard 8.C's
description and it would have been retrievable and citable.

Note: the reference files in the live `build-lesson-plan` skill were scanned for
the same artifact patterns and are **clean**. The contamination is confined to
the Desktop copy.

## Finding 3 — standard content was altered, not just reformatted

This is the serious one. Verbatim comparison, authoritative PDF
(`APLangSkills.pdf`, © 2020 Bedford, Freeman & Worth) vs. the Desktop markdown:

| Code | PDF (authoritative) | Desktop markdown | Verdict |
|---|---|---|---|
| 1.A | "Identify and describe components of the rhetorical situation: the exigence, audience, writer, purpose, context, **and message**." | "...(exigence, purpose, audience, writer, and context)." | **"message" silently dropped** |
| 2.A | "Write introductions and conclusions appropriate to the purpose and context of the rhetorical situation." | "Make strategic choices in a text that address a specific rhetorical situation." | **Wrong text.** The md used the *sub-skill heading* in place of the standard. |
| 5.C | "Recognize and explain the use of **methods of development to accomplish a purpose**." | "Recognize and describe how a writer's word choice reveals **biases, logical fallacies, or underlying assumptions**." | **Fabricated — unrelated standard** |
| 6.C | "Use appropriate **methods of development** to advance an argument." | "Refine writing to address **personal biases or intentional rhetorical strategies**." | **Fabricated — unrelated standard** |
| 7.B | "Explain how writers create, combine, and place **independent and dependent clauses** to show relationships between and among ideas." | "Analyze how a writer's choices in **punctuation and mechanics** serve a rhetorical purpose." | **Wrong text** |
| 7.C | "Explain how **grammar and mechanics** contribute to the clarity and effectiveness of an argument." | "Evaluate how a text's style **shifts across different sections or modes of development**." | **Fabricated — unrelated standard** |
| 8.B | "Write sentences that clearly convey ideas and arguments." | "Apply grammar, punctuation, and mechanics intentionally to enhance an argument." | **Wrong text** |
| 8.C | "Use established conventions of grammar and mechanics to communicate clearly and effectively." | "Maintain stylistic choices across complex or extended lines of reasoning." | **Wrong text** |

Additional losses in the markdown:

- **Codes 1.B and 2.B are missing entirely.** The PDF has both ("Explain how an
  argument demonstrates understanding of an audience's beliefs, values, or
  needs" / "Demonstrate an understanding of an audience's beliefs, values, or
  needs"). The md has 22 skills where the PDF has 24.
- **All frequency counts dropped** (1A=3, 1B=1, 2A=2, 3A=4, …). These are
  useful signal for lesson sequencing.
- **Copyright/attribution line dropped** (Bedford, Freeman & Worth, © 2020).

### Decision

`APLangSkills.pdf` is the sole ground truth for AP Lang skills. The Desktop
markdown is retained in `source_docs/quarantine/` for the record and is **not
parsed, embedded, or retrievable**.

---

## Finding 4 — page range for ALCOS Grade 11 corrected

The working note said Grade 11 was at PDF pages 134–139. Actual location, by
extraction:

| PDF page | Printed page | Content |
|---|---|---|
| 133 | 122 | Recurring Standards for Grades 9–12 (R1–R7) |
| 134 | 123 | Grade 11 content standards 1–7 (Critical Literacy / Reading) |
| 135 | 124 | Standards 8–12 |
| 136 | 125 | Standards 13–18 |
| 137 | 126 | Standards 19–23 (Language Literacy) |
| 138 | 127 | Standards 24–30 (Research Literacy) |
| 139 | 128 | **Grade 12** — out of scope, hard stop here |

Grade 11 is **PDF pages 133–138**. Parsing past 138 pulls Grade 12 content,
whose standards are numbered 1–30 as well and would collide. The parser is
bounded to 133–138 and asserts the Grade 12 header is not present.

R1–R7 are reprinted identically under every grade 9–12 with trivial punctuation
differences ("charts, other common workplace documents" at Grade 11 vs.
"charts, and other common workplace documents." at Grade 12). The Grade 11
printing (PDF p. 133) is used, since Grade 11 is this course's grade.

## Finding 5 — a third, unreconciled variant of the AP skill text exists

`build-lesson-plan/reference/ap-lang-curriculum.md` lines 106–114 contain an
AP↔ACT crosswalk with a *third* set of wordings (e.g. 4.A = "Develop a thesis
that conveys a defensible claim", vs. the PDF's "Develop a paragraph that
includes a claim and evidence supporting the claim"), and cites ACT codes in
families that do not appear in the ACT English/Writing file at all — `CLR`,
`IKI`. Those are plausibly ACT **Reading** codes, which the ACT file itself
flags as missing.

Not fixed here — that file belongs to a different skill and serves a different
purpose. Flagged so it is not mistaken for a fourth source later, and because
the ACT codes cited there cannot currently be grounded in any file we hold.
