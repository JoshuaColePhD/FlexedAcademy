"""Tests for loading the standards corpus without a Storage download."""
from __future__ import annotations

from backend import retrieval


def test_database_chunks_are_adapted_to_the_raw_loader_shape(monkeypatch):
    rows = [
        {
            "id": "AP_Lang:11:Grade11-1",
            "metadata": {
                "code": "Grade11-1",
                "course": "AP_Lang",
                "grade": 11,
                "description": "Read and evaluate texts.",
                "source_type": "state_course_of_study",
            },
        }
    ]

    monkeypatch.setattr(retrieval.settings, "database_url", "postgresql://test")
    monkeypatch.setattr(retrieval.db, "list_standard_chunks", lambda: rows)
    retrieval.load_chunks.cache_clear()

    try:
        result = retrieval.load_chunks()
    finally:
        retrieval.load_chunks.cache_clear()

    assert result == [{
        "id": "AP_Lang:11:Grade11-1",
        "code": "Grade11-1",
        "course": "AP_Lang",
        "grade": 11,
        "description": "Read and evaluate texts.",
        "source_type": "state_course_of_study",
    }]


def test_database_code_lookup_does_not_warm_full_corpus(monkeypatch):
    monkeypatch.setattr(retrieval.settings, "database_url", "postgresql://test")
    monkeypatch.setattr(
        retrieval.db,
        "find_standard_chunks_by_code",
        lambda codes, *, state, courses=None: (
            [{"id": "AP_Lang:11:RHS-2", "code": "RHS-2", "course": "AP_Lang"}]
            if courses == ["AP_Lang"]
            else []
        ),
    )
    monkeypatch.setattr(
        retrieval,
        "_chunks_by_state_course_and_code",
        lambda: (_ for _ in ()).throw(AssertionError("full corpus cache should not be used")),
    )

    assert retrieval.chunk_for_code("RHS-2", subject_code="AP_Lang", state="AL")["code"] == "RHS-2"
