"""Teacher-submitted school calendars, pending a second teacher's confirmation.

The upload/parse/sanity-check pipeline lives in calendar_intake.py; this file
is just the HTTP surface over it plus the peer-confirmation state machine.
See schoolcal.py's own comment on how a confirmed (or, provisionally, a
pending) submission slots in ahead of the hand-curated file path.
"""
from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, File, Form, UploadFile

from .. import calendar_intake, db
from ..deps import get_current_user
from ..errors import AppError

log = logging.getLogger("aplang.school_calendars")

router = APIRouter(prefix="/api/school-calendars", tags=["school-calendars"])


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    if not slug:
        raise AppError("bad_school_name", "That school name doesn't have any usable characters.", status=400)
    return slug[:64]


def _resolve_school(school_name: str) -> dict:
    school_id = _slugify(school_name)
    existing = db.get_school(school_id)
    if existing:
        return existing
    return db.create_school(school_id, school_name)


@router.post("", status_code=201)
async def upload_calendar(
    school_name: str = Form(..., min_length=1, max_length=120),
    source_url: str | None = Form(default=None),
    file: UploadFile | None = File(default=None),
    user_id: str = Depends(get_current_user),
):
    """Upload a PDF/Word doc, or provide a link, for the teacher's own
    school's real calendar. Runs extract -> parse -> sanity-check -> saves
    as `pending` — usable immediately by the submitter, but not treated as
    trusted anywhere else until a second teacher (or an admin) confirms it."""
    school = _resolve_school(school_name)

    text = calendar_intake.extract_calendar_text(upload=file, url=source_url)
    weeks = calendar_intake.parse_and_validate(user_id, text)

    submission = db.create_calendar_submission(
        school_id=school["id"],
        submitted_by=user_id,
        source_kind="link" if source_url else "upload",
        source_name=source_url or (file.filename if file else None),
        weeks=weeks,
    )
    return {"school": school, "submission": submission}


@router.get("/pending")
def get_pending_calendar(school_id: str, _user_id: str = Depends(get_current_user)):
    submission = db.get_pending_calendar_submission(school_id)
    if not submission:
        raise AppError("not_found", "No pending calendar for that school.", status=404)
    return submission


@router.post("/{submission_id}/confirm")
def confirm_calendar(submission_id: str, user_id: str = Depends(get_current_user)):
    submission = db.get_calendar_submission(submission_id)
    if not submission:
        raise AppError("not_found", "That submission doesn't exist.", status=404)
    if submission["status"] != "pending":
        raise AppError("not_pending", "That submission has already been decided.", status=409)
    if submission["submitted_by"] == user_id:
        raise AppError(
            "self_confirmation",
            "You submitted this calendar — a different teacher needs to confirm it.",
            status=403,
        )
    return db.confirm_calendar_submission(submission_id, user_id)


@router.post("/{submission_id}/reject")
def reject_calendar(submission_id: str, _user_id: str = Depends(get_current_user)):
    """Any logged-in teacher can flag a wrong submission (not just the
    submitter or a peer confirming it) — it just goes away, and the school
    is back to "isn't listed yet" until someone re-uploads."""
    submission = db.get_calendar_submission(submission_id)
    if not submission:
        raise AppError("not_found", "That submission doesn't exist.", status=404)
    if submission["status"] != "pending":
        raise AppError("not_pending", "That submission has already been decided.", status=409)
    return db.reject_calendar_submission(submission_id)
