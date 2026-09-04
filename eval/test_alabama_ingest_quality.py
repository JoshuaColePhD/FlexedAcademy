"""Regression tests for the deterministic Alabama ingestion quality gate."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.check_alabama_ingest import check_ingest


def _chunk(*, grade: int = 0, code: str = "ELA21.K.R1", **overrides) -> dict:
    row = {
        "code": code,
        "description": "Describe how a character responds to an event.",
        "course": "ELA",
        "grade": grade,
        "state": "AL",
        "source_type": "state_course_of_study",
        "source_document": "English Language Arts (2021).pdf",
        "case_framework": "English Language Arts (2021)",
        "source_case_id": "case-ela",
        "source_version": "2025-01-15T19:17:59+00:00",
        "source_package_sha256": "a" * 64,
        "source_pdf_sha256": "b" * 64,
        "source_ingested_at": "2026-09-02T00:00:00+00:00",
        "official_source_url": "https://example.edu/alabama-ela.pdf",
        "embed_text": "English Language Arts — Grade K [ELA21.K.R1] Describe how a character responds to an event.",
        "verbatim_ok": True,
        "wordwise_ok": True,
        "notes": [],
    }
    row.update(overrides)
    return row


def _report(*rows: dict, pdf_text_available: bool = True) -> list[dict]:
    first = rows[0]
    return [{
        "course": "ELA",
        "framework": first["case_framework"],
        "pdf": first["source_document"],
        "official_source_url": first["official_source_url"],
        "source_case_id": first["source_case_id"],
        "source_version": first["source_version"],
        "source_package_sha256": first["source_package_sha256"],
        "source_pdf_sha256": first["source_pdf_sha256"],
        "chunks": len(rows),
        "standards": len({(r["code"], r["description"]) for r in rows}),
        "verbatim_ok": 1,
        "wordwise_ok": 1,
        "unmatched": 0,
        "wordwise_rate": 100.0,
        "grades": sorted({r["grade"] for r in rows}),
        "pdf_text_available": pdf_text_available,
    }]


def test_kindergarten_grade_zero_is_valid() -> None:
    result = check_ingest(
        [_chunk()],
        _report(_chunk()),
        expected_courses={"ELA"},
        expected_grades={0},
    )
    assert result["ok"] is True
    assert not result["errors"]


def test_duplicate_identity_fails() -> None:
    row = _chunk()
    result = check_ingest([row, dict(row)], _report(row, dict(row)), expected_courses={"ELA"})
    assert result["ok"] is False
    assert any(issue["check"] == "duplicate_identity" for issue in result["errors"])


def test_unverified_pdf_is_a_gate_failure() -> None:
    row = _chunk()
    result = check_ingest(
        [row],
        _report(row, pdf_text_available=False),
        expected_courses={"ELA"},
    )
    assert result["ok"] is False
    assert any(issue["check"] == "pdf_verification" for issue in result["errors"])


def test_report_mismatch_fails() -> None:
    row = _chunk()
    report = _report(row)
    report[0]["chunks"] = 99
    result = check_ingest([row], report, expected_courses={"ELA"})
    assert result["ok"] is False
    assert any(issue["check"] == "report_consistency" for issue in result["errors"])
