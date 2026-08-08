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
from pydantic import BaseModel

from .. import db
from ..deps import get_current_admin
from ..entitlement import ENTITLED_STATUSES

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
    return {"account": next(
        (a for a in db.list_accounts_with_stats() if a["id"] == account_id), None
    )}


@router.get("/entitled-statuses")
def entitled_statuses(_admin: str = Depends(get_current_admin)):
    """What the app currently treats as "may generate", for display only —
    the page can show it without hardcoding a second copy of the rule."""
    return {"statuses": sorted(ENTITLED_STATUSES)}
