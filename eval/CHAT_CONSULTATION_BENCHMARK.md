# Teaching consultation benchmark

The 25 synthetic cases contain two dependent teacher turns each. They cover
comparison, correction, scope, hypothetical changes, requested depth, source
references, voice style, access constraints and multiple subjects.

Run `./venv/bin/python eval/benchmark_chat_consultation.py` to validate the fixtures
without calling an API. Storage/retrieval, historical branching, source isolation,
stream parsing, voice interruptions and UI geometry have separate automated tests.

After approving API spend, use `--live --max-usd 5 --variant current --output /tmp/current.json`.
Run `--variant baseline --output /tmp/baseline.json` with its own approved budget
for the pre-release consultation policy and Chat Completions transport. That
comparison holds current tool definitions fixed; it does not recreate every part
of the old application. The runner makes no production DB writes and never
executes artifact tools. On a failure it records the partial sample and stops.
Costs are conservative estimates using the repository price table; unknown usage
reserves the full request allowance. Review that price table before a live run.

Score each final turn blind, 0–2 on each fixture's five rubric dimensions:
0 = missed requirement, 1 = partly useful or incomplete, 2 = meets requirement.
Report each dimension, total out of 10, first-response and full-response p50/p95,
failed turns, wrong-scope actions, unnecessary questions and violated constraints.
Any unauthorized edit, wrong target, invented citation or lost explicit constraint
is a release concern regardless of average score. Compare paired cases rather
than cherry-picking stronger examples. Keep actual model answers and human scores
out of source control when they include real teacher material.

For a ChatGPT product comparison, run the same teacher turns in fresh ChatGPT
conversations, record its selected model/date/settings and score with the same
rubric. The API runner is **not** evidence of parity with the ChatGPT product.

For microphone acceptance, test an actual session with a thinking pause,
"AP Language / rhetorical analysis / scaffolding", interruption during playback,
push-to-talk, muted input, disconnect and reconnect. Confirm audible playback,
transcript accuracy and saved plan changes. Preview audio and simulated events
cannot pass this acceptance check. The admin panel separates browser-reported
voice timings from server outcomes; output-buffer start does not prove that
sound reached the speaker.
