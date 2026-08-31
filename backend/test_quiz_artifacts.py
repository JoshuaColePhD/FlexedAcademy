"""Contract tests for the quiz's durable Word and QTI artifact pair."""

from zipfile import ZipFile

from backend import quiz_docx
from backend.routes import plans

QUIZ = {
    "title": "Week 06 Quiz — Logarithms",
    "questions": [
        {
            "type": "multiple_choice",
            "prompt": "Which form is equivalent to 2^5 = 32?",
            "standard_code": "M.F.707",
            "choices": ["log_2(32) = 5", "log_5(32) = 2", "log_2(5) = 32"],
            "correct_index": 0,
            "correct_bool": False,
            "accepted_answers": [],
            "pairs": [],
        },
        {
            "type": "true_false",
            "prompt": "The domain of log(x) requires x > 0.",
            "standard_code": "M.F.707",
            "choices": [],
            "correct_index": -1,
            "correct_bool": True,
            "accepted_answers": [],
            "pairs": [],
        },
    ],
}


def test_quiz_docx_is_valid_and_contains_answer_key(tmp_path):
    path = tmp_path / "quiz.docx"

    quiz_docx.build_quiz_docx(QUIZ, path)

    assert quiz_docx.is_valid_docx(path)
    with ZipFile(path) as archive:
        document_xml = archive.read("word/document.xml").decode("utf-8")
    assert "Teacher Answer Key" in document_xml
    assert "log_2(32) = 5" in document_xml


def test_quiz_artifact_builder_records_only_durable_files(monkeypatch, tmp_path):
    monkeypatch.setattr(plans.settings, "plans_dir", tmp_path)
    monkeypatch.setattr(plans.storage, "mirror_file", lambda path: path.suffix == ".docx")

    qti_path, docx_path, warnings = plans._build_quiz_artifacts(
        QUIZ,
        {"course": "Algebra 2", "week_of": "Week 06 — Sep 7-11, 2026"},
        "a" * 32,
    )

    assert qti_path is None
    assert docx_path is not None
    assert any("QTI" in warning for warning in warnings)


def test_quiz_route_requires_matching_plan(monkeypatch):
    monkeypatch.setattr(plans.db, "get_quiz", lambda user_id, quiz_id: {"plan_id": "other-plan"})

    try:
        plans._require_quiz("user", "expected-plan", "quiz")
    except Exception as exc:  # noqa: BLE001 - assert the stable API error without DB setup
        assert getattr(exc, "code", None) == "quiz_not_found"
    else:  # pragma: no cover
        raise AssertionError("a quiz from another plan must not be addressable through this route")
