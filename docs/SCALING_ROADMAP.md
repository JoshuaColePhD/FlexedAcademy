# FlexEd Academy scaling roadmap

This is the operating checklist for growth. The numbers are planning
thresholds, not automatic infrastructure changes. Review them against the
admin usage-cost report and a staging load test before changing production.

## Do now

- Keep the usage ledger enabled. Each model call now records feature, model,
  input/output/cached tokens, estimated USD cost, and duration when available.
- Review `GET /api/admin/usage-costs` weekly. It reports estimated spend for a
  selected period, current-month totals, unknown-cost calls, and alert state.
- Set `OPENAI_MONTHLY_ALERT_USD` and `OPENAI_MONTHLY_HARD_REVIEW_USD` in the
  deployment environment. Configure matching notifications in the OpenAI
  billing dashboard; the app endpoint is an internal signal, not a vendor
  notification.
- Retain the LLM response cache for 90 days by default. Startup removes a
  bounded batch of older rows, so cache growth is no longer unbounded.
- Keep `BUILDER_CODEGEN_ENABLED=false` on the public web service. LibreOffice
  rasterize is an onboarding spike, not lesson-plan traffic; enable it only
  on a larger instance or a dedicated worker after a memory test.
- Confirm Render dashboard env matches `render.yaml`: `BUILDER_CODEGEN_ENABLED=false`,
  `GENERATION_MAX_CONCURRENT=1`, `RETRIEVAL_WORKERS=1`, `DB_POOL_SIZE=2`.
- Run the safe local burst check:

  ```bash
  venv/bin/python scripts/load_test_generation_queue.py --requests 25 --max-concurrent 2
  ```

## At about 100 subscribers

- Compare actual cost per subscriber with the pricing model. Investigate any
  feature whose cost grows faster than subscriber count.
- Keep the current queue and worker limits until staging shows sustained queue
  wait or rejected requests. Do not increase concurrency just because the
  subscriber count increased.
- Add a staging HTTP load test with realistic authentication, retrieval, DOCX,
  and streaming behavior. The local harness only tests queue backpressure.

## At about 500–1,000 subscribers

- Move AI generation and DOCX work into separate workers behind a shared,
  durable queue. The current generation queue is in-process and therefore not
  shared across multiple web instances.
- Upgrade the web service when memory or p95 queue wait, rather than raw
  account count, demonstrates the need. Track database connection usage before
  raising `DB_POOL_SIZE`.
- Add per-user and school quotas based on estimated dollars as well as tokens;
  the token entitlement cap remains the abuse backstop.
- Review retention for event tables and generated files. Keep billing and
  audit records; aggregate or archive high-volume telemetry.

## At about 1,000–5,000 subscribers

- Make the API stateless across horizontally scaled instances. Move queue state,
  rate-limit state, and any worker coordination that must survive a restart to
  shared infrastructure.
- Add object-storage lifecycle rules and CDN delivery for generated files.
- Introduce school/district billing and usage reporting if accounts are being
  purchased in groups.
- Consider read replicas only after Postgres metrics show read pressure; a
  replica before that point adds cost and consistency complexity without
  solving the likely bottleneck.

## Decision signals to watch

| Signal | First response |
| --- | --- |
| Monthly estimated AI spend crosses alert threshold | Inspect feature/model breakdown and recent prompts |
| Unknown-cost calls appear | Add pricing for the configured model before trusting totals |
| Queue p95 rises while CPU/RAM are healthy | Check retrieval, upstream latency, and per-user pacing |
| RAM approaches service limit or workers restart | Reduce concurrency or move to a larger service |
| DB pool wait or query latency rises | Tune queries/indexes and pool budget before adding replicas |
| Storage/egress grows faster than subscribers | Add lifecycle policy and file delivery controls |
