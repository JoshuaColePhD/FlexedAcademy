"""Account management, as a page instead of SQL run by hand.

Everything here used to be a query typed straight into the Supabase SQL
editor. That doesn't scale past "the one person building this app" — it means
every account question routes through whoever has database access, and every
"give this teacher unlimited access" is a bespoke UPDATE. One page, gated by
the is_admin column rather than a hardcoded email list, so revoking access is
a data change, not a redeploy.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from .. import db, qa
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
    way around. This app deliberately has no upload/parse path for a school
    calendar (see backend/schoolcal.py's own reasoning); an admin hand-
    authors backend/context/calendars/<id>.md and commits it FIRST."""
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
