"""Read-only A/B test for the current production retrieval ranker.

A is the current ranker, including the bounded lexical reranking bonus.
B is the immediately prior ranker, with that bonus disabled. Both variants use
the same live corpus, embedding vector, filters, thresholds, and stratified
retrieval path. This isolates the ranking change; it is not a comparison to the
deleted pre-cutover database snapshot.

Run: ./venv/bin/python eval/test_retrieval_ab.py
"""
from __future__ import annotations

import importlib
import json
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
GOLDEN = PROJECT_ROOT / "data" / "eval" / "current_golden_cases.json"
sys.path.insert(0, str(PROJECT_ROOT))

retrieval = importlib.import_module("backend.retrieval")


OFF_DOMAIN = [
    ("AP_Lang", "balancing redox half-reactions and calculating cell potential"),
    ("AP_Lang", "implementing a red-black tree rotation in Java"),
    ("AP_Lang", "asdfgh qwerty zxcvbn nonsense tokens"),
    ("Math", "analyzing the tone and diction of a Toni Morrison passage"),
    ("AP Physics 1", "conjugating irregular preterite verbs in Spanish"),
    ("AP Biology", "the fiscal multiplier and crowding out"),
    ("AP US History", "titrating a weak acid with a strong base"),
]

IN_DOMAIN = [
    ("AP_Lang", "rhetorical analysis of Letter from Birmingham Jail"),
    ("AP Physics 1", "forces and free-body diagrams"),
    ("AP US History", "sourcing and corroborating primary documents"),
    ("AP_Lang", "We are focusing on deleting irrelevant material in an essay."),
    ("AP_Lang", "teaching transitions between paragraphs"),
    ("AP_Lang", "comma splices and subordination in student drafts"),
]


def norm_code(value: object) -> str:
    return retrieval._norm_code(str(value))


def result_codes(result) -> list[str]:
    return [norm_code((chunk.get("metadata") or {}).get("code") or chunk["id"])
            for chunk in result.chunks]


def result_summary(result, expected: str | None = None, course: str | None = None) -> dict:
    codes = result_codes(result)
    expected_rank = codes.index(norm_code(expected)) + 1 if expected and norm_code(expected) in codes else None
    variants = retrieval.course_variants(course) if course else frozenset()
    wrong_course = 0
    for chunk in result.chunks:
        metadata = chunk.get("metadata") or {}
        if metadata.get("source_type") in ("act_standards", "act_recurring"):
            continue
        if course and metadata.get("course") not in variants:
            wrong_course += 1
    return {
        "empty": result.empty,
        "codes": codes,
        "expected_rank": expected_rank,
        "wrong_course_hits": wrong_course,
    }


def run_pair(query: str, course: str, grade: int = 11, expected: str | None = None) -> dict:
    """Run A and B with one shared query vector so API work is not duplicated."""
    vector = retrieval.embed_query(query)
    original_embed_queries = retrieval.embed_queries
    original_rerank_score = retrieval.rerank_score

    def run(use_reranker: bool) -> tuple[dict, float]:
        retrieval.embed_queries = lambda searches: {search: vector for search in searches}
        retrieval.rerank_score = original_rerank_score if use_reranker else lambda *_args: 0.0
        started = time.perf_counter()
        try:
            result = retrieval.retrieve_grounded(query, subject_code=course, grade=grade, top_k=20)
        finally:
            retrieval.embed_queries = original_embed_queries
            retrieval.rerank_score = original_rerank_score
        return result_summary(result, expected=expected, course=course), (time.perf_counter() - started) * 1000

    a, a_ms = run(True)
    b, b_ms = run(False)
    return {"a": a, "b": b, "a_ms": round(a_ms, 2), "b_ms": round(b_ms, 2)}


def summarize(rows: list[dict], *, expected: bool) -> dict:
    cases = len(rows)
    out = {
        "cases": cases,
        "mean_latency_ms": round(sum(row["ms"] for row in rows) / cases, 2) if cases else 0.0,
        "answered": sum(not row["result"]["empty"] for row in rows),
        "wrong_course_cases": sum(row["result"]["wrong_course_hits"] > 0 for row in rows),
    }
    if expected:
        out.update({
            "recall_at_5": sum(row["result"]["expected_rank"] is not None and row["result"]["expected_rank"] <= 5 for row in rows),
            "recall_at_20": sum(row["result"]["expected_rank"] is not None and row["result"]["expected_rank"] <= 20 for row in rows),
            "mean_expected_rank": round(sum(row["result"]["expected_rank"] or 21 for row in rows) / cases, 2) if cases else 0.0,
        })
    return out


def main() -> int:
    if not GOLDEN.is_file():
        print(f"FAIL — missing {GOLDEN.relative_to(PROJECT_ROOT)}")
        return 1

    cases = json.loads(GOLDEN.read_text(encoding="utf-8"))
    paired = []
    for index, case in enumerate(cases, start=1):
        print(f"  {index:02d}/{len(cases)} {case['course']}: {case['expected_code']}", flush=True)
        paired.append({
            "kind": "golden",
            "label": f"{case['course']}:{case['expected_code']}",
            "pair": run_pair(case["query"], case["course"], int(case["grade"]), case["expected_code"]),
        })

    for course, query in OFF_DOMAIN:
        print(f"  off-domain {course}: {query[:44]}", flush=True)
        paired.append({"kind": "off_domain", "label": f"{course}:{query}", "pair": run_pair(query, course)})
    for course, query in IN_DOMAIN:
        print(f"  in-domain {course}: {query[:44]}", flush=True)
        paired.append({"kind": "in_domain", "label": f"{course}:{query}", "pair": run_pair(query, course)})

    variants = {}
    for variant, name in (("a", "current_with_reranker"), ("b", "previous_without_reranker")):
        variants[name] = {}
        for kind, expected in (("golden", True), ("off_domain", False), ("in_domain", False)):
            rows = [{"result": item["pair"][variant], "ms": item["pair"][f"{variant}_ms"]}
                    for item in paired if item["kind"] == kind]
            variants[name][kind] = summarize(rows, expected=expected)

    golden_pairs = [item for item in paired if item["kind"] == "golden"]
    rank_wins = sum(
        (item["pair"]["a"]["expected_rank"] or 21) < (item["pair"]["b"]["expected_rank"] or 21)
        for item in golden_pairs
    )
    rank_losses = sum(
        (item["pair"]["a"]["expected_rank"] or 21) > (item["pair"]["b"]["expected_rank"] or 21)
        for item in golden_pairs
    )
    changed = [
        item["label"] for item in golden_pairs
        if item["pair"]["a"]["codes"] != item["pair"]["b"]["codes"]
    ]
    report = {
        "variants": variants,
        "golden_rank_comparison": {
            "a_wins": rank_wins,
            "b_wins": rank_losses,
            "ties": len(golden_pairs) - rank_wins - rank_losses,
            "changed_top20_order_or_membership": len(changed),
            "changed_cases": changed,
        },
    }
    print("\n" + json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
