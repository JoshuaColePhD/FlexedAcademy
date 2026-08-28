# Generation quality audit — runbook

A prompt to hand a future Claude Code session (or follow by hand) when it's
time to actually run `scripts/08_generation_quality_audit.py` against real
data and act on what it finds. Costs real OpenAI tokens, so this is written
to be run when there's budget for it, not as part of every-day development.

Copy everything below the line into a fresh session when ready.

---

Run and act on the per-course generation quality audit (scripts/08_generation_quality_audit.py).

Context: this script runs real prompts from data/eval/golden_cases.json through the
actual generation pipeline (service.prepare + llm.generate_plan) and classifies every
cited standard as grounded / not_retrieved / wrong_course / hallucinated. It costs real
OpenAI tokens (~$0.05/case at gpt-4o-era pricing — verify current pricing/model cost
before committing to a full run) and needs OPENAI_API_KEY plus real production-shaped
data. It is diagnostic only — it does not fix anything by itself.

Do this:

1. Confirm OPENAI_API_KEY is set and reachable. Run a cheap sanity check first:
   python scripts/08_generation_quality_audit.py --limit 5
   Check the actual dollar cost in the OpenAI usage dashboard afterward and confirm it's
   in the expected ballpark before running anything larger.

2. Run the full sweep (or course-by-course if budget is tight):
   python scripts/08_generation_quality_audit.py --all --save
   (--save writes full per-case detail to eval/reports/ for reference.)

3. Read the per-course report. For each course, look at:
   - citations grounded (rate) — the headline number
   - not_retrieved count
   - wrong_course count
   - hallucinated count
   - expected code actually retrieved (rate)
   Treat any course with fewer than ~10 cases as too noisy to trust yet (scripts/07
   only samples 2 chunks/course by default) — widen its sample before drawing
   conclusions from a low number.

4. Route each course's dominant failure mode to the matching fix — don't apply a
   generic fix, match the specific signal:
   - Mostly `hallucinated` → prompt-engineering problem. Tighten the generation
     prompt's grounding instructions (backend/prompts.py) for that course, or
     re-examine whether the configured model is strong enough at instruction-following
     for this course's standards vocabulary.
   - Mostly `not_retrieved`, or a low "expected code actually retrieved" rate →
     relevance-floor problem. Run scripts/06_threshold_sweep.py --course <X> --grade 11,
     write real teacher-phrased positive/off-domain probes for that course grounded in
     what's actually in its corpus (see the script's own comments on the Science/
     stoichiometry mistake it already caught once), and set the measured floor in
     render.yaml's RETRIEVAL_FLOORS.
   - Mostly `wrong_course` → retrieval scoping bug, not a tuning problem. This means
     course/grade filtering in backend/retrieval.py is leaking across subjects — treat
     it as a real regression to root-cause and fix in code, not something a floor
     adjustment solves.
   - Low case count / high variance → expand scripts/07_generate_golden_evals.py's
     per-course sample size for that course before trusting any percentage from it.

5. After applying a fix, re-run the audit scoped to just that course
   (--course <X> --limit 10) to confirm the number actually moved before considering
   it resolved.

6. Report back a summary: which courses were audited, what each course's dominant
   failure mode was, what fix was applied (or that none was needed), and which
   courses still need a bigger sample before their number means anything.

As of this writing: 4 of 13 ALCOS subjects already have calibrated floors (AP_Lang,
Math, Science, PE, per render.yaml's RETRIEVAL_FLOORS) — the other 9 (ELA, Math_AWF,
Social_Studies, Arts, DLCS, Health, World_Languages, Counseling, Special_Education),
plus every individual AP course (AP Biology, AP US History, etc. — golden_cases.json
has ~70+ of these, each currently on the global fallback floor), are still unmeasured
and are exactly what this audit should prioritize checking first.
