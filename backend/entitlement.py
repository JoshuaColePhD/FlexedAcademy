"""Who may build a new week, and why.

ONE function decides. The API gate, the paywall screen and the account menu all
read the same answer, so the UI can never offer a button the server will refuse
— or, worse, hide one it would have allowed.

The rule, in full:

  * Billing not configured        -> everyone may generate. The gate is inert
                                     until Stripe keys exist, because a gate
                                     with no way through it is a broken app.
  * Subscribed (or comped)        -> may generate.
  * Fewer plans than the allowance -> may generate. This is "a week free".
  * Otherwise                     -> may NOT generate, and may still open,
                                     download and revise everything they have.

That last clause is the one worth being careful about. Revising is not
generating: "a week free" means a week of lesson plans, and a teacher fixing
Thursday is still working on the same week. Downloads never stop, ever — the
.docx is the thing they handed in, and taking it back would be indefensible.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import db
from .config import settings

# Stripe statuses that mean "this person is paid up", plus our own 'comped'.
# 'past_due' is deliberately included: a card that failed a retry should not
# lock a teacher out mid-week over a billing hiccup Stripe is still working on.
ENTITLED_STATUSES = frozenset({"active", "trialing", "past_due", "comped"})


@dataclass(frozen=True)
class Entitlement:
    may_generate: bool
    subscribed: bool
    status: str | None
    plans_used: int
    free_allowance: int
    billing_enabled: bool

    @property
    def free_remaining(self) -> int:
        return max(0, self.free_allowance - self.plans_used)

    def as_dict(self) -> dict:
        return {
            "may_generate": self.may_generate,
            "subscribed": self.subscribed,
            "status": self.status,
            "plans_used": self.plans_used,
            "free_allowance": self.free_allowance,
            "free_remaining": self.free_remaining,
            "billing_enabled": self.billing_enabled,
        }


def entitlement(user_id: str) -> Entitlement:
    user = db.get_user_by_id(user_id) or {}
    status = user.get("subscription_status")
    subscribed = status in ENTITLED_STATUSES

    # The plans themselves are the count. No counter column to drift.
    plans_used = db.count_plans(user_id)

    may_generate = (
        not settings.billing_enabled
        or subscribed
        or plans_used < settings.free_plan_allowance
    )
    return Entitlement(
        may_generate=may_generate,
        subscribed=subscribed,
        status=status,
        plans_used=plans_used,
        free_allowance=settings.free_plan_allowance,
        billing_enabled=settings.billing_enabled,
    )
