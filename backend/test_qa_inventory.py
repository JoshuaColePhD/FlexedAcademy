"""Admin QA must not materialize the full standards corpus on Postgres."""
from __future__ import annotations

from backend import qa, retrieval


def test_spot_check_uses_compact_inventory(monkeypatch):
    inventory = retrieval._CodeInventory(
        anywhere=frozenset({"RHS-2", "E.CSE.301"}),
        by_course={"ap lang": frozenset({"RHS-2"})},
        by_course_and_grade={("ap lang", "11"): frozenset({"RHS-2"})},
        act=frozenset({"E.CSE.301"}),
    )
    monkeypatch.setattr(retrieval, "_code_inventory", lambda: inventory)
    monkeypatch.setattr(
        retrieval,
        "load_chunks",
        lambda: (_ for _ in ()).throw(AssertionError("full corpus cache should not be used")),
    )
    monkeypatch.setattr(
        retrieval,
        "chunks_by_code",
        lambda: (_ for _ in ()).throw(AssertionError("full corpus cache should not be used")),
    )

    result = qa.spot_check_plan(
        {
            "subject": "AP_Lang",
            "grade": 11,
            "retrieved_ids": ["RHS-2", "E.CSE.301", "NOT-A-CODE"],
        }
    )

    assert result["hallucinated"] == ["NOT-A-CODE"]
    assert result["mismatched"] == []
