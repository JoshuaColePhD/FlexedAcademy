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
from pydantic import BaseModel, Field, field_validator

from .. import db, stripe_api
from ..config import settings
from ..deps import get_current_admin
from ..entitlement import ENTITLED_STATUSES
from ..errors import AppError

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/accounts")
def list_accounts(_admin: str = Depends(get_current_admin)):
    return {"accounts": db.list_accounts_with_stats()}


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
    db.log_admin_action(_admin, "comp_grant" if body.comped else "comp_revoke", target=account_id)
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
    school = db.create_school(body.id, body.name)
    db.log_admin_action(_admin, "school_add", target=body.id, detail={"name": body.name})
    return school


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
    db.log_admin_action(_admin, "school_remove", target=school_id)


class AppSettingsBody(BaseModel):
    # Both required — the row always carries a value for each, so a PUT is a
    # full replace, not a partial patch (unlike CompBody's single field).
    free_weekly_token_cap: int = Field(gt=0, le=100_000_000)
    subscriber_weekly_token_cap: int = Field(gt=0, le=100_000_000)

    @field_validator("subscriber_weekly_token_cap")
    @classmethod
    def _subscriber_at_least_free(cls, v: int, info) -> int:
        free = info.data.get("free_weekly_token_cap")
        if free is not None and v < free:
            raise ValueError("Subscriber cap must be at least the free cap.")
        return v


@router.get("/settings")
def get_app_settings_route(_admin: str = Depends(get_current_admin)):
    return db.get_app_settings()


@router.put("/settings")
def update_app_settings_route(body: AppSettingsBody, _admin: str = Depends(get_current_admin)):
    before = db.get_app_settings()
    after = db.update_app_settings(
        free_weekly_token_cap=body.free_weekly_token_cap,
        subscriber_weekly_token_cap=body.subscriber_weekly_token_cap,
        actor_id=_admin,
    )
    db.log_admin_action(
        _admin,
        "settings_update",
        detail={
            "before": {k: before[k] for k in ("free_weekly_token_cap", "subscriber_weekly_token_cap")},
            "after": {k: after[k] for k in ("free_weekly_token_cap", "subscriber_weekly_token_cap")},
        },
    )
    return after


@router.get("/audit-log")
def get_audit_log_route(limit: int = 50, _admin: str = Depends(get_current_admin)):
    return {"entries": db.list_admin_audit_log(limit=min(limit, 200))}


# Statuses that mean "a real Stripe subscription, paying or trying to" —
# what MRR is computed over. Deliberately NOT the same set as
# entitlement.ENTITLED_STATUSES: 'comped' entitles someone to generate but
# pays nothing, so counting it toward revenue would be fictional income.
_PAYING_STATUSES = frozenset({"active", "trialing", "past_due"})


@router.get("/billing")
def get_billing_route(_admin: str = Depends(get_current_admin)):
    """Revenue and payment-risk, without a Stripe dashboard login.

    MRR is an estimate, not a Stripe-reported figure: (paying accounts) ×
    (the one configured price). True for this app because it only ever
    sells one price, one interval — see stripe_api.get_price's own docstring
    for why the price itself is never hardcoded here either.
    """
    summary = db.billing_summary()
    counts = summary["counts"]
    paying = sum(counts.get(s, 0) for s in _PAYING_STATUSES)

    price = None
    mrr_cents = None
    if settings.billing_enabled:
        try:
            price = stripe_api.get_price(settings.stripe_price_id)
            if price.get("amount") is not None:
                mrr_cents = paying * price["amount"]
        except AppError:
            pass  # A page that can't reach Stripe still shows account counts.

    return {
        "billing_enabled": settings.billing_enabled,
        "counts": counts,
        "paying_accounts": paying,
        "price": price,
        "mrr_cents": mrr_cents,
        "past_due_accounts": summary["past_due_accounts"],
    }
