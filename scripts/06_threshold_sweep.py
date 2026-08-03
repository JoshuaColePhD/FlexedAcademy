#!/usr/bin/env python3
"""Step 6 — Pick the retrieval relevance floor empirically. Read-only.

RETRIEVAL_MAX_DISTANCE is specific to all-MiniLM-L6-v2 embeddings in Chroma's
default L2 space. It is MEANINGLESS if the embedding model or the chunking
strategy changes — re-run this and update .env if either does.

Selection rule: take the largest threshold that keeps every positive, and the
smallest that rejects every off-domain negative, then sit in the middle of that
band. As of 2026-08-04 that band is 0.73–0.82, giving 0.78.

Wrong-scope queries are reported separately and are NOT graded against the
floor, because no threshold can separate them: they are the same subject matter,
just outside what we parsed. "Grade 9 ELA standards" measures 0.411 — nearer than
most genuinely in-domain queries — because the corpus IS ELA standards. Grading
the floor against those would either destroy recall or produce the false
conclusion that no threshold exists. They are handled by
retrieval.out_of_scope_grades() and by the prompt rules plus grounding audit.

Usage:
    python scripts/06_threshold_sweep.py
"""
from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import retrieval  # noqa: E402
from backend.config import settings  # noqa: E402

# Kept in sync by hand with FLOOR_POSITIVES in scripts/05_eval_harness.py — that
# file gates on them, this one measures them.
POSITIVES = [
    "Week 3 SPACE CAT analysis of Letter from Birmingham Jail",
    "rhetorical analysis of a speech",
    "students need help with line of reasoning and evidence",
    "timed synthesis essay from six sources",
    "comma splices and subordination in student drafts",
    "Students need practice synthesizing graphic texts like charts and dashboards.",
    "I want a lesson plan on explaining how an argument understands the audience's beliefs.",
    "We are focusing on deleting irrelevant material in an essay.",
    "I need a lesson about evaluating tone and credibility through active listening.",
    "deleting irrelevant material in an essay",
    "evaluating tone and credibility through active listening",
]

# Genuinely different subject matter — this is what a distance floor is FOR.
OFF_DOMAIN = [
    "balancing chemical equations in stoichiometry",
    "solve quadratic equations by factoring",
    "pizza recipe with sourdough crust",
    "asdf qwerty zxcv",
    "AP Calculus BC unit 3 derivatives",
    "photosynthesis lab for biology",
]

# Wrong-scope queries. These are NEAR in embedding space — they are the same
# subject, just outside what we parsed — so no threshold separates them and it is
# a mistake to grade the floor against them. "Grade 9 ELA standards" measures
# 0.411, nearer than most real queries, because the corpus IS ELA standards.
# retrieval.out_of_scope_grades() handles the grade case deterministically;
# prompt rules plus the grounding audit handle the unit/family cases.
WRONG_SCOPE = [
    "Grade 9 ELA standards",
    "Grade 12 ELA standards for research writing",
    "Unit 8 skills on style and complexity",
    "ACT Reading CLR 501 close reading standard",
    "Unit 9 AP exam prep skills",
]

TOP_K = 5


def best_distances(queries: list[str]) -> dict[str, float]:
    """Nearest-neighbour distance per query — one embedding pass each."""
    out = {}
    for q in queries:
        hits = retrieval.retrieve_raw(q, n=TOP_K)
        out[q] = min(h["distance"] for h in hits) if hits else float("inf")
    return out


def main() -> int:
    print("Embedding queries (this loads the MiniLM model once)...\n")
    pos = best_distances(POSITIVES)
    off = best_distances(OFF_DOMAIN)
    gap = best_distances(WRONG_SCOPE)

    def table(title: str, data: dict[str, float]) -> None:
        print(f"{title}")
        for q, d in sorted(data.items(), key=lambda kv: kv[1]):
            print(f"  {d:6.3f}  {q[:66]}")
        print()

    table("IN-DOMAIN (must be kept)", pos)
    table("OFF-DOMAIN (must be rejected)", off)
    table("WRONG SCOPE (near by design — guards, not distance, catch these)", gap)

    worst_pos = max(pos.values())
    best_off = min(off.values())
    print(f"Hardest positive : {worst_pos:.3f}")
    print(f"Nearest off-domain: {best_off:.3f}")

    if worst_pos >= best_off:
        print(
            "\nNO SEPARATING THRESHOLD EXISTS — an off-domain query is closer than a\n"
            "real one. Do not paper over this with a threshold; the corpus or the\n"
            "embedding model needs attention."
        )
        return 1

    print("\n  t     positives kept   off-domain rejected")
    step = 0.01
    t = round(worst_pos - 0.05, 2)
    recommended = None
    while t <= best_off + 0.05:
        kept = sum(1 for d in pos.values() if d <= t)
        rejected = sum(1 for d in off.values() if d > t)
        flag = ""
        if kept == len(pos) and rejected == len(off):
            flag = "  <- viable"
            if recommended is None:
                recommended = t
        print(f"  {t:.2f}   {kept:2d}/{len(pos)}            {rejected:2d}/{len(off)}{flag}")
        t = round(t + step, 2)

    midpoint = round((worst_pos + best_off) / 2, 2)
    print(f"\nViable band    : {worst_pos:.3f} .. {best_off:.3f}")
    print(f"Recommended    : {midpoint:.2f}  (midpoint — maximum margin either side)")
    print(f"Currently set  : {settings.retrieval_max_distance:.2f}")
    if abs(midpoint - settings.retrieval_max_distance) > 0.03:
        print(
            f"\n  Drift: consider setting RETRIEVAL_MAX_DISTANCE={midpoint:.2f} in .env"
        )
    else:
        print("\n  Configured floor is within tolerance of the measured midpoint.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
