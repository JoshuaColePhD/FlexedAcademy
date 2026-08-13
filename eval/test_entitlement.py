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
     'comped' gets the subscriber cap — high enough to be a safety net, not
     a real limit — regardless of how many plans it took to get there.
  3. A new teacher gets `free_weekly_token_cap` tokens, in a trailing 7-day
     window, then stops — until usage from more than a week ago rolls off.
  4. 'past_due' still entitles at the SUBSCRIBER cap — a failed card retry
     must not lock someone out mid-week while Stripe is still trying.
  5. 'canceled' / 'incomplete_expired' do not entitle — they're capped at the
     free tier like anyone unsubscribed, not blocked outright.
  6. The cap counts TOKENS spent (llm.py's own db.record_usage), not plans or
     chats or messages — replaced "one free plan, ever" (migration 15,
     db.count_plans) once a teacher revising the same week fifteen times for
     free while another was locked out after two short ones made it obvious
     plan count was never what was being protected.

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


def scenario(status, tokens_used, *, keys: bool, free_cap: int = 1000, sub_cap: int = 1_000_000, plans: int = 0):
    db.get_user_by_id = lambda _uid: {"subscription_status": status}
    # Still called (Entitlement.plans_used rides along for the account menu),
    # just no longer what gates — see promise 6.
    db.count_plans = lambda _uid: plans
    db.tokens_used_since = lambda _uid, _since: tokens_used
    settings.stripe_secret_key = "sk_test" if keys else ""
    settings.stripe_price_id = "price_test" if keys else ""
    settings.stripe_webhook_secret = "whsec_test" if keys else ""
    settings.free_weekly_token_cap = free_cap
    settings.subscriber_weekly_token_cap = sub_cap
    return E.entitlement("u")


def main() -> int:
    real = (db.get_user_by_id, db.count_plans, db.tokens_used_since)
    real_settings = (
        settings.stripe_secret_key,
        settings.stripe_price_id,
        settings.stripe_webhook_secret,
        settings.free_weekly_token_cap,
        settings.subscriber_weekly_token_cap,
    )
    try:
        print("\n1. Billing unconfigured — the gate is inert")
        check("no keys, huge usage, no status", scenario(None, 999_999, keys=False).may_generate, True)
        check("no keys reports disabled", scenario(None, 999_999, keys=False).billing_enabled, False)

        print("\n2. Grandfathered accounts (migration 15 sets 'comped') get the subscriber cap")
        check(
            "comped, over the free cap but under the subscriber cap",
            scenario("comped", 5_000, keys=True, free_cap=1000, sub_cap=1_000_000).may_generate,
            True,
        )
        check(
            "same usage, NOT comped — the free cap alone blocks it",
            scenario(None, 5_000, keys=True, free_cap=1000, sub_cap=1_000_000).may_generate,
            False,
        )

        print("\n3. The free cap — a trailing-week token budget, not a plan count")
        check("new teacher, 0 tokens", scenario(None, 0, keys=True, free_cap=1000).may_generate, True)
        check("new teacher, 1 token under the cap", scenario(None, 999, keys=True, free_cap=1000).may_generate, True)
        check("new teacher, AT the cap", scenario(None, 1000, keys=True, free_cap=1000).may_generate, False)
        check("tokens_remaining under the cap", scenario(None, 400, keys=True, free_cap=1000).tokens_remaining, 600)
        check("tokens_remaining never negative past the cap", scenario(None, 1500, keys=True, free_cap=1000).tokens_remaining, 0)

        print("\n4. Statuses that entitle — at the SUBSCRIBER cap")
        for status in ("active", "trialing", "past_due", "comped"):
            check(
                f"{status}, over the free cap, under the subscriber cap",
                scenario(status, 1000, keys=True, free_cap=1000, sub_cap=1_000_000).may_generate,
                True,
            )

        print("\n5. Statuses that do not — capped at the free tier like anyone unsubscribed")
        for status in ("canceled", "incomplete_expired", "unpaid", None, ""):
            check(
                f"{status!r}, at the free cap",
                scenario(status, 1000, keys=True, free_cap=1000, sub_cap=1_000_000).may_generate,
                False,
            )

        print("\n6. A missing user row is not an accidental free pass")
        db.get_user_by_id = lambda _uid: None
        db.count_plans = lambda _uid: 5
        db.tokens_used_since = lambda _uid, _since: 5000
        settings.free_weekly_token_cap = 1000
        check("no user row, over the free cap", E.entitlement("ghost").may_generate, False)
    finally:
        db.get_user_by_id, db.count_plans, db.tokens_used_since = real
        (
            settings.stripe_secret_key,
            settings.stripe_price_id,
            settings.stripe_webhook_secret,
            settings.free_weekly_token_cap,
            settings.subscriber_weekly_token_cap,
        ) = real_settings

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — the gate opens for exactly the right people.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
