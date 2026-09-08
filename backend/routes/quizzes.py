"""Standalone quizzes: passage/topic -> MCQ -> QTI without a lesson plan.

The companion to routes/plans.py's plan-scoped quiz routes. Migration 87 made
quizzes.plan_id optional, so a teacher can paste a passage (or name a topic) and
get a downloadable quiz + QTI without first building a whole week — the exact
gap behind "I pasted a passage, asked for multiple choice + a QTI, and it
errored out." The artifact builders only need a {course, week_of} stand-in (see
test_quiz_artifacts), so no real plan is required to name and write the files.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import db, docx_build, llm, qti_build, schema, storage
from ..config import settings
from ..deps import get_current_user
from ..entitlement import require_entitlement
from ..errors import AppError
from ..generation_queue import generation_queue
from .plans import _build_quiz_artifacts

log = logging.getLogger("flexedacademy.routes.quizzes")
router = APIRouter(prefix="/api", tags=["quizzes"])

PASSAGE_MODES = {"none", "teacher_provided", "ai_generated"}

_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


class StandaloneQuizRequest(BaseModel):
    question_types: list[str] = Field(default_factory=lambda: ["multiple_choice"])
    num_questions: int = Field(default=10, ge=1, le=50)
    passage_mode: str = "none"
    passage_text: str | None = Field(default=None, max_length=settings.max_generation_context_chars)
    passage_title: str | None = Field(default=None, max_length=200)
    topic: str | None = Field(default=None, max_length=500)


def _synthetic_plan(cls: dict) -> dict:
    """A minimal {course, week_of} stand-in so the shared artifact builders —
    which read only those two fields to name the QTI/DOCX files — can work for a
    quiz that has no real week behind it."""
    course = cls.get("name") or cls.get("subject") or "Quiz"
    stamp = datetime.now(UTC).strftime("%Y-%m-%d")
    return {"course": course, "week_of": f"Quiz {stamp}"}


def _require_standalone_quiz(user_id: str, quiz_id: str) -> dict:
    row = db.get_quiz(user_id, quiz_id)
    if not row:
        raise AppError("quiz_not_found", "No such quiz.", status=404)
    return row


@router.post("/classes/{class_id}/quizzes", status_code=201)
def create_standalone_quiz(
    class_id: str, body: StandaloneQuizRequest, user_id: str = Depends(get_current_user)
) -> dict:
    """Write, validate, and save a plan-free quiz for a class.

    Gated by require_entitlement exactly like routes/plans.create_quiz — a real
    model call spending real tokens. Synchronous for the same reason: generation
    plus the two local artifact writes finish inside one request, and the
    structured quiz row is still saved even if an export fails.
    """
    cls = db.get_class(user_id, class_id)
    if not cls:
        raise AppError("class_not_found", "That class doesn't exist.", status=404)
    require_entitlement(user_id)

    unknown = set(body.question_types) - set(schema.QUESTION_TYPES)
    if unknown:
        raise AppError(
            "unknown_question_type",
            f"Unknown question type(s): {', '.join(sorted(unknown))}.",
            status=400,
            hint=f"Valid types: {', '.join(schema.QUESTION_TYPES)}.",
        )
    if body.passage_mode not in PASSAGE_MODES:
        raise AppError("bad_passage_mode", f"Unknown passage_mode {body.passage_mode!r}.", status=400)
    if body.passage_mode == "teacher_provided" and not (body.passage_text or "").strip():
        raise AppError(
            "passage_text_required",
            "A passage is required when passage_mode is 'teacher_provided'.",
            status=400,
        )
    if body.passage_mode != "teacher_provided" and not (body.topic or "").strip():
        raise AppError(
            "topic_required",
            "A topic is required unless you provide a passage.",
            status=400,
        )

    with generation_queue.slot(user_id):
        # A request may have waited behind another generation long enough for
        # the weekly allowance to change; re-check at the actual model start.
        require_entitlement(user_id)
        quiz_raw = llm.generate_passage_quiz(
            user_id,
            subject=cls.get("subject") or "",
            grade=cls.get("grade") or "",
            question_types=body.question_types,
            num_questions=body.num_questions,
            class_id=class_id,
            passage_mode=body.passage_mode,
            passage_text=body.passage_text,
            passage_title=body.passage_title,
            topic=body.topic,
        )
    try:
        warnings = schema.validate_quiz(quiz_raw)
    except schema.QuizSchemaError as e:
        raise AppError(
            "quiz_schema_error",
            f"The generated quiz wasn't usable: {e}",
            status=502,
            hint="Try asking for the quiz again — this is a one-sample formatting slip, not a structural problem.",
        ) from e

    quiz_id = db.new_id()
    qti_path, docx_path, artifact_warnings = _build_quiz_artifacts(quiz_raw, _synthetic_plan(cls), quiz_id)
    warnings = [*warnings, *artifact_warnings]

    return db.create_quiz(
        quiz_id=quiz_id,
        user_id=user_id,
        plan_id=None,
        class_id=class_id,
        title=quiz_raw.get("title") or f"{cls.get('name') or 'Class'} Quiz",
        question_types=body.question_types,
        quiz_json=quiz_raw,
        qti_path=qti_path,
        docx_path=docx_path,
        warnings=warnings,
    )


@router.get("/classes/{class_id}/quizzes")
def list_standalone_quizzes(class_id: str, user_id: str = Depends(get_current_user)) -> list[dict]:
    if not db.get_class(user_id, class_id):
        raise AppError("class_not_found", "That class doesn't exist.", status=404)
    return db.list_standalone_quizzes_for_class(user_id, class_id)


@router.get("/quizzes/{quiz_id}/download")
def download_standalone_quiz(quiz_id: str, user_id: str = Depends(get_current_user)):
    row = _require_standalone_quiz(user_id, quiz_id)
    path_str = row.get("qti_path")
    if not path_str:
        raise AppError(
            "qti_missing",
            "This quiz's QTI file could not be built.",
            status=409,
            hint="See its warnings, or ask for the quiz again — the quiz content is safe in the database.",
        )
    p = Path(path_str).resolve()
    if not p.is_relative_to(Path(settings.plans_dir).resolve()) or not storage.ensure_local(p):
        raise AppError(
            "qti_missing",
            "The QTI file for this quiz is missing.",
            status=404,
            hint="Ask for the quiz again — the content is safe in the database.",
        )
    return FileResponse(
        path=str(p),
        filename=f"{docx_build.safe_filename(row['title'])}.zip",
        media_type=qti_build.QTI_MIME,
    )


@router.get("/quizzes/{quiz_id}/download-docx")
def download_standalone_quiz_docx(quiz_id: str, user_id: str = Depends(get_current_user)):
    row = _require_standalone_quiz(user_id, quiz_id)
    path_str = row.get("docx_path")
    if not path_str:
        raise AppError(
            "quiz_docx_missing",
            "This quiz's Word file could not be built.",
            status=409,
            hint="Ask for the quiz again — the quiz content is safe in the database.",
        )
    p = Path(path_str).resolve()
    if not p.is_relative_to(Path(settings.plans_dir).resolve()) or not storage.ensure_local(p):
        raise AppError(
            "quiz_docx_missing",
            "The Word file for this quiz is missing.",
            status=404,
            hint="Ask for the quiz again — the content is safe in the database.",
        )
    return FileResponse(
        path=str(p),
        filename=f"{docx_build.safe_filename(row['title'])}.docx",
        media_type=_DOCX_MIME,
    )


@router.delete("/quizzes/{quiz_id}", status_code=204)
def delete_standalone_quiz(quiz_id: str, user_id: str = Depends(get_current_user)) -> None:
    row = db.get_quiz(user_id, quiz_id)
    if row:
        for path_str in (row.get("qti_path"), row.get("docx_path")):
            if path_str:
                pp = Path(path_str).resolve()
                if pp.is_relative_to(Path(settings.plans_dir).resolve()):
                    storage.remove_file(pp)
    if not db.delete_quiz(user_id, quiz_id):
        raise AppError("quiz_not_found", "No such quiz.", status=404)
