# Florence City Schools — Weekly Lesson Plan Template Spec

Template id: `florence-docx-v1`. Output: a single landscape `.docx` covering one week.
The script `scripts/build_lesson_plan.py` implements this spec exactly.

## Page layout

- **Orientation:** Landscape letter, 11" × 8.5"
- **Margins:** 0.5" all sides (720 DXA)
- **Content width:** 14400 DXA

## Column widths (DXA)

| Column | DXA |
|---|---|
| Label (col 1) | 1980 |
| Each day column (×5, Mon–Fri) | 2484 |
| Total | 14400 |

## Colors (hex)

| Token | Hex | Used in |
|---|---|---|
| Header blue | `A4C2F4` | Rows 1–2 (title header + day-name row) |
| Label blue | `CFE2F3` | Rows 3–8 label column |
| White | `FFFFFF` | Content cells |
| Black | `000000` | All text |

## Fonts

| Rows | Font | Weight | Size |
|---|---|---|---|
| 1–2 | Arial | Bold | 11pt |
| 3–8 label column | Calibri | Bold | 11pt |
| 3–8 label guidance text | Calibri | Regular | 9pt |
| 3–8 content cells | Calibri | Regular | 11pt |

## Table structure — 8 rows × 6 columns

| Row | Label (col 1) | Content (cols 2–6 = Mon–Fri) |
|---|---|---|
| 1 | — (merged header) | Teacher · Grade/Subject · Week of |
| 2 | "Lesson Plan Components" | Monday / Tuesday / Wednesday / Thursday / Friday |
| 3 | Curriculum/Resources | Texts, readings, materials for the day |
| 4 | Standards | Prefixed "Standard:" — AP skill code(s), e.g. 2.A |
| 5 | Learning Targets | Prefixed "Learning Targets:" — must start with "I can…" |
| 6 | Do Now (5 mins) | Prefixed "Do Now:" — the entry prompt |
| 7 | What will learning look like? | Explicit (direct instruction) / Student (group) / Independent (individual) |
| 8 | Assessment | ☑/☐ Formative / Summative + what's being assessed |

## No-school days

- All content cells for that day: white background, no content.
- Row 3, that day's column only: "No School" in Arial Bold 11pt, centered.
- The script handles this automatically when `"no_school": true` in the JSON.

## Content guidance per row

- **Curriculum/Resources:** specific texts and materials; name the fiction anchor and
  any nonfiction/FRQ passage.
- **Standards:** AP skill codes (2.A–6.A); keep to the day's true focus.
- **Learning Targets:** 1–2 "I can…" statements, student-facing.
- **Do Now:** a concrete 5-minute prompt tied to the day's text or skill.
- **What will learning look like?** Three labeled beats — Explicit (what the teacher
  models), Student (the group task), Independent (the individual task).
- **Assessment:** mark Formative vs. Summative; name the artifact (paragraph, MCQ set,
  skeleton essay, timed essay, journal entry).
