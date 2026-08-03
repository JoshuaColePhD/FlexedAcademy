---
name: lesson-plan-week
description: Generate Josh Cole's weekly AP Language & Composition (and ENG 101/102) lesson plan for Florence High School. Use whenever Josh says anything like "let's plan next week", "help me with my lesson plan", "what's next week look like", "generate week 11", or similar. Open proactively by reading his course folders to figure out where he left off, present the week plan, let him react, then build the .docx and save it to the right course folder automatically.
version: 3.1.0
---

# Lesson Plan Generator — Florence High School

Build Josh Cole's weekly lesson plan and save it directly to the correct course folder.
The output is a `.docx` using the Florence City Schools landscape template.
No slides here — but see Step 5.5 for when a slide deck should be offered.
Daily assignment docs available on request.

## Reset State

As of 2026-06-27, prior AP Lang lesson-plan artifacts were archived so AP Lang
can restart from scratch. Treat empty active `Lesson Plans & Slides/` folders as
expected unless Josh asks to restore old materials.

Reset manifest:

`Iris_OS/Projects/Florence High School 2026-2027/AP Lang/_Archive/Lesson Plan Reset (2026-06-27)/Lesson Plan Reset Manifest.md`

Current AP Lang status tracker:

`Iris_OS/Obsidian/JoshuaColePhD/Knowledge/Agent Outputs/lesson-plans/AP Lang/lesson-plan-status.md`

## Canonical Save Routing

Final teaching files go in the Florence High School project folders, not Obsidian
Agent Outputs. Obsidian Agent Outputs are only for notes, briefs, source catalogs,
and QA records.

| Course | Final lesson plan folder |
|---|---|
| AP Lang | `Iris_OS/Projects/Florence High School 2026-2027/AP Lang/<unit-folder>/Lesson Plans & Slides/` |
| ENG 101 | `Iris_OS/Projects/Florence High School 2026-2027/ENG 101/Lesson Plans & Lecture Slides/` |
| ENG 102 | `Iris_OS/Projects/Florence High School 2026-2027/ENG 102/Lesson Plans & Lecture Slides/` |

When writing Obsidian support notes for lesson-plan work, save them under:

`Iris_OS/Obsidian/JoshuaColePhD/Knowledge/Agent Outputs/lesson-plans/<course>/`

---

## Step 1 — Read Drive to find where he left off

Before saying anything, use the Google Drive connector to check:

```
Iris_OS/Projects/Florence High School 2026-2027/AP Lang/
```

Look inside each unit's `Lesson Plans & Slides/` folder for `Week_XX` files and
check `lesson-plan-status.md`. If no active week files exist after the reset,
start with Week 1 unless Josh specifies another week. Otherwise, find the highest
active week number that exists. The next week to plan is that number + 1.

If you can't read Drive, ask Josh: "Which week are we on?"

---

## Step 2 — Open proactively (don't ask a form of questions)

Once you know the next week number, figure out everything you can on your own:

- **Dates** — count from Aug 5, 2026 (Week 1 = Aug 5–7, Week 2 = Aug 10–14, etc.;
  skip non-school days using the calendar in `reference/ap-lang-curriculum.md`)
- **Unit** — look up the week's dates in the 9-unit map
- **Anchor text** — from the unit map
- **Thursday type** — odd week = Week A (Skeleton Essay); even week = Week B (Full Timed Essay)
- **Any holidays** — cross-reference the school calendar

Then open with a single, natural summary. For example:

> "Next week is Week 3 (Aug 17–21). We're still in Unit 1 — The Rhetorical Situation,
> working with Faulkner's *A Rose for Emily*. Thursday is a Week A, so students will
> write a skeleton essay. I'm thinking we spend Monday doing a close read of the ending,
> Tuesday modeling SPACE CAT on a new passage, Wednesday with an MCQ application, and
> Friday expanding Thursday's skeleton into a draft. Any changes, or should I build it?"

Keep it conversational. One short paragraph, not a list of questions.

## Step 2.5 — Preflight save check

Before drafting or generating files, silently verify and be ready to state:

- Course: AP Lang, ENG 101, or ENG 102.
- Week number and date range.
- Unit and final save folder.
- Obsidian note folder.
- Whether an active final file already exists.

If a prior active final file exists for the same week, ask Josh before overwriting.
Archived files do not block a fresh generation.

---

## Step 3 — Incorporate Josh's response

If he says "looks good" or similar → proceed to build.

If he adjusts something (a day, an activity, a no-school day, a text swap) → acknowledge
the change naturally and confirm before building. Don't re-present the whole plan.

---

## Step 4 — Build the .docx

Draft the full lesson plan content for all five days (or applicable days), following
the weekly rhythm and daily structure in `reference/ap-lang-curriculum.md`.

Every day needs all 8 template rows. Learning Targets must start with "I can…".

Write a `week.json` using the schema in `scripts/example-week.json`, then run:

```bash
pip install python-docx -q
python3 scripts/build_lesson_plan.py week.json "Week_03_Aug_17-21.docx"
```

Set `"no_school": true` for any no-school day — the script handles the cell automatically.

---

## Step 5 — Save automatically

After generating the `.docx`, save it to the correct course folder. Do not ask
Josh where to save it — figure it out from the course, week/unit, and folder
structure. If uploading through the Google Drive connector, use the same path
names and destination folders.

**AP Lang path pattern:**
```
Iris_OS/Projects/Florence High School 2026-2027/AP Lang/<unit-folder>/Lesson Plans & Slides/<filename>
```

**Week → unit folder routing (use this to determine where to save):**
| Weeks | AP Lang unit folder |
|---|---|
| 1–5 | Unit 1 — Rhetorical Analysis |
| 6–9 | Unit 2 — Voice, Tone & Rhetorical Devices |
| 10–13 | Unit 3 — Power of Language |
| 14–18 | Unit 4 — Line of Reasoning & Evidence |
| 19–23 | Unit 5 — The American Dream |
| 24–28 | Unit 6 — Community & Conformity |
| 29–32 | Unit 7 — Duality, Identity & Sources |
| 33–37 | Unit 8 — Voice, Gender & Complexity |
| 38–41 | Unit 9 — AP Exam Prep |

**ENG 101/102 path patterns:**
```
Iris_OS/Projects/Florence High School 2026-2027/ENG 101/Lesson Plans & Lecture Slides/<filename>
Iris_OS/Projects/Florence High School 2026-2027/ENG 102/Lesson Plans & Lecture Slides/<filename>
```

Do not use AP Lang's `Lesson Plans & Slides` folder name for ENG 101/102.

**File name:** `Week_XX_Mon_DD-DD.docx` (e.g. `Week_03_Aug_17-21.docx`)

After saving, confirm naturally:
> "Done — Week 3 is saved to Unit 1 / Lesson Plans & Slides. It's a draft, so give
> it a look before class, especially the specific text excerpts and assessment timing."

## Step 5.5 — Offer a deck for any day introducing a new framework, author, or text

Check the week you just built: does any day's Curriculum/Resources or Explicit
notes introduce something genuinely new (a framework like SPACE CAT, an author,
a text) rather than continuing/practicing something already introduced?
Independent workshop/writing/journal days don't qualify. If one or more days
do, mention it — don't build automatically:

> "Thursday introduces SPACE CAT and *A Rose for Emily* — want me to build a
> slide deck for that day?"

If yes, hand off to the **deck-builder** skill (`Iris_OS/Skills/deck-builder/SKILL.md`,
see its "Sourcing a deck from the real weekly lesson plan" section) — it turns
that day's Do Now / Learning Targets / Explicit notes into the deck outline
directly, rather than inventing content separately. It saves the `.pptx`
alongside this week's `.docx` in the same `Lesson Plans & Slides/` folder, and
produces both embedded PowerPoint speaker notes and a one-page teaching-notes
`.docx` — always build both, not just one.

## Step 6 — Write the ledger

After saving the final `.docx`, update:

`Iris_OS/Obsidian/JoshuaColePhD/Knowledge/Agent Outputs/lesson-plans/AP Lang/lesson-plan-status.md`

Also create a short weekly Obsidian note in:

`Iris_OS/Obsidian/JoshuaColePhD/Knowledge/Agent Outputs/lesson-plans/<course>/week-XX-<date-slug>/`

Include:

- Final `.docx` path.
- Source assumptions and any Josh-requested changes.
- Validation status.
- Any limitations or items to review before class.

## Archive/reset checklist

When Josh asks to start over or archive lesson plans:

1. Create a dated reset archive under the relevant course `_Archive/` folder.
2. Move, do not delete, prior final lesson files and related teaching artifacts.
3. Move related Obsidian lesson-plan output folders under `lesson-plans/_Archive/`.
4. Move related `Iris_OS/outputs/` scratch folders under `Iris_OS/outputs/_Archive/`.
5. Write a reset manifest with source path, destination path, artifact type, item count, and reason.
6. Reset or create the course `lesson-plan-status.md`.
7. Run `python3 scripts/routing_smoke_test.py`.

---

## Secondary output (on request only)

**Daily assignment docs** — one `.docx` per day with **Group Work** and
**Individual Work** sections. Friday always adds a **Columnist Journal** section.
Generate these only if Josh asks.

---

## Reference files

- `reference/ap-lang-curriculum.md` — 9-unit map, daily structure, weekly rhythm,
  Thursday A/B, AP skills, frameworks, rubric, calendar
- `reference/fcs-template-spec.md` — Florence City Schools template spec
- `scripts/build_lesson_plan.py` — python-docx generator
- `scripts/example-week.json` — sample week JSON
- `scripts/routing_smoke_test.py` — verifies AP Lang, ENG 101/102, and Obsidian routing
