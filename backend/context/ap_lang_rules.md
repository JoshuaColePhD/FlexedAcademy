# AP Lang planning rules (curated prompt context)

Distilled from `Iris_OS/Skills/build-lesson-plan/SKILL.md` and the Florence High
School workspace `PROJECT_CONTEXT.md`. The full SKILL.md is ~22KB and more than half of it
is Drive-upload procedure, Apps Script details, and slide-deck build steps that
have nothing to do with producing lesson-plan JSON. Injecting it whole roughly
doubled input tokens per request for no gain. This file is only the pedagogy the
model actually needs.

Keep this in sync by hand when the weekly rhythm or frameworks change — it is
prompt content, not a source of truth for the standards themselves.

## Class shape

50-minute periods. Every day follows this arc, and the `during` field should
read as one continuous narrative covering it (no sub-labels — the district
template supplies its own):

| Time | Segment |
|---|---|
| 5 min | Do Now — prompt on the board, students work independently on entry |
| 10–15 min | Direct instruction — teacher models, explains, annotates |
| 15 min | Group work — collaborative task tied to the day's skill |
| 15 min | Individual work — independent task, submitted or collected |
| ~5 min | Buffer — transitions, wrap-up |

## Weekly rhythm (standard week)

| Day | Personality |
|---|---|
| Monday | Anchor text introduction — cold read reaction, first-read discussion, written first impressions |
| Tuesday | Skill deep dive — model the week's analytical skill, collaborative annotation, skill-application paragraph |
| Wednesday | Application — apply Tuesday's skill to a NEW text. Odd weeks: independent analysis. Even weeks: MCQ practice |
| Thursday | Written assessment — odd weeks: skeleton essay. Even weeks: full timed essay |
| Friday | Reflection & journal — Columnist Journal entry; mode depends on Thursday's type |

Project weeks replace this rhythm entirely. If the request describes a project
week, don't force the standard structure onto it.

## Analytical frameworks

- **SPACE CAT** — Speaker, Purpose, Audience, Context, Exigence, Appeals, Tone
- **DIDLS** — Diction, Imagery, Details, Language, Syntax
- **REHG** — Reason, Evidence, Historical example, General example
- **1-4-1** — Thesis paragraph + four body paragraphs + conclusion

Scaffold learning targets across the week rather than repeating one verb:
identify → apply → analyze → evaluate.

## Recurring assignments

- **Columnist Journal** — self-selected columnist from headlinespot.com; each
  entry does SPACE CAT + DIDLS + a rhetorical pre-write. Due every Friday.
- **Dialectical journals** — style-focused note-taking on diction, tone, imagery,
  commenting on intended effect.
- **Daily notes & analysis** — reader-response or investigative writing each class.

## Engagement strategies

The district form renders this field as a fixed dropdown. Choose one or two
values per teaching day, using only these values:

`Cold Call`, `Equity Sticks`, `Think/Pair/Share`, `Small Groups`,
`A/B Partners`, `Write 1st, Talk 2nd`, `Gallery Walk`, `Rally Coach`

Pick strategies that fit the day's work — Rally Coach for paired annotation,
Gallery Walk for peer review, Small Groups for collaborative analysis. Don't
repeat the same one all five days.

## Field conventions

- `learning_targets` — must begin "I can…". One sentence, one line.
- `standards` — code first, then the standard's own words, e.g.
  `2.A -- Describe the rhetorical situation`. Single line.
- `act_alignment` — ACT English/Writing code(s) with description. Single line.
  If nothing was retrieved to ground it, leave it an empty string. Do not guess.
- `do_now` — the actual board prompt, ~5 minutes of work.
- `during` — the full instructional narrative: what you model, what groups do,
  what students do alone. Several sentences. This is the substance of the plan.
- `assessment` — the concrete evidence produced that day (an organizer, a
  paragraph, an essay, a practice set), not a vague "observation".
