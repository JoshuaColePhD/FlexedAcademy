# eval/

What guards retrieval accuracy. Run it before merging anything that touches
`backend/retrieval.py`, the chunk files, or the embedding model.

```bash
./venv/bin/python eval/run_all.py          # everything (~3 min, a fraction of a cent)
./venv/bin/python eval/run_all.py --fast   # only what needs no DB or API
```

Nothing here calls a chat model. The cost is embeddings for the query strings.

For an actual generation-quality reading (does the model's real citation output stay
grounded, per course) rather than a retrieval-recall check, see
[`QUALITY_AUDIT_RUNBOOK.md`](./QUALITY_AUDIT_RUNBOOK.md) — that one does call a chat
model and costs real tokens, so it's a deliberate, budgeted run, not part of this
suite.

## The suites

| Suite | Guards | Needs |
|---|---|---|
| `test_grounding_audit.py` | `_CODE_RE` parses every code shape the corpus uses; the audit flags borrowed and invented codes | nothing |
| `test_course_identity_and_codes.py` | AP courses ground in AP skills not ALCOS; course variants join while real courses stay apart; the audit is course-scoped; a code named in a query retrieves itself | DB + API |
| `test_cross_course_grounding.py` | 32 courses never retrieve another subject's standards, and each gets its correct ACT section | DB + API |
| `test_offdomain_refusal.py` | the looser ACT floor did not re-open the off-domain hole | DB + API |
| `test_golden_recall.py` | recall@5 over 143 synthetic teacher phrasings, against a recorded baseline | DB + API |

## Why the golden set is a number, not a pass/fail

`data/eval/golden_cases.json` pairs a teacher-style phrasing with the standard it
was written from. A few of those pairs are unwinnable and always have been: the
corpus holds standards whose codes differ by one character and whose text differs
by one word — `PE19.BK1.2.2.APE` vs `PE19.BK2.2.2.APE`, or `7A` / `7A1` / `7D` /
`7D1` in AP Chinese. A one-sentence paraphrase cannot pick between them.

So `test_golden_recall.py` fails only when recall@5 drops **below the recorded
baseline**, or when a standard falls out of the top 60 entirely. The hard cases
are printed every run rather than deleted, so they stay visible.

`eval/baseline.json` is the recorded state. Regenerate deliberately, never to
paper over a red run:

```bash
./venv/bin/python eval/test_golden_recall.py --update-baseline
```

### Current baseline (2026-08-06)

```
cases       143
recall@5    138/143
recall@60   142/143
```

The five below rank 5, with why:

| Case | Rank | Why |
|---|---|---|
| `PE: PE19.BK2.2.2.APE` | 32 | near-identical sibling codes (BK1/BK2, 2.2/2.3/2.4) |
| `APHuG: V` | 12 | the expected "code" is a bare roman numeral from a weak parse |
| `AP Human Geography …: 5` | 29 | bare numeric code, no distinguishing text |
| `AP Chinese: 7D` | 10 | siblings 7A / 7A1 / 7D1 differ by one character |
| `AP Seminar Curricular Requirements: CR 1` | not found | competes against all three AP Seminar partitions |

The last three sit lower than they did before 2026-08-06, and that is a known,
accepted trade: `course_variants()` reunited the partitions one course had been
split across (259 AP US History standards had been unreachable by any query), so
each course now searches a larger pool and a vaguely-coded standard has more
competition. Recovering 259 reachable standards is worth three ambiguous codes
sliding down the ranking.

## Retired cases

`retired_cases.json` holds golden cases that a deliberate policy change made
impossible, with the reason. They are kept rather than deleted so the reasoning
survives. One so far: an AP Lang case expecting `Grade11-9`, an Alabama
course-of-study code — AP courses ground in AP skills only, so no ALCOS code is
reachable from `AP_Lang` by design.

## Related

`scripts/05_eval_harness.py` also checks the .docx contract and live generation
against `backend/schema.py`. It is not part of `run_all.py` because generation
costs real tokens. Run it directly when you touch the builder:

```bash
./venv/bin/python scripts/05_eval_harness.py --offline
```

It measures a different thing from `test_golden_recall.py`, on purpose:

* **`test_golden_recall.py`** ranks with a flat top-k. That is pure retrieval
  quality — a clean signal, and what the baseline guards.
* **`05_eval_harness.py`** asks whether the teacher actually *receives* the
  standard, so it falls back to `retrieve_grounded()` — the stratified search
  production runs, which force-includes the best of each source type. A standard
  can be handed to the model while ranking 30th flat.

Its `MIN_RECALL` (141/147) works the same way as this directory's baseline:
raise it when retrieval improves, never lower it to go green. Before
2026-08-06 it loaded the golden set *over* its own hand-written cases instead of
alongside them, so those had been silently dead since the golden set first
existed.
