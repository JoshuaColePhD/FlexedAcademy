"""Pure contract tests for passage-aware quiz reuse and publish safety."""
from __future__ import annotations

from zipfile import ZipFile

from backend import qti_build, quiz_docx, quiz_library, schema


QUIZ = {
    "title": "Tone Passage Set",
    "passages": [{
        "id": "p1",
        "title": "A staged calm",
        "text": "The room was quiet, almost too quiet. Each short sentence closed a door before the next one opened.",
        "source": "ai_generated",
    }],
    "questions": [{
        "type": "multiple_choice",
        "passage_id": "p1",
        "prompt": "Which inference is best supported?",
        "standard_code": "RHS-2A",
        "choices": ["The quiet contains tension.", "The room is crowded.", "The narrator is giving directions."],
        "correct_index": 0,
        "correct_bool": False,
        "accepted_answers": [],
        "pairs": [],
        "alignment": {
            "bloom": "analyze",
            "dok": 3,
            "cras": {
                "content_target": "Tone",
                "cognitive_operation": "Infer",
                "evidence_basis": "Short sentences",
                "rationale": "Students connect syntax to implied tension.",
            },
        },
    }],
}


def test_passage_quiz_validates_and_hashes_deterministically():
    assert schema.validate_quiz(QUIZ) == []
    assert quiz_library.content_hash(QUIZ) == quiz_library.content_hash({**QUIZ, "title": "A different title"})
    assert quiz_library.validate_publishable(QUIZ, source="ai_generated", approved=False) == []


def test_invalid_passage_link_is_fatal():
    bad = {**QUIZ, "questions": [{**QUIZ["questions"][0], "passage_id": "missing"}]}
    try:
        schema.validate_quiz(bad)
    except schema.QuizSchemaError as exc:
        assert "passage_id" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("a question must reference a real passage")


def test_teacher_passages_require_explicit_permission():
    teacher_quiz = {**QUIZ, "passages": [{**QUIZ["passages"][0], "source": "teacher_provided"}]}
    assert quiz_library.validate_publishable(teacher_quiz, source="teacher_provided", approved=False) == []
    assert quiz_library.sensitive_content({"passages": [{"text": "Student name: Jamie"}]})


def test_exports_repeat_the_linked_passage_and_keep_alignment_in_teacher_key(tmp_path):
    qti_path = tmp_path / "passage.zip"
    qti_build.build_qti_zip(QUIZ, qti_path)
    with ZipFile(qti_path) as archive:
        xml = "".join(archive.read(name).decode() for name in archive.namelist() if name != "imsmanifest.xml")
    assert "A staged calm" in xml
    assert "The room was quiet" in xml

    docx_path = tmp_path / "passage.docx"
    quiz_docx.build_quiz_docx(QUIZ, docx_path)
    with ZipFile(docx_path) as archive:
        xml = archive.read("word/document.xml").decode()
    assert "A staged calm" in xml
    assert "CRAS" in xml
