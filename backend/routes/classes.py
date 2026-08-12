"""Classes — a teacher's preps — and the week board built from the school calendar.

Two things live here because they are the same idea from different angles: a
class is what you plan for, and the week board is what there is left to plan.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator

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



# Whitelisted school ids, one entry today — see db.py migration 22's own
# comment for why this is a plain string column, not a foreign key. Every
# school that actually has a docx builder of its own (backend/docx_build.py)
# gets an entry here; the settings page dropdown reads straight off this.
SCHOOLS = {"florence-high-school": "Florence High School"}


class MeBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    # Global custom instructions, like Claude's own — applied to every
    # generation and chat (backend/prompts.py), not per class.
    custom_instructions: str | None = Field(default=None, max_length=2000)
    school: str | None = Field(default=None)

    @field_validator("school")
    @classmethod
    def _known_school(cls, v: str | None) -> str | None:
        if v is not None and v not in SCHOOLS:
            raise ValueError("Unknown school.")
        return v


@router.get("/schools")
def list_schools_route() -> list[dict]:
    """No auth needed — same reasoning as GET /api/frameworks (misc.py):
    this is a fixed lookup table for a dropdown, not account data."""
    return [{"id": k, "name": v} for k, v in SCHOOLS.items()]


@router.patch("/me")
def update_me_route(body: MeBody, user_id: str = Depends(get_current_user)) -> dict:
    """Set the teacher's name/custom instructions/school — whichever the
    caller sent, independently (db.update_user's own whitelist)."""
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
