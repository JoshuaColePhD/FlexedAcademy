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
from ..schoolcal import NO_CALENDAR_SCHOOL_ID

log = logging.getLogger("flexedacademy.classes")

router = APIRouter(prefix="/api", tags=["classes"])


class ClassBody(BaseModel):
    # `name` is optional on create: the client is expected to leave it empty and
    # let the framework + grade name the class, which is the whole reason
    # setting one up is two picks rather than four fields.
    name: str | None = Field(default=None, max_length=120)
    subject: str = Field(min_length=1, max_length=120)
    grade: str = Field(default="11", max_length=8)
    state: str | None = Field(default=None, max_length=120)


class ClassPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    subject: str | None = Field(default=None, max_length=120)
    grade: str | None = Field(default=None, max_length=8)
    sort_order: int | None = None
    # Which calendar this class follows (migration 25) — independent of the
    # account default (PATCH /api/me), and of every other class on it. Not on
    # ClassBody: a brand-new class is stamped with the account's current
    # default at creation (db.create_class) and moved from here afterward,
    # the same two-step "auto-set, then editable" shape as its name.
    school: str | None = Field(default=None)
    # The per-class layer on top of PATCH /api/me's account-wide
    # custom_instructions (migration 44) — same 2000-char cap as that field.
    # Not on ClassBody for the same "auto-set nothing, edit afterward" reason
    # `school` isn't: a brand-new class starts with no class-specific note.
    custom_instructions: str | None = Field(default=None, max_length=2000)


def _validate_subject(subject: str) -> None:
    """Reject a subject that would never ground a plan.

    ClassBody.subject/ClassPatch.subject are plain strings — nothing at the
    DB or Pydantic layer stops a class being created with a subject that
    doesn't correspond to any ingested course. Today that's only prevented
    by FrameworkPicker.jsx offering nothing but real course codes, which is
    a frontend convention, not a backend invariant: any other client (or a
    picker bug) can create a class that silently can never generate a plan,
    failing only later with a no_grounded_standards_error the teacher has no
    way to trace back to "this class's subject was never real."

    Checked through the exact same resolution retrieval itself uses
    (service.subject_code) against the exact same course set the Subject
    Framework dropdown is built from (misc.known_course_ids) — so a class
    can never exist with a subject the generator can't ground.
    """
    from .. import service
    from . import misc

    code = service.subject_code(subject)
    if code not in misc.known_course_ids():
        raise AppError(
            "unknown_subject",
            f"'{subject}' isn't a subject with any standards loaded.",
            status=400,
        )


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
        # 0 is Kindergarten (grade_from_level() in
        # scripts/01d_ingest_alcos_case.py) — "0th" isn't a grade anyone says.
        if g == 0:
            return f"{label} · K"
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
    # SettingsPage.jsx's "Enable Beta Features" toggle — gates Voice Mode
    # today (ChatPage.jsx's openVoice). `bool | None` rather than `bool`
    # so an unrelated PATCH (e.g. just `name`) doesn't have to resend it.
    beta_features: bool | None = Field(default=None)


@router.get("/schools")
def list_schools_route() -> list[dict]:
    """No auth needed — same reasoning as GET /api/frameworks (misc.py):
    this is a fixed lookup table for a dropdown, not account data.

    `has_calendar` rides along because the two halves of a school live in
    different places on purpose: the row here, and the year itself as either
    a hand-authored file in version control or a peer-confirmed teacher
    submission (see schoolcal's docstring). So a school can legitimately
    exist with no calendar yet — admin adds the row before anyone writes the
    file — and picking one silently costs the teacher their whole week
    board. Reporting it lets the picker say so instead of letting them find
    out by watching the weeks disappear.

    `has_pending_calendar` is the other case: a teacher already uploaded a
    calendar for this school but no second teacher has confirmed it yet —
    see schoolcal.calendar_status's own comment on why this can't just be
    bool(schoolcal.school_weeks(...)).

    schoolcal.bulk_calendar_status, not calendar_status per school in a
    loop — see its own comment: that was an N+1 query (two DB round-trips
    times ~300 seeded schools) slow enough to make this endpoint hang
    outright rather than merely feel slow.

    `builder_readiness` rides along the same way, for the same reason:
    `template_status` alone stopped being enough once builder-codegen split
    "we understand this template" from "a real document builder exists for
    it" into two separate facts (migration 52) — see
    docx_build.bulk_builder_readiness's own docstring for what the three
    values mean and why a naive per-school check would be another N+1.
    """
    from .. import docx_build, schoolcal

    schools = db.list_schools()
    statuses = schoolcal.bulk_calendar_status([s["id"] for s in schools])
    readiness = docx_build.bulk_builder_readiness(schools)
    return [{**s, **statuses[s["id"]], "builder_readiness": readiness[s["id"]]} for s in schools]


@router.patch("/me")
def update_me_route(body: MeBody, user_id: str = Depends(get_current_user)) -> dict:
    """Set the teacher's name/custom instructions/school — whichever the
    caller sent, independently (db.update_user's own whitelist).

    `school` is checked against the live `schools` table here, in the
    handler body, rather than in a pydantic validator — the valid set is a
    database table now (db.py migration 23), not a module constant a
    validator can close over. Same reasoning as curriculum.py's upload route
    checking class_id inline rather than via a validator.

    NO_CALENDAR_SCHOOL_ID ('generic') is exempt: it's deliberately NOT a row
    in `schools` (see WelcomePage.jsx's own comment on it, and schoolcal.py's
    special-casing throughout) — it's the dateless fallback a teacher at an
    unlisted school lands on. Without this exemption, finishing onboarding
    with "My school isn't listed yet" selected failed every time with
    "Unknown school," which was the actual dead end this sentinel was built
    to avoid.
    """
    if body.school is not None and body.school != NO_CALENDAR_SCHOOL_ID and not db.get_school(body.school):
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
        "beta_features": bool(user.get("beta_features")),
    }


@router.get("/classes")
def list_classes_route(include_archived: bool = False, user_id: str = Depends(get_current_user)) -> list[dict]:
    return db.list_classes(user_id, include_archived)


@router.post("/classes", status_code=201)
def create_class_route(body: ClassBody, user_id: str = Depends(get_current_user)) -> dict:
    _validate_subject(body.subject)
    name = (body.name or "").strip() or _auto_name(body.subject, body.grade)
    # A real, production-found bug: a teacher (or an automated session acting
    # on her behalf) ended up with two classes both auto-named "English
    # Language Arts · 6th" — same subject, same grade, six minutes apart. The
    # class switcher had no way to show they were different, since nothing
    # about them WAS different, so switching between them looked like
    # switching did nothing. Since ClassBody.name is normally left blank
    # specifically so subject+grade names the class (this file's own comment
    # above), two active classes ever landing on the identical name is never
    # a teacher's deliberate choice — there's no field to name a second
    # section distinctly today, only a collision to prevent. Checked
    # case/whitespace-insensitively, and only against classes still in use
    # (archived ones are done, not a name still claimed).
    normalized = name.strip().casefold()
    if any(c["name"].strip().casefold() == normalized for c in db.list_classes(user_id)):
        raise AppError(
            "duplicate_class_name",
            f"You already have a class named “{name}.”",
            status=409,
            hint="Open that one from the class switcher, or archive it first if you meant to start over.",
        )
    return db.create_class(user_id, name=name, subject=body.subject, grade=body.grade, state=body.state)


@router.patch("/classes/{class_id}")
def update_class_route(
    class_id: str, body: ClassPatch, user_id: str = Depends(get_current_user)
) -> dict:
    if not db.get_class(user_id, class_id):
        raise AppError("not_found", "That class doesn't exist.", status=404)
    # Checked here, in the handler body, not a validator — same reasoning as
    # MeBody's identical check just above: the valid set is the live `schools`
    # table, not something a validator can close over. Same NO_CALENDAR_SCHOOL_ID
    # exemption as that check too — see its comment.
    if body.school is not None and body.school != NO_CALENDAR_SCHOOL_ID and not db.get_school(body.school):
        raise AppError("unknown_school", "Unknown school.", status=400)
    if body.subject is not None:
        _validate_subject(body.subject)
    fields = body.model_dump(exclude_none=True)
    if "subject" in fields or "grade" in fields:
        cls = db.get_class(user_id, class_id)
        if cls:
            subj = fields.get("subject", cls["subject"])
            grd = fields.get("grade", cls["grade"])
            fields["name"] = _auto_name(subj, grd)

    # Same collision this file's own create_class_route guards against —
    # a subject/grade change (or a direct rename) can land two classes on
    # the identical name just as easily as creating one already-duplicated
    # can. Excludes this class's own current row, so setting a class to the
    # name it already has isn't flagged as colliding with itself.
    if "name" in fields:
        normalized = fields["name"].strip().casefold()
        if any(
            c["id"] != class_id and c["name"].strip().casefold() == normalized
            for c in db.list_classes(user_id)
        ):
            raise AppError(
                "duplicate_class_name",
                f"You already have a class named “{fields['name']}.”",
                status=409,
                hint="Pick a different subject or grade, or archive the other one first.",
            )

    updated = db.update_class(user_id, class_id, **fields)
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
