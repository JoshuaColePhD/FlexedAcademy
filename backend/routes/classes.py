"""Classes — a teacher's preps — and the week board built from the school calendar.

Two things live here because they are the same idea from different angles: a
class is what you plan for, and the week board is what there is left to plan.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from .. import db
from ..deps import get_current_user
from ..errors import AppError

log = logging.getLogger("aplang.classes")

router = APIRouter(prefix="/api", tags=["classes"])


class ClassBody(BaseModel):
    # `name` is optional on create: the client is expected to leave it empty and
    # let the framework + grade name the class, which is the whole reason
    # setting one up is two picks rather than four fields.
    name: str | None = Field(default=None, max_length=120)
    subject: str = Field(min_length=1, max_length=120)
    grade: str = Field(default="11", max_length=8)


class ClassPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    subject: str | None = Field(default=None, max_length=120)
    grade: str | None = Field(default=None, max_length=8)
    sort_order: int | None = None


def _auto_name(subject: str, grade: str) -> str:
    """"AP_Lang" + "11" -> "AP Lang · 11th".

    The redundancy this removes: Course, Framework and Grade were three fields
    that each restated the same class, and a teacher typed all three per prep.
    """
    from .misc import SUBJECT_LABELS

    label = SUBJECT_LABELS.get(subject, subject.replace("_", " "))
    # Trim the parenthetical adoption year — "Science (2023)" is right in a
    # framework picker and noise in a class name.
    label = label.split(" (")[0].strip()
    try:
        g = int(str(grade).strip())
        suffix = "st" if g == 1 else "nd" if g == 2 else "rd" if g == 3 else "th"
        return f"{label} · {g}{suffix}"
    except ValueError:
        return label



class MeBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    # Global custom instructions, like Claude's own — applied to every
    # generation and chat (backend/prompts.py), not per class.
    custom_instructions: str | None = Field(default=None, max_length=2000)
    school: str | None = Field(default=None)


@router.get("/schools")
def list_schools_route() -> list[dict]:
    """No auth needed — same reasoning as GET /api/frameworks (misc.py):
    this is a fixed lookup table for a dropdown, not account data.

    `has_calendar` rides along because the two halves of a school live in
    different places on purpose: the row here, and the year itself as a
    hand-authored file in version control (see schoolcal's docstring). So a
    school can legitimately exist with no calendar yet — admin adds the row
    before anyone writes the file — and picking one silently costs the
    teacher their whole week board. Reporting it lets the picker say so
    instead of letting them find out by watching the weeks disappear."""
    from .. import schoolcal

    return [
        {**s, "has_calendar": bool(schoolcal.school_weeks(s["id"]))}
        for s in db.list_schools()
    ]


@router.patch("/me")
def update_me_route(body: MeBody, user_id: str = Depends(get_current_user)) -> dict:
    """Set the teacher's name/custom instructions/school — whichever the
    caller sent, independently (db.update_user's own whitelist).

    `school` is checked against the live `schools` table here, in the
    handler body, rather than in a pydantic validator — the valid set is a
    database table now (db.py migration 23), not a module constant a
    validator can close over. Same reasoning as curriculum.py's upload route
    checking class_id inline rather than via a validator.
    """
    if body.school is not None and not db.get_school(body.school):
        raise AppError("unknown_school", "Unknown school.", status=400)
    fields = body.model_dump(exclude_none=True)
    user = db.update_user(user_id, **fields) if fields else db.get_user_by_id(user_id)
    if not user:
        raise AppError("not_found", "No such user.", status=404)
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "custom_instructions": user.get("custom_instructions"),
        "school": user.get("school"),
    }


@router.get("/classes")
def list_classes_route(user_id: str = Depends(get_current_user)) -> list[dict]:
    return db.list_classes(user_id)


@router.post("/classes", status_code=201)
def create_class_route(body: ClassBody, user_id: str = Depends(get_current_user)) -> dict:
    name = (body.name or "").strip() or _auto_name(body.subject, body.grade)
    return db.create_class(user_id, name=name, subject=body.subject, grade=body.grade)


@router.patch("/classes/{class_id}")
def update_class_route(
    class_id: str, body: ClassPatch, user_id: str = Depends(get_current_user)
) -> dict:
    if not db.get_class(user_id, class_id):
        raise AppError("not_found", "That class doesn't exist.", status=404)
    updated = db.update_class(user_id, class_id, **body.model_dump(exclude_none=True))
    return updated  # type: ignore[return-value]


@router.delete("/classes/{class_id}", status_code=204)
def delete_class_route(class_id: str, user_id: str = Depends(get_current_user)) -> None:
    if not db.delete_class(user_id, class_id):
        raise AppError("not_found", "That class doesn't exist.", status=404)


@router.get("/classes/{class_id}/documents")
def list_documents_route(class_id: str, user_id: str = Depends(get_current_user)) -> list[dict]:
    if not db.get_class(user_id, class_id):
        raise AppError("not_found", "That class doesn't exist.", status=404)
    return db.list_class_documents(user_id, class_id)


@router.get("/weeks")
def week_board_route(
    class_id: str | None = Query(default=None),
    user_id: str = Depends(get_current_user),
) -> dict:
    """The year for one class. Drives the home screen."""
    return db.week_board(user_id, class_id)
