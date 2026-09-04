"""Authenticated API for teacher-approved shared passage/question sets."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from .. import db, embeddings, quiz_library
from ..deps import get_current_user
from ..errors import AppError

log = logging.getLogger("flexedacademy.routes.quiz_library")
router = APIRouter(prefix="/api/quiz-library", tags=["quiz-library"])


class LibrarySaveRequest(BaseModel):
    permission_confirmed: bool = False


class LibraryApproveRequest(BaseModel):
    permission_confirmed: bool = False


class LibraryReportRequest(BaseModel):
    reason: str = ""


def _academic_context(user_id: str, plan: dict) -> tuple[str, str]:
    cls = db.get_class(user_id, plan.get("class_id")) if plan.get("class_id") else None
    if cls:
        return str(cls.get("subject") or plan.get("course") or ""), str(cls.get("grade") or "")
    settings = db.get_settings_row(user_id)
    return str(settings.get("subject") or plan.get("course") or ""), str(settings.get("grade") or "")


def _public_row(row: dict, user_id: str) -> dict:
    payload = dict(row)
    payload.pop("creator_user_id", None)
    payload.pop("embedding", None)
    payload.pop("context_text", None)
    payload["is_owner"] = row.get("creator_user_id") == user_id
    payload["provenance_label"] = "Your library" if payload["is_owner"] else "Shared library"
    return payload


def _embedding_for(*, context_text: str, quiz_json: dict) -> list[float] | None:
    passages = "\n\n".join(str(p.get("text") or "") for p in (quiz_json.get("passages") or []))
    prompts = "\n".join(str(q.get("prompt") or "") for q in (quiz_json.get("questions") or []))
    try:
        return embeddings.embed_query(f"{context_text}\n{passages}\n{prompts}"[:12000])
    except Exception as exc:  # noqa: BLE001 - exact filters still provide a useful fallback
        log.warning("quiz library embedding failed; storing an exact-filter-only item: %s", exc)
        return None


@router.get("")
def list_library(user_id: str = Depends(get_current_user)) -> list[dict]:
    return [_public_row(row, user_id) for row in db.list_quiz_library_sets_for_user(user_id)]


@router.get("/suggestions")
def library_suggestions(
    plan_id: str = Query(...),
    user_id: str = Depends(get_current_user),
) -> list[dict]:
    plan = db.get_plan(user_id, plan_id)
    if not plan:
        raise AppError("plan_not_found", "No such plan.", status=404)
    subject, grade = _academic_context(user_id, plan)
    plan_json = {**(plan.get("plan_json") or {}), "course": plan.get("course") or ""}
    context = quiz_library.context_values(plan=plan_json, quiz_json={}, subject=subject, grade=grade)
    plan_standards = quiz_library.standards_from_plan(plan_json)
    vector = _embedding_for(context_text=context["context_text"], quiz_json=plan_json)
    rows = db.search_quiz_library_sets(
        course=context["course"],
        subject=context["subject"],
        grade=context["grade"],
        standard_codes=plan_standards,
        query_embedding=vector,
    )
    return [_public_row(row, user_id) for row in rows]


@router.post("/sets/{library_id}/use")
def use_library_set(library_id: str, user_id: str = Depends(get_current_user)) -> dict:
    row = db.get_quiz_library_set(user_id, library_id)
    if not row:
        raise AppError("library_item_not_found", "That shared item is no longer available.", status=404)
    db.increment_quiz_library_usage(library_id)
    return quiz_library.reusable_quiz_json(row)


@router.post("/sets/{library_id}/approve")
def approve_library_set(
    library_id: str,
    body: LibraryApproveRequest,
    user_id: str = Depends(get_current_user),
) -> dict:
    row = db.get_quiz_library_set(user_id, library_id)
    if not row or row.get("creator_user_id") != user_id:
        raise AppError("library_item_not_found", "That library item is not yours.", status=404)
    source = row.get("passage_source")
    if source == "teacher_provided" and not body.permission_confirmed:
        raise AppError(
            "permission_confirmation_required",
            "Confirm that you have permission to share this teacher-provided passage.",
            status=400,
        )
    reasons = quiz_library.validate_publishable(row.get("quiz_json") or {}, source=source, approved=True)
    if reasons:
        raise AppError("library_item_not_publishable", " ".join(reasons), status=400)
    updated = db.approve_quiz_library_set(
        user_id, library_id, permission_confirmed=body.permission_confirmed or source != "teacher_provided"
    )
    return _public_row(updated, user_id)


@router.post("/sets/{library_id}/unpublish")
def unpublish_library_set(library_id: str, user_id: str = Depends(get_current_user)) -> dict:
    updated = db.unpublish_quiz_library_set(user_id, library_id)
    if not updated:
        raise AppError("library_item_not_found", "That library item is not yours.", status=404)
    return _public_row(updated, user_id)


@router.post("/sets/{library_id}/report")
def report_library_set(
    library_id: str,
    body: LibraryReportRequest,
    user_id: str = Depends(get_current_user),
) -> dict:
    row = db.get_quiz_library_set(user_id, library_id)
    if not row or row.get("creator_user_id") == user_id:
        raise AppError("library_item_not_found", "That shared item is not available to report.", status=404)
    db.report_quiz_library_set(library_id)
    log.info("quiz library item %s reported by %s: %s", library_id, user_id, body.reason[:500])
    return {"reported": True}


@router.post("/plans/{plan_id}/quizzes/{quiz_id}")
def save_quiz_to_library(
    plan_id: str,
    quiz_id: str,
    body: LibrarySaveRequest,
    user_id: str = Depends(get_current_user),
) -> dict:
    plan = db.get_plan(user_id, plan_id)
    quiz = db.get_quiz(user_id, quiz_id)
    if not plan or not quiz or quiz.get("plan_id") != plan_id:
        raise AppError("quiz_not_found", "No such quiz.", status=404)
    quiz_json = quiz.get("quiz_json") or {}
    source = str((quiz_json.get("passages") or [{}])[0].get("source") or "ai_generated")
    if source == "shared_library":
        source = "ai_generated"
    reasons = quiz_library.validate_publishable(quiz_json, source=source, approved=False)
    non_permission_reasons = [reason for reason in reasons if "permission" not in reason.lower()]
    if non_permission_reasons:
        raise AppError("library_item_not_publishable", " ".join(non_permission_reasons), status=400)
    subject, grade = _academic_context(user_id, plan)
    context_plan = {**(plan.get("plan_json") or {}), "course": plan.get("course") or ""}
    context = quiz_library.context_values(plan=context_plan, quiz_json=quiz_json, subject=subject, grade=grade)
    digest = quiz_library.content_hash(quiz_json)
    existing = db.get_quiz_library_set_by_hash(digest, user_id=user_id)
    if existing:
        return _public_row(existing, user_id)
    row = db.create_quiz_library_set(
        library_id=db.new_id(),
        creator_user_id=user_id,
        title=str(quiz_json.get("title") or quiz.get("title") or "Shared passage set"),
        quiz_json=quiz_json,
        course=context["course"],
        subject=context["subject"],
        grade=context["grade"],
        standard_codes=context["standard_codes"],
        context_text=context["context_text"],
        embedding=_embedding_for(context_text=context["context_text"], quiz_json=quiz_json),
        content_hash=digest,
        passage_source=source,
        permission_confirmed=body.permission_confirmed if source == "teacher_provided" else True,
    )
    if not row:
        row = db.get_quiz_library_set_by_hash(digest, user_id=user_id)
    if not row:
        raise AppError("library_save_failed", "The shared item could not be saved.", status=500)
    return _public_row(row, user_id)
