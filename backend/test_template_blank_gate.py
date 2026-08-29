"""Upload-boundary tests for reusable lesson-plan templates."""
from __future__ import annotations

from pathlib import Path

import pytest

from backend import template_intake
from backend.errors import AppError


def _structure(*, total_text_chars: int = 300, cells: list[str] | None = None) -> dict:
    return {
        "total_text_chars": total_text_chars,
        "tables": [{"sample_rows": [cells or ["Learning target", "Monday", "Tuesday"]]}],
    }


def _use_structure(monkeypatch, structure: dict) -> None:
    monkeypatch.setattr(template_intake, "_extract_docx_structure", lambda _path: structure)
    monkeypatch.setattr(template_intake, "_extract_pdf_structure", lambda _path: structure)


def test_blank_template_with_labels_is_accepted(monkeypatch):
    _use_structure(monkeypatch, _structure(cells=["Learning target", "Vocabulary", "I Do / We Do / You Do"]))

    template_intake.require_blank_template(Path("blank.docx"), ".docx")


def test_completed_template_is_rejected(monkeypatch):
    _use_structure(monkeypatch, _structure(total_text_chars=9_000))

    with pytest.raises(AppError, match="completed lesson plan") as error:
        template_intake.require_blank_template(Path("completed.docx"), ".docx")

    assert error.value.code == "template_not_blank"


def test_template_with_personal_contact_data_is_rejected(monkeypatch):
    _use_structure(monkeypatch, _structure(cells=["Teacher: Jane Smith", "jane.smith@example.org"]))

    with pytest.raises(AppError, match="email address") as error:
        template_intake.require_blank_template(Path("contact.docx"), ".docx")

    assert error.value.code == "template_contains_personal_data"
