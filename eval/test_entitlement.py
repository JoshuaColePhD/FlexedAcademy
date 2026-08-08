#!/usr/bin/env python3
"""The paywall: who may build a new week, and who must not be blocked.

This one is a test rather than a comment because it can fail expensively in
both directions. Too loose and the subscription is decorative. Too tight and a
teacher who paid — or who was here before there was anything to pay for —
opens the app on a Sunday night and cannot build Monday.

The promises:

  1. With no Stripe keys the gate is INERT. Everyone builds. A gate with no
     door in it is not a paywall, it is an outage.
  2. Existing accounts are grandfathered as 'comped' by migration 15, and
     'comped' entitles regardless of how many plans they have.
  3. A new teacher gets `free_plan_allowance` weeks, then stops.
  4. 'past_due' still entitles — a failed card retry must not lock someone out
     mid-week while Stripe is still trying.
  5. 'canceled' / 'incomplete_expired' do not entitle.
  6. The allowance counts PLANS, not chats or messages.

No database, no API: db is stubbed.

Run:  ./venv/bin/python eval/test_entitlement.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import db, entitlement as E  # noqa: E402
from backend.config import settings  # noqa: E402

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got!r}" + ("" if ok else f" (want {want!r})"))
    if not ok:
        FAILURES.append(label)


def scenario(status, plans, *, keys: bool, allowance: int = 1):
    db.get_user_by_id = lambda _uid: {"subscription_status": status}
    db.count_plans = lambda _uid: plans
    settings.stripe_secret_key = "sk_test" if keys else ""
    settings.stripe_price_id = "price_test" if keys else ""
    settings.stripe_webhook_secret = "whsec_test" if keys else ""
    settings.free_plan_allowance = allowance
    return E.entitlement("u")


def main() -> int:
    real = (db.get_user_by_id, db.count_plans)
    real_settings = (
        settings.stripe_secret_key,
        settings.stripe_price_id,
        settings.stripe_webhook_secret,
        settings.free_plan_allowance,
    )
    try:
        print("\n1. Billing unconfigured — the gate is inert")
        check("no keys, 99 plans, no status", scenario(None, 99, keys=False).may_generate, True)
        check("no keys reports disabled", scenario(None, 99, keys=False).billing_enabled, False)

        print("\n2. Grandfathered accounts (migration 15 sets 'comped')")
        check("comped, 7 plans", scenario("comped", 7, keys=True).may_generate, True)

        print("\n3. The free allowance")
        check("new teacher, 0 plans", scenario(None, 0, keys=True).may_generate, True)
        check("new teacher, 1 plan", scenario(None, 1, keys=True).may_generate, False)
        check("free_remaining at 0 plans", scenario(None, 0, keys=True).free_remaining, 1)
        check("free_remaining at 1 plan", scenario(None, 1, keys=True).free_remaining, 0)
        check("allowance of 3, 2 plans", scenario(None, 2, keys=True, allowance=3).may_generate, True)
        check("allowance of 3, 3 plans", scenario(None, 3, keys=True, allowance=3).may_generate, False)

        print("\n4. Statuses that entitle")
        for status in ("active", "trialing", "past_due", "comped"):
            check(f"{status}, 50 plans", scenario(status, 50, keys=True).may_generate, True)

        print("\n5. Statuses that do not")
        for status in ("canceled", "incomplete_expired", "unpaid", None, ""):
            check(f"{status!r}, 50 plans", scenario(status, 50, keys=True).may_generate, False)

        print("\n6. A missing user row is not an accidental free pass")
        db.get_user_by_id = lambda _uid: None
        db.count_plans = lambda _uid: 5
        settings.free_plan_allowance = 1
        check("no user row, 5 plans", E.entitlement("ghost").may_generate, False)
    finally:
        db.get_user_by_id, db.count_plans = real
        (
            settings.stripe_secret_key,
            settings.stripe_price_id,
            settings.stripe_webhook_secret,
            settings.free_plan_allowance,
        ) = real_settings

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — the gate opens for exactly the right people.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
