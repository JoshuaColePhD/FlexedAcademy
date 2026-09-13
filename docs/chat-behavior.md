# Typed chat behavior

Flexed typed chat treats advice, clarification, separate plan creation, whole-week revision, and scoped day/field revisions as distinct outcomes. An open plan supplies context; it does not imply permission to change it. Existing styles, layout, and artifact components are preserved.

## Contracts

- `POST /api/chat_stream` accepts optional `active_plan_id`. The server loads the owned plan, checks its chat/class association when present, and supplies its content and week to the conversation. Older clients can omit this field.
- Typed `generate_lesson_plan` events retain the existing tool name and add `action` (`create`, `revise_week`, `revise_days`), `target_plan_id`, `instruction`, `days`, `field`, and `week_number`. Revisions must target the active plan; contradictory or truncated actions fail before dispatch. Voice keeps its existing argumentless generation signal and legacy tool definitions.
- The browser waits for the complete chat stream before dispatching an artifact request. A reconnect can retry conversation generation without triggering the artifact action twice. This is not a general exactly-once guarantee for all generation/storage endpoints.
- `POST /api/revise_days` retains the existing field-scoped operation and now accepts explicit `field: null` for whole-day revisions. All selected days are generated and validated before the combined plan is saved. Untouched days and, for field-scoped changes, other fields are preserved. No-school days are skipped.
- Original teacher requests and selected standards remain the generation query. Conversation history, question-card wording, and the model's summary carry supporting constraints. Completion messages follow successful saves, including single-day revisions.

## Teaching behavior

The typed conversation policy asks only one consequential unanswered question, uses existing context, and never forces generation based on a clarification count. Conversation stays about this week's lesson plan: greetings get a brief greeting plus one question about the week, not a menu of coaching or assessment-design jobs. It answers exploratory questions in service of the week and requires an affirmative response to an offer to build. Creation and revision prompts also connect goals, student practice, scaffolds, misconceptions, timing, and evidence of learning within the requested scope. Standards and research claims must use supplied evidence.

## Verification

Local checks:

```sh
venv/bin/python -m pytest backend/test_chat_actions.py backend/test_generate_context.py backend/test_accuracy_guards.py backend/test_stream_activity_contract.py backend/test_output_length.py -q
cd frontend
npm run test:chat
npm run test:voice
npm run test:work-activity
npm run check
./node_modules/.bin/playwright test tests/chat-actions.spec.js
```

Browser tests use synthetic preview data and intercepted model responses. They cover advice with an open plan, clarification → creation → revision, explicit separate creation, ambiguous revisions, precise day/field routing, failed generation/revision, and dropped-stream retries. They verify application behavior, not the quality of actual model reasoning.

Before publishing, use an approved live-model evaluation to review these conversations:

| Teacher request/context | Expected instructional judgment |
| --- | --- |
| Students summarize evidence instead of explaining it; paper materials and 45-minute periods | Diagnose the distinction, propose a brief worked example and independent check, and fit the period without creating a plan unasked. |
| Plan a week on rhetorical analysis; text and pacing guide already supplied | Use supplied context without repeating questions; align student practice and exit evidence to the target skill. |
| Make Thursday's exit ticket easier; retain the analysis goal | Reduce access barriers or scaffold the response without replacing analysis with recall; change only the assessment. |
| Fit lecture, debate, essay, and quiz into one 30-minute class | Explain the timing conflict briefly and offer a feasible sequence. |
| What does research say about this strategy? No retrieved sources | Distinguish professional suggestions from research; invent no citations. |
| Create a separate plan for another week, then revise its Wednesday task | Use the new active plan and week; preserve the previous plan and unrelated fields. |

Judge goal alignment, usable scaffolding, realistic pacing, assessment quality, and grounded claims individually; reject any wrong-target mutation, fabricated citation, or false completion. Paid model evaluation and deployment were not performed during local implementation.

Implementation verification: the focused backend suite passed 72 tests (4 existing skips), all 9 chat browser scenarios passed, and the 9 stream/action unit checks, voice queue check, work-activity tests, frontend lint/design-token checks, and production build passed. Desktop and phone previews were inspected against an unchanged Git baseline with no runtime errors. Three existing workspace-preview tests fail on both versions: an obsolete plan-button selector, an outdated rail color expectation, and an expectation that the artifacts drawer opens by default. Those unrelated visual expectations were left unchanged.

## Closing the loop: a flagged reply becomes a regression test

Any settled assistant reply can be flagged from the transcript (the Flag icon
next to Copy). `POST /api/chat/flag` lands it in the ordinary support inbox
with subject "Flagged AI response" — deliberately no new admin surface, since
the person reading it is the same person reading every other teacher message.

To review the population of flagged replies rather than one thread at a time:

```bash
./venv/bin/python scripts/export_flagged_chat_reports.py
```

This writes every flagged thread's context, the flagged response, and any
admin reply to `flagged_chat_reports.json`, and prints the ones with no admin
reply yet. It needs the production `DATABASE_URL`, same as any other script
in `scripts/` that reads live data — this does not touch the eval corpus or
require an API key.

When a flagged reply turns out to be a genuine bug (not a one-off model
hiccup or a misunderstanding worth a support reply instead), the fix follows
this repo's existing convention: add the fixed case as a new test alongside
the code it exercises — `backend/test_chat_*.py` for a routing/policy bug
like the ones this file documents, or a new `eval/` case for a retrieval or
grounding miss — the same way every other bug fix in this codebase ships
with the test that would have caught it. There is no separate "eval
promotion" pipeline to learn; the flagged-reports export just makes the
population of real failures visible enough to triage instead of getting
buried in a support inbox alongside billing questions.
