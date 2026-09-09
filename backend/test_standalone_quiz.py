"""Plan-free (standalone) quiz creation: a pasted passage -> MCQ -> QTI/DOCX
with no backing lesson plan.

The model call is stubbed (these tests are about the plumbing that used to
force every quiz through an already-built plan), but the QTI and DOCX builders
run for real, so a green run proves the whole decoupled pipeline end to end.
"""
from __future__ import annotations

import contextlib
from pathlib import Path

import pytest

from backend.routes import plans as plans_mod
from backend.routes import quizzes

CLASS = {"id": "c1", "name": "AP Language & Composition", "subject": "AP_Lang", "grade": "11"}

FIXTURE_QUIZ = {
    "title": "Rhetorical Analysis — Passage Quiz",
    "passages": [
        {"id": "passage_1", "title": "The Old Lighthouse",
         "text": "The old lighthouse had not shone in forty years, yet the townsfolk still spoke of it.",
         "source": "teacher_provided"},
    ],
    "questions": [
        {
            "type": "multiple_choice",
            "prompt": "What does the passage imply about the townsfolk?",
            "standard_code": "",
            "passage_id": "passage_1",
            "alignment": {"bloom": "analyze", "dok": 3, "cras": {
                "content_target": "author's purpose", "cognitive_operation": "infer",
                "evidence_basis": "textual detail", "rationale": "inference from detail"}},
            "choices": ["They fear the lighthouse", "They hold onto its memory", "They want it demolished"],
            "correct_index": 1,
            "correct_bool": False, "accepted_answers": [], "pairs": [],
        },
    ],
}


def _body(**kw) -> quizzes.StandaloneQuizRequest:
    return quizzes.StandaloneQuizRequest(**kw)


def _code(exc: Exception) -> str | None:
    return getattr(exc, "code", None)


def test_synthetic_plan_supplies_fields_the_artifact_builder_needs():
    plan = quizzes._synthetic_plan(CLASS)
    # _build_quiz_artifacts / qti_build.quiz_output_path read only these two.
    assert plan["course"]
    assert plan["week_of"]


def test_missing_class_is_404(monkeypatch):
    monkeypatch.setattr(quizzes.db, "get_class", lambda u, c: None)
    with pytest.raises(Exception) as ei:
        quizzes.create_standalone_quiz("nope", _body(), user_id="u1")
    assert _code(ei.value) == "class_not_found"


def test_unknown_question_type_defaults_to_multiple_choice(monkeypatch, tmp_path):
    monkeypatch.setattr(quizzes.db, "get_class", lambda u, c: CLASS)
    monkeypatch.setattr(quizzes, "require_entitlement", lambda u: None)
    monkeypatch.setattr(quizzes.generation_queue, "slot", lambda u: contextlib.nullcontext())
    seen = {}

    def fake_gen(*a, **k):
        seen["types"] = k.get("question_types")
        return FIXTURE_QUIZ

    monkeypatch.setattr(quizzes.llm, "generate_passage_quiz", fake_gen)
    monkeypatch.setattr(plans_mod.settings, "plans_dir", tmp_path)
    monkeypatch.setattr(plans_mod.storage, "mirror_file", lambda path: True)
    monkeypatch.setattr(quizzes.db, "create_quiz", lambda **kw: {"id": kw["quiz_id"], **kw})
    quizzes.create_standalone_quiz("c1", _body(question_types=["essay"], topic="irony"), user_id="u1")
    assert seen["types"] == ["multiple_choice"]


def test_empty_topic_falls_back_to_class_subject(monkeypatch, tmp_path):
    monkeypatch.setattr(quizzes.db, "get_class", lambda u, c: CLASS)
    monkeypatch.setattr(quizzes, "require_entitlement", lambda u: None)
    monkeypatch.setattr(quizzes.generation_queue, "slot", lambda u: contextlib.nullcontext())
    seen = {}

    def fake_gen(*a, **k):
        seen["topic"] = k.get("topic")
        return FIXTURE_QUIZ

    monkeypatch.setattr(quizzes.llm, "generate_passage_quiz", fake_gen)
    monkeypatch.setattr(plans_mod.settings, "plans_dir", tmp_path)
    monkeypatch.setattr(plans_mod.storage, "mirror_file", lambda path: True)
    monkeypatch.setattr(quizzes.db, "create_quiz", lambda **kw: {"id": kw["quiz_id"], **kw})
    quizzes.create_standalone_quiz("c1", _body(passage_mode="none", topic=""), user_id="u1")
    assert seen["topic"]


def test_teacher_provided_without_passage_never_substitutes_a_topic(monkeypatch):
    monkeypatch.setattr(quizzes.db, "get_class", lambda u, c: CLASS)
    monkeypatch.setattr(quizzes, "require_entitlement", lambda u: None)
    with pytest.raises(Exception) as error:
        quizzes.create_standalone_quiz(
            "c1", _body(passage_mode="teacher_provided", passage_text="   "), user_id="u1"
        )
    assert _code(error.value) == "passage_text_required"


def test_create_builds_planfree_quiz_end_to_end(monkeypatch, tmp_path):
    monkeypatch.setattr(quizzes.db, "get_class", lambda u, c: CLASS)
    monkeypatch.setattr(quizzes, "require_entitlement", lambda u: None)
    monkeypatch.setattr(quizzes.generation_queue, "slot", lambda u: contextlib.nullcontext())
    monkeypatch.setattr(quizzes.llm, "generate_passage_quiz", lambda *a, **k: FIXTURE_QUIZ)

    # Real QTI/DOCX builders, routed to tmp; pretend durable storage accepted them.
    monkeypatch.setattr(plans_mod.settings, "plans_dir", tmp_path)
    monkeypatch.setattr(plans_mod.storage, "mirror_file", lambda path: True)

    captured: dict = {}

    def fake_create_quiz(**kw):
        captured.update(kw)
        return {"id": kw["quiz_id"], **kw}

    monkeypatch.setattr(quizzes.db, "create_quiz", fake_create_quiz)

    quizzes.create_standalone_quiz(
        "c1",
        _body(passage_mode="teacher_provided", passage_text="A short passage.",
              passage_title="The Old Lighthouse", question_types=["multiple_choice"], num_questions=1),
        user_id="u1",
    )

    # The defining property of the decoupling: no plan, but a real quiz + files.
    assert captured["plan_id"] is None
    assert captured["class_id"] == "c1"
    assert captured["qti_path"] and captured["qti_path"].endswith(".zip")
    assert captured["docx_path"] and captured["docx_path"].endswith(".docx")
    assert Path(captured["qti_path"]).is_file()
    assert Path(captured["docx_path"]).is_file()
