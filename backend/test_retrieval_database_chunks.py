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
        "list_standard_course_identity",
        lambda: [{"course": "AP_Lang", "source_type": "college_board"}],
    )
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
    retrieval._course_identity_rows.cache_clear()
    retrieval._ap_courses.cache_clear()
    retrieval._courses_by_identity.cache_clear()
    retrieval._all_raw_courses.cache_clear()

    try:
        assert retrieval.chunk_for_code("RHS-2", subject_code="AP_Lang", state="AL")["code"] == "RHS-2"
    finally:
        retrieval._course_identity_rows.cache_clear()
        retrieval._ap_courses.cache_clear()
        retrieval._courses_by_identity.cache_clear()
        retrieval._all_raw_courses.cache_clear()


def test_course_identity_does_not_warm_full_corpus(monkeypatch):
    monkeypatch.setattr(retrieval.settings, "database_url", "postgresql://test")
    monkeypatch.setattr(
        retrieval.db,
        "list_standard_course_identity",
        lambda: [
            {"course": "AP_Lang", "source_type": "college_board"},
            {"course": "ELA", "source_type": "state_course_of_study"},
        ],
    )
    monkeypatch.setattr(
        retrieval,
        "load_chunks",
        lambda: (_ for _ in ()).throw(AssertionError("full corpus cache should not be used")),
    )
    for cache in (
        retrieval._course_identity_rows,
        retrieval._courses_by_identity,
        retrieval._all_raw_courses,
        retrieval._ap_courses,
    ):
        cache.cache_clear()

    try:
        assert retrieval.is_ap_course("AP_Lang") is True
        assert retrieval.is_ap_course("ELA") is False
        assert "AP_Lang" in retrieval.course_variants("AP_Lang")
    finally:
        for cache in (
            retrieval._course_identity_rows,
            retrieval._courses_by_identity,
            retrieval._all_raw_courses,
            retrieval._ap_courses,
        ):
            cache.cache_clear()


def test_code_inventory_does_not_warm_full_corpus(monkeypatch):
    monkeypatch.setattr(retrieval.settings, "database_url", "postgresql://test")
    monkeypatch.setattr(
        retrieval.db,
        "list_standard_code_metadata",
        lambda: [
            {
                "code": "RHS-2",
                "course": "AP_Lang",
                "state": "AP",
                "source_type": "college_board",
                "grade": "11",
            },
            {
                "code": "E.CSE.301",
                "course": "ACT English",
                "state": "National",
                "source_type": "act_standards",
                "grade": None,
            },
        ],
    )
    monkeypatch.setattr(
        retrieval,
        "load_chunks",
        lambda: (_ for _ in ()).throw(AssertionError("full corpus cache should not be used")),
    )
    retrieval._code_inventory.cache_clear()

    try:
        assert "RHS-2" in retrieval.codes_for_course("AP_Lang")
        assert "RHS-2" in retrieval.codes_for_course_and_grade("AP_Lang", 11)
        assert retrieval._code_inventory() is not None
        assert "E.CSE.301" in retrieval._code_inventory().act
    finally:
        retrieval._code_inventory.cache_clear()
