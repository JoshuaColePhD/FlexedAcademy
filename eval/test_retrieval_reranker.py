"""Deterministic checks for the post-hybrid lexical tie-breaker."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.retrieval import rerank_score


def main() -> int:
    query = "students analyze rhetorical choices in a speech"
    relevant = {"document": "Analyze rhetorical choices and audience in a speech."}
    unrelated = {"document": "Calculate chemical reactions and laboratory measurements."}
    relevant_score = rerank_score(query, relevant)
    unrelated_score = rerank_score(query, unrelated)
    if not relevant_score > unrelated_score:
        print(f"FAIL — relevant score {relevant_score} is not above {unrelated_score}")
        return 1
    if not 0.0 <= relevant_score <= 0.06:
        print(f"FAIL — rerank bonus escaped its bound: {relevant_score}")
        return 1
    print("PASS — lexical reranking rewards shared content without changing the bounded distance floor.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
