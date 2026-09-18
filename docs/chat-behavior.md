# Typed chat behavior

Flexed typed chat treats advice, clarification, separate plan creation, whole-week revision, and scoped day/field revisions as distinct outcomes. An open plan supplies context; it does not imply permission to change it. Existing styles, layout, and artifact components are preserved.

**Typed chat always carries its tools.** Choosing among those outcomes is the model's judgment, informed by the tool descriptions and a single conversational policy. It is not decided in advance by a keyword test on the teacher's message. This replaced `chat_actions_enabled()`, which required an action verb AND a literal artifact noun ("lesson plan", "quiz") in the last user message alone. That gate denied tools to "make a lesson", "build me next week", "draft week 7" and "I need a sub plan for Friday"; because it read only the last message, it also denied them to every reply to a clarifying question ("I don't have one", "quadratic functions", "yes"), so the chat could ask a question and was then structurally unable to act on the answer. The same test gated the saved plan and the pacing guide, so those turns had no context either, and the system prompt still told the model the week belonged in `generate_lesson_plan` — a tool that was not in its array. The result was a full lesson plan typed into the transcript and no artifact.

## Contracts

- `POST /api/chat_stream` accepts optional `active_plan_id`. The server loads the owned plan, checks its chat/class association when present, and supplies its content and week to the conversation. Older clients can omit this field.
- Typed `generate_lesson_plan` events retain the existing tool name and add `action` (`create`, `revise_week`, `revise_days`), `target_plan_id`, `instruction`, `days`, `field`, and `week_number`. Revisions must target the active plan; contradictory or truncated actions fail before dispatch. Voice keeps its existing argumentless generation signal and legacy tool definitions.
- The browser waits for the complete chat stream before dispatching an artifact request. A reconnect can retry conversation generation without triggering the artifact action twice. This is not a general exactly-once guarantee for all generation/storage endpoints.
- `POST /api/revise_days` retains the existing field-scoped operation and now accepts explicit `field: null` for whole-day revisions. All selected days are generated and validated before the combined plan is saved. Untouched days and, for field-scoped changes, other fields are preserved. No-school days are skipped.
- `chat_turn_policy()` describes a turn rather than gating it: `tools_enabled` (always true for typed chat), `command_surface`, `pending_intent`, `casual_opener`, and `plan_context`. `pending_intent` reads the exchange, not the last message, so an answer to a clarifying question or a "yes" to an offer completes the request that prompted it. `casual_opener` is a greeting or thanks with no live request; it adds a prose-only hint and does not remove tools. OpenAI function tools must not put `null` in an `enum` array — typed chat sends these tools on every turn, including `hello`.
- Every typed artifact tool takes a required `preamble`, declared first in its schema so it streams to the browser before the remaining arguments. The SSE order for an artifact turn is `chunk`* -> `tool_call` -> `done`. A turn that emits no preamble gets a per-tool default, so the transcript never jumps straight to a work card with nothing said.
- Typed `stream_chat` sends function tools on every turn. `gpt-5.6-luna` on Chat Completions rejects that unless `reasoning_effort` is `none`; any other value 400s the turn before a token is produced. Tool-less calls may still use `low`.
- The saved plan is supplied whenever one is open, unconditionally.
- `map_context_for` retrieves the open class's documents plus account-wide `other` references (department policies, generic rubrics). Global pacing guides, syllabi, and curriculum maps are excluded so another prep's texts cannot enter this class's chat. The system prompt also locks the conversation to the open class's subject.
- When the teacher asks for ideas, or the model has 2–5 concrete directions for this class and week, `ask_clarifying_questions` with `purpose: "suggest"` renders those options in the existing choice box immediately above the composer. Suggestions are not written as a chat paragraph.
- Original teacher requests and selected standards remain the generation query. Conversation history, question-card wording, and the model's summary carry supporting constraints. Completion messages follow successful saves, including single-day revisions.

## Teaching behavior

One policy (`CHAT_PARTNER_POLICY`) governs every typed turn, so the assistant's voice no longer changes between consecutive messages depending on a regex. It asks only one consequential unanswered question, uses existing context, and never forces generation based on a clarification count. Conversation stays about this week's lesson plan: greetings get a named prose invitation to say what this week needs, not a question card and not a menu of coaching or assessment-design jobs. It answers exploratory questions in service of the week and requires an affirmative response to an offer to build. Creation and revision prompts also connect goals, student practice, scaffolds, misconceptions, timing, and evidence of learning within the requested scope. Standards and research claims must use supplied evidence.

## Verification

Local checks:

```sh
venv/bin/python -m pytest backend/test_chat_actions.py backend/test_generate_context.py backend/test_accuracy_guards.py backend/test_stream_activity_contract.py backend/test_output_length.py -q
cd frontend
npm run test:chat
npm run test:voice
npm run test:work-activity
npm run test:markdown
npm run check
./node_modules/.bin/playwright test tests/chat-actions.spec.js tests/chat-markdown.spec.js
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
| "hello" in an empty chat | Named prose invitation to say what this week needs. No question card, no plan. |
| "I want to work on my lesson plan. Any ideas?" | Choice box above the composer with 2–5 directions for this class and week. No mashed prose paragraph. |
| ...then "quadratic functions" | Build the plan. The answer completes the request that prompted the question. |
| ...or "I don't have one" | Either build from the pacing guide, stating the assumption, or ask once more. Never a day-by-day week in the transcript. |
| "build me next week" / "draft week 7" / "can you put together Tuesday" | Treated as build requests, whether or not the words "lesson plan" appear. |
| An offer to build, answered "yes" / "sounds good" | Do exactly what was offered, no wider, without re-confirming. |
| "why is Wednesday structured this way?" with a plan open | Prose, no tool. An open plan is context, not permission. |

Judge goal alignment, usable scaffolding, realistic pacing, assessment quality, and grounded claims individually; reject any wrong-target mutation, fabricated citation, or false completion. Paid model evaluation and deployment were not performed during local implementation.

Implementation verification: the focused backend suite passed 72 tests (4 existing skips), all 9 chat browser scenarios passed, and the 9 stream/action unit checks, voice queue check, work-activity tests, frontend lint/design-token checks, and production build passed. Desktop and phone previews were inspected against an unchanged Git baseline with no runtime errors. Three existing workspace-preview tests fail on both versions: an obsolete plan-button selector, an outdated rail color expectation, and an expectation that the artifacts drawer opens by default. Those unrelated visual expectations were left unchanged.
