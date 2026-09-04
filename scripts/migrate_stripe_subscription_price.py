"""One-off: move every existing Stripe subscription onto a new Price.

Changing STRIPE_PRICE_ID (backend/config.py) only affects the checkout flow
for NEW signups — Stripe never moves an existing subscription's price on its
own. Run this once, after the new Price exists in Stripe, to bring already-
subscribed teachers onto it too.

Dry run by default: lists every subscription whose current price is not
already NEW_PRICE_ID and does nothing else. Pass --apply to actually update
them.

Usage (from a machine/shell with the production STRIPE_SECRET_KEY set):

    python scripts/migrate_stripe_subscription_price.py
    python scripts/migrate_stripe_subscription_price.py --apply

proration_behavior is "none": the change takes effect at each subscriber's
next renewal, with no immediate charge or credit for the partial period
already paid at the old price. Pass --proration create_prorations if an
immediate prorated credit (paid back on the next invoice) is wanted instead.
"""
from __future__ import annotations

import argparse
import os
import sys

import stripe

DEFAULT_NEW_PRICE_ID = "price_1UC6iLB3ZHGdtKrGWfnwM8Vw"
ACTIVE_STATUSES = {"active", "trialing", "past_due"}


def find_subscriptions_to_migrate(new_price_id: str) -> list[tuple[dict, dict]]:
    """Every (subscription, item) pair not already on new_price_id."""
    to_migrate = []
    subs = stripe.Subscription.list(status="all", limit=100)
    for sub in subs.auto_paging_iter():
        if sub["status"] not in ACTIVE_STATUSES:
            continue
        for item in sub["items"]["data"]:
            if item["price"]["id"] != new_price_id:
                to_migrate.append((sub, item))
    return to_migrate


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--new-price-id", default=DEFAULT_NEW_PRICE_ID)
    parser.add_argument(
        "--proration",
        default="none",
        choices=["none", "create_prorations", "always_invoice"],
        help="Stripe proration_behavior for the price change (default: none).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually update subscriptions. Omit for a dry run (default).",
    )
    args = parser.parse_args()

    secret_key = os.environ.get("STRIPE_SECRET_KEY")
    if not secret_key:
        sys.exit("STRIPE_SECRET_KEY is not set in this shell's environment.")
    stripe.api_key = secret_key

    to_migrate = find_subscriptions_to_migrate(args.new_price_id)

    if not to_migrate:
        print(f"Nothing to do — every subscription is already on {args.new_price_id}.")
        return

    print(f"Found {len(to_migrate)} subscription item(s) not on {args.new_price_id}:")
    for sub, item in to_migrate:
        price = item["price"]
        amount = f"{price['unit_amount'] / 100:.2f} {price['currency'].upper()}"
        print(f"  subscription={sub['id']}  customer={sub['customer']}  "
              f"status={sub['status']}  current_price={price['id']} ({amount}/{price['recurring']['interval']})")

    if not args.apply:
        print("\nDry run only — nothing was changed. Re-run with --apply to migrate these subscriptions.")
        return

    print(f"\nApplying with proration_behavior={args.proration!r} ...")
    failures = []
    for sub, item in to_migrate:
        try:
            stripe.Subscription.modify(
                sub["id"],
                items=[{"id": item["id"], "price": args.new_price_id}],
                proration_behavior=args.proration,
            )
            print(f"  updated {sub['id']} -> {args.new_price_id}")
        except stripe.error.StripeError as e:
            failures.append((sub["id"], str(e)))
            print(f"  FAILED {sub['id']}: {e}")

    print(f"\nDone. {len(to_migrate) - len(failures)} succeeded, {len(failures)} failed.")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
