"""Regression coverage for Weeden's hand-authored district form."""
from __future__ import annotations

import importlib.util
import tempfile
import zipfile
from pathlib import Path


_HERE = Path(__file__).resolve().parent


def _builder():
    spec = importlib.util.spec_from_file_location("weeden_builder", _HERE / "weeden-elementary-school_builder.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _plan():
    days = []
    for name in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"):
        days.append({
            "name": name, "no_school": False,
            "standards": "ELA21.6.2 — Analyze evidence", "learning_targets": "I can analyze evidence.",
            "do_now": "Annotate a passage.", "vocabulary": "evidence; inference",
            "during": "I Do: Model.\nWe Do: Practice.\nYou Do: Write.",
            "assessment": "Exit ticket.", "reteach_small_groups": "Reteach claim/evidence matching.",
            "cross_curricular_connection": "Science: evaluate a data claim.",
        })
    return {"teacher": "Jane Smith", "course": "English Language Arts · 6th", "week_of": "Week 01", "days": days}


def test_weeden_builder_preserves_template_sections_and_weekly_standard_merge():
    with tempfile.TemporaryDirectory() as tmp:
        output = Path(tmp) / "weeden.docx"
        _builder().build(_plan(), str(output))
        with zipfile.ZipFile(output) as archive:
            xml = archive.read("word/document.xml").decode("utf-8")

    for label in ("Standard/", "Learning Target/", "Do Now-Bell Ringer", "Vocabulary", "I Do/We Do/You Do", "Exit Ticket", "Reteach/Small", "Cross-Curriculum"):
        assert label in xml
    assert "E06666" in xml and "E69138" in xml and "3D85C6" in xml
    # The Standards/DOK content cell spans the five weekday columns.
    assert '<w:gridSpan w:val="5"/>' in xml


def test_rejected_codegen_attempts_are_never_activated(monkeypatch):
    from backend.builder import codegen

    calls = []
    monkeypatch.setattr(codegen.db, "mark_builder_codegen_job_failed", lambda job_id, message: calls.append((job_id, message)))
    monkeypatch.setattr(codegen.db, "mark_builder_codegen_job_succeeded", lambda *args: (_ for _ in ()).throw(AssertionError("must not activate")))
    monkeypatch.setattr(codegen.db, "mark_builder_codegen_job_auto_verified", lambda *args: (_ for _ in ()).throw(AssertionError("must not verify")))

    codegen._fail_after_exhausted_attempts("job-1", [{"layout_spec_json": "{}"}])
    assert calls and calls[0][0] == "job-1"


if __name__ == "__main__":
    test_weeden_builder_preserves_template_sections_and_weekly_standard_merge()
    test_rejected_codegen_attempts_are_never_activated(type("MonkeyPatch", (), {"setattr": setattr})())
    print("PASS: Weeden builder preserves its district form")
