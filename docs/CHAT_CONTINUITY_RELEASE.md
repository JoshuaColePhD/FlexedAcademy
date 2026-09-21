# Chat continuity and consultation release

Requested scope: fix the chat comparison findings, verify the finished behavior,
then merge and push. This checklist records remaining work; it is not evidence
that a feature has passed verification.

- [x] Durable conversation attachments, follow-up retrieval, reload and retry.
- [x] Natural consultation, optional question cards, requested answer depth.
- [x] Bounded history with a durable planning record and relevant complete plan sections.
- [x] Clean alternative answers and preserved branches for edited earlier messages.
- [x] Reasoning-capable tool calls for complex consultation.
- [x] Voice turn-taking, interruption, transcription and real latency diagnostics.
- [x] Focused day reading alongside the conversation on narrower screens.
- [x] Production task-outcome measurements and a multi-turn teacher benchmark.
- [ ] Backend, database, frontend and browser checks against the release revision.
- [ ] Pull request, merge, remote synchronization and deployment verification.

Current comparison baseline: master d537bdc. Live model results, simulated
browser responses and deterministic contract checks must be reported separately.

Implemented checks and limits:

- Frontend build, lint, token and class checks pass. The full browser run passed
  95 tests, with 5 explicitly disabled staging/retired-flow cases. Follow-up
  tests cover the final save-race fix and live voice consultation state handling.
- Backend hermetic tests and 15 offline eval suites pass. Four additional
  database tests exercise source isolation, retry, historical plan cloning and
  rollback; they require the disposable Postgres CI service.
- A 25-case, 50-turn synthetic benchmark and metered live runner are included.
  Only offline fixture validation has run. A live API-spend limit is pending;
  no model-quality score or ChatGPT parity claim is made.
- Real microphone/audio acceptance has not run. Preview voice is simulated.
  Browser output-buffer timing is separately labeled from server measurements.
- CHAT_API=chat_completions is the explicit transport rollback; the new default
  is Responses with low/medium reasoning. The deployed model remains unchanged.
- Saved conversations retain their original text. Compaction affects model
  context; source passages and historical plan versions remain recoverable.
  An unusually large latest exchange or whole-week plan stays complete rather
  than being cut in the middle. The normal history window is bounded to 36k
  characters and at most 16 recent messages plus a structured planning record.

Release gates: require all PR checks before merging. Verify the deployed commit,
health/readiness, schema migration and the working-tree/remote sync after merge.
