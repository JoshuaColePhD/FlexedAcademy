"""Account management, as a page instead of SQL run by hand.

Everything here used to be a query typed straight into the Supabase SQL
editor. That doesn't scale past "the one person building this app" — it means
every account question routes through whoever has database access, and every
"give this teacher unlimited access" is a bespoke UPDATE. One page, gated by
the is_admin column rather than a hardcoded email list, so revoking access is
a data change, not a redeploy.
"""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import db, mail, qa, template_intake
from ..config import settings
from ..deps import get_current_admin
from ..entitlement import ENTITLED_STATUSES
from ..errors import AppError

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/accounts")
def list_accounts(_admin: str = Depends(get_current_admin)):
    return {"accounts": db.list_accounts_with_stats()}


@router.get("/usage-trend")
def usage_trend(_admin: str = Depends(get_current_admin)):
    """Site-wide weekly usage for the admin panel's trend chart — see
    db.weekly_usage_series's own docstring for why this is a separate,
    bucketed query rather than something list_accounts already carries."""
    return {"weeks": db.weekly_usage_series()}


@router.get("/qa/standards-check")
def standards_check(_admin: str = Depends(get_current_admin)):
    """Every plan, admin-wide, whose cited standards don't hold up against
    its own class's subject/grade — see qa.py's own module docstring for
    what "don't hold up" means and why. On-demand, not cached: this is a
    handful of in-memory dict lookups per plan against an already-loaded,
    already-cached corpus (retrieval.py's own lru_cache), not a fresh model
    call or a fresh corpus load."""
    return {"flagged": qa.run_standards_check()}


class CompBody(BaseModel):
    comped: bool


@router.post("/accounts/{account_id}/comp")
def set_comped(account_id: str, body: CompBody, _admin: str = Depends(get_current_admin)):
    """Grant or revoke unlimited free access.

    Revoking clears the status back to NULL rather than 'canceled' — the
    account was never a Stripe subscriber, so a status implying a lapsed
    subscription would be a fabricated billing history. NULL just means "no
    subscription", which is the truth: they fall back to the ordinary free
    week like anyone else.
    """
    if body.comped:
        db.set_subscription(account_id, status="comped")
    else:
        db.clear_subscription_status(account_id)
    return {"account": next(
        (a for a in db.list_accounts_with_stats() if a["id"] == account_id), None
    )}


class CapBody(BaseModel):
    # None clears the override back to "use the tier's own cap" — see
    # migration 28 / entitlement.py. A real 0 is legal too (fully throttle
    # one account without suspending it outright), so this has to stay
    # nullable rather than defaulting to some sentinel.
    cap: int | None = Field(default=None, ge=0)


@router.post("/accounts/{account_id}/cap")
def set_custom_cap(account_id: str, body: CapBody, _admin: str = Depends(get_current_admin)):
    """The middle ground between "the ordinary tier cap" and "comped"
    (unlimited) — give ONE account more headroom without unlocking it
    entirely, or throttle one down without suspending it. Everyone else is
    unaffected; this only ever touches the account named in the URL."""
    db.set_custom_token_cap(account_id, body.cap)
    return {"account": next(
        (a for a in db.list_accounts_with_stats() if a["id"] == account_id), None
    )}


@router.get("/entitled-statuses")
def entitled_statuses(_admin: str = Depends(get_current_admin)):
    """What the app currently treats as "may generate", for display only —
    the page can show it without hardcoding a second copy of the rule."""
    return {"statuses": sorted(ENTITLED_STATUSES)}


class SchoolBody(BaseModel):
    # A plain slug, not just "non-empty": this becomes a filesystem path
    # component (calendars_dir / f"{id}.md"), so it's validated as one here
    # rather than trusted as arbitrary text.
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=120)


@router.post("/schools", status_code=201)
def create_school_route(body: SchoolBody, _admin: str = Depends(get_current_admin)):
    """Registers a school that already has a calendar file — never the other
    way around. This is the hand-curated path: an admin hand-authors
    backend/context/calendars/<id>.md and commits it FIRST, then registers
    the row here. Teachers have a separate, parallel path that needs no
    admin step at all — routes/school_calendars.py's upload-and-
    peer-confirm flow creates the `schools` row itself and stores the
    calendar as a DB row rather than a file (see schoolcal.py's own comment
    on why both paths coexist)."""
    if db.get_school(body.id):
        raise AppError("already_exists", f"A school with id {body.id!r} already exists.", status=409)
    calendar_file = settings.calendars_dir / f"{body.id}.md"
    if not calendar_file.is_file():
        raise AppError(
            "calendar_missing",
            f"No calendar file for {body.id!r}.",
            status=400,
            hint=f"Add backend/context/calendars/{body.id}.md and commit it, then try again.",
        )
    return db.create_school(body.id, body.name)


@router.delete("/schools/{school_id}", status_code=204)
def delete_school_route(school_id: str, _admin: str = Depends(get_current_admin)):
    if not db.get_school(school_id):
        raise AppError("not_found", "That school doesn't exist.", status=404)
    in_use = db.count_users_with_school(school_id)
    if in_use:
        raise AppError(
            "school_in_use",
            f"{in_use} account(s) still use this school.",
            status=409,
            hint="Reassign those accounts to a different school first.",
        )
    db.delete_school(school_id)


@router.get("/calendar-submissions")
def list_calendar_submissions_route(status: str | None = None, _admin: str = Depends(get_current_admin)):
    """The queue behind SchoolsAdmin's pending-calendar section — every
    teacher-uploaded calendar, admin-wide, regardless of which school it's
    for. `status` filters to 'pending' | 'confirmed' | 'rejected'."""
    return {"submissions": db.list_calendar_submissions(status)}


@router.post("/calendar-submissions/{submission_id}/approve")
def approve_calendar_submission_route(submission_id: str, admin_id: str = Depends(get_current_admin)):
    """Admin override — confirms directly regardless of who submitted it,
    for the case where no second teacher at that school is around yet to
    do the normal peer confirmation."""
    submission = db.get_calendar_submission(submission_id)
    if not submission:
        raise AppError("not_found", "That submission doesn't exist.", status=404)
    if submission["status"] != "pending":
        raise AppError("not_pending", "That submission has already been decided.", status=409)
    return db.confirm_calendar_submission(submission_id, admin_id)


@router.post("/calendar-submissions/{submission_id}/reject")
def reject_calendar_submission_route(submission_id: str, _admin: str = Depends(get_current_admin)):
    submission = db.get_calendar_submission(submission_id)
    if not submission:
        raise AppError("not_found", "That submission doesn't exist.", status=404)
    if submission["status"] != "pending":
        raise AppError("not_pending", "That submission has already been decided.", status=409)
    return db.reject_calendar_submission(submission_id)


@router.get("/school-templates/pending")
def list_pending_school_templates_route(_admin: str = Depends(get_current_admin)):
    return {"templates": db.list_pending_school_templates()}


@router.post("/schools/{school_id}/activate-template")
def activate_school_template_route(school_id: str, _admin: str = Depends(get_current_admin)):
    school = db.get_school(school_id)
    if not school:
        raise AppError("not_found", "School not found.", status=404)
        
    db.update_school_template_status(school_id, "active")

    latest_template = db.get_latest_school_template(school_id)
    if latest_template and latest_template.get("uploader_email"):
        mail.send_template_active_email(
            to=latest_template["uploader_email"],
            uploader_name=latest_template.get("uploader_name"),
            school_name=school["name"],
        )

    return {"status": "ok"}


@router.get("/school-templates/{template_id}/analysis")
def get_school_template_analysis_route(template_id: str, _admin: str = Depends(get_current_admin)):
    """Full detail behind one row of the pending-templates queue: the
    deterministic structure, the LLM's (already cross-checked) section
    mapping, and every quality-check finding the pipeline recorded — not
    just the collapsed status badge the list view shows."""
    template = db.get_school_template(template_id)
    if not template:
        raise AppError("not_found", "Template not found.", status=404)
    return {
        "template": template,
        "structure": json.loads(template["structure_json"]) if template.get("structure_json") else None,
        "analysis": json.loads(template["analysis_summary"]) if template.get("analysis_summary") else None,
        "findings": db.get_template_findings(template_id),
    }


@router.post("/school-templates/{template_id}/reanalyze")
def reanalyze_school_template_route(template_id: str, admin_id: str = Depends(get_current_admin)):
    """Re-runs the same pipeline the upload endpoint ran, against the file
    already on disk — for a transient failure (an LLM hiccup) or after a
    pipeline fix, without asking the school to re-upload anything."""
    template = db.get_school_template(template_id)
    if not template:
        raise AppError("not_found", "Template not found.", status=404)
    dest_path = Path(template["file_path"])
    if not dest_path.is_file():
        raise AppError("not_found", "The original file is missing from disk — a re-upload is needed.", status=404)
    return template_intake.run_and_persist(
        user_id=admin_id,
        template_id=template_id,
        school_id=template["school_id"],
        dest_path=dest_path,
        claimed_ext=dest_path.suffix.lower(),
    )


@router.get("/school-templates/{template_id}/download")
def download_school_template_route(template_id: str, _admin: str = Depends(get_current_admin)):
    from fastapi.responses import FileResponse
    from pathlib import Path
    template = db.get_school_template(template_id)
    if not template:
        raise AppError("not_found", "Template not found.", status=404)
    file_path = Path(template["file_path"])
    if not file_path.is_file():
        raise AppError("not_found", "File missing from disk.", status=404)
    return FileResponse(file_path, filename=template["filename"])
