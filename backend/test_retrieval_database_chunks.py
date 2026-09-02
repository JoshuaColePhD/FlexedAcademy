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
