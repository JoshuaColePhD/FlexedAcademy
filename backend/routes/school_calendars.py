"""Teacher-submitted school calendars, pending a second teacher's confirmation.

The upload/parse/sanity-check pipeline lives in calendar_intake.py; this file
is just the HTTP surface over it plus the peer-confirmation state machine.
See schoolcal.py's own comment on how a confirmed (or, provisionally, a
pending) submission slots in ahead of the hand-curated file path.
"""
from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from .. import calendar_intake, db, storage, template_intake
from ..config import settings
from ..deps import get_current_user
from ..errors import AppError
from .misc import _spool

log = logging.getLogger("flexedacademy.school_calendars")

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


# Deliberately `def`, not `async def` — nothing in the body is awaitable, and
# it does slow blocking work (file/network IO, PDF+LLM parsing). Under
# `--workers 1` (Dockerfile) an async version ran that on the event loop and
# froze every other request, SSE streams included. `def` gets the threadpool.
@router.post("", status_code=201)
def upload_calendar(
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


# Deliberately `def`, not `async def` — nothing in the body is awaitable, and
# it does slow blocking work (file/network IO, PDF+LLM parsing). Under
# `--workers 1` (Dockerfile) an async version ran that on the event loop and
# froze every other request, SSE streams included. `def` gets the threadpool.
@router.post("/{school_id}/template", status_code=201)
def upload_school_template(
    school_id: str,
    file: UploadFile | None = File(default=None),
    source_url: str | None = Form(default=None),
    blank_template_attested: bool = Form(default=False),
    user_id: str = Depends(get_current_user),
):
    """Upload a blank lesson plan template for a school that doesn't have a
    builder script yet. Hardened the same way calendar_intake.py's upload
    path is: spooled to a size-capped temp file, then its magic bytes must
    match the extension it claims, before anything reaches permanent disk.

    Once the file is safely stored, template_intake.py runs a structural
    analysis synchronously and its result (a status plus a full set of
    findings — see that module's docstring) is persisted alongside the
    template row. Analysis failing never blocks the upload itself — the
    file is saved and visible to the admin queue either way; a failed
    analysis just means an admin sees why, instead of a builder script that
    silently doesn't exist yet.
    """
    school = db.get_school(school_id)
    if not school:
        raise AppError("not_found", "School not found.", status=404)

    if not file and not source_url:
        raise AppError("bad_request", "Please provide either a file or a Google Doc link.", status=400)
    if not blank_template_attested:
        raise AppError("blank_template_confirmation_required", "Confirm that this is a blank, reusable district template before uploading.", status=400)

    if source_url:
        if "docs.google.com/document/d/" not in source_url:
            raise AppError("bad_request", "Only Google Doc links are supported for templates. For other formats, please download and upload the file.", status=400)
        from .misc import _download_google_doc_as_docx
        spooled = _download_google_doc_as_docx(source_url, settings.max_doc_bytes)
        if not spooled:
            raise AppError("bad_request", "Invalid Google Doc URL.", status=400)
        filename = "google_doc.docx"
        ext_hint = ".docx"
    else:
        filename = file.filename or "template"
        ext_hint = Path(filename).suffix.lower() or ".docx"
        spooled = _spool(file, ext_hint, settings.max_doc_bytes)
    try:
        ext = template_intake.validate_upload(filename, spooled)
        template_intake.require_blank_template(spooled, ext)

        uploads_dir = Path("uploads/templates")
        uploads_dir.mkdir(parents=True, exist_ok=True)
        template_id = db.new_id()
        dest = uploads_dir / f"{school_id}_{template_id}{ext}"
        shutil.move(str(spooled), str(dest))  # not Path.rename: the temp dir and uploads/ may be different filesystems
        storage.mirror_file(dest)
    finally:
        spooled.unlink(missing_ok=True)  # no-op once moved away; cleans up on any raise before that

    row = db.create_school_template(school_id, user_id, filename, str(dest))
    return template_intake.run_and_persist(
        user_id=user_id, template_id=row["id"], school_id=school_id, dest_path=dest, claimed_ext=ext
    )

@router.get("/confirmed/{school_id}")
def get_confirmed_calendar_route(school_id: str, _user_id: str = Depends(get_current_user)):
    from .. import schoolcal
    weeks = schoolcal.school_weeks(school_id)
    if not weeks:
        raise HTTPException(status_code=404, detail="No calendar found")
    return {"weeks": weeks}
