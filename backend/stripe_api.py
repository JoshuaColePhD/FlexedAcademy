"""A very small Stripe client, built on `requests` rather than the SDK.

The whole of what this app asks Stripe to do is four things: quote a price,
open a Checkout page, open the billing portal, and verify a webhook. That is
about eighty lines against a documented form-encoded REST API, versus a
dependency that pulls its own transport stack into a 512MB box which has
already been OOM-killed once. So: no SDK.

Signature verification is the one part worth reading carefully — it is what
stops anyone who can reach the URL from granting themselves a subscription. It
follows Stripe's documented scheme: the `Stripe-Signature` header carries a
timestamp `t` and one or more `v1` HMAC-SHA256 digests over `"{t}.{body}"`,
keyed by the endpoint's signing secret. We compare in constant time and reject
anything older than the tolerance, which is what makes a captured-and-replayed
webhook stop working.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time

import requests

from .config import settings
from .errors import AppError

log = logging.getLogger("aplang.stripe")

API = "https://api.stripe.com/v1"
TIMEOUT = 20
# Stripe's own default. A webhook that took longer than five minutes to arrive
# is either a replay or a clock problem; both should fail loudly.
SIGNATURE_TOLERANCE_S = 300


def _call(method: str, path: str, data: dict | None = None) -> dict:
    if not settings.stripe_secret_key:
        raise AppError("billing_unconfigured", "Billing isn’t set up yet.", status=503)
    try:
        res = requests.request(
            method,
            f"{API}{path}",
            auth=(settings.stripe_secret_key, ""),
            data=_flatten(data or {}),
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        log.warning("stripe unreachable: %s", e)
        raise AppError(
            "billing_unreachable",
            "Couldn’t reach the payment provider.",
            status=502,
            hint="Try again in a moment — nothing was charged.",
        ) from e
    body = res.json() if res.content else {}
    if not res.ok:
        # Stripe's message is written for the person paying, so it is safe and
        # useful to pass through ("Your card was declined."). The type/code go
        # to the log, not the browser.
        err = body.get("error", {})
        log.warning("stripe %s %s -> %s %s", method, path, res.status_code, err.get("code"))
        raise AppError(
            "billing_error",
            err.get("message") or "The payment provider rejected that request.",
            status=502,
        )
    return body


def _flatten(data: dict, prefix: str = "") -> list[tuple[str, str]]:
    """Stripe takes nested data as `a[b][c]=v` form pairs, not JSON."""
    out: list[tuple[str, str]] = []
    for key, value in data.items():
        name = f"{prefix}[{key}]" if prefix else key
        if isinstance(value, dict):
            out.extend(_flatten(value, name))
        elif isinstance(value, list):
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    out.extend(_flatten(item, f"{name}[{i}]"))
                else:
                    out.append((f"{name}[{i}]", str(item)))
        elif isinstance(value, bool):
            out.append((name, "true" if value else "false"))
        elif value is not None:
            out.append((name, str(value)))
    return out


# The price changes about never, and the public landing page asks for it on
# every anonymous visit. Cached so a crawler cannot turn a marketing page into
# a Stripe rate-limit problem.
_PRICE_CACHE: dict[str, tuple[float, dict]] = {}
PRICE_TTL_S = 600


def get_price(price_id: str) -> dict:
    """Read the price from Stripe rather than hardcoding it in the UI.

    This matters more than it looks: a number typed into the frontend is a
    number that goes stale the first time the price changes, and a paywall
    quoting the wrong figure is a promise the checkout page then breaks.
    """
    hit = _PRICE_CACHE.get(price_id)
    if hit and time.time() - hit[0] < PRICE_TTL_S:
        return hit[1]
    p = _call("GET", f"/prices/{price_id}")
    recurring = p.get("recurring") or {}
    out = {
        "amount": p.get("unit_amount"),
        "currency": (p.get("currency") or "usd").upper(),
        "interval": recurring.get("interval"),
        "interval_count": recurring.get("interval_count") or 1,
    }
    _PRICE_CACHE[price_id] = (time.time(), out)
    return out


def create_checkout_session(*, price_id: str, customer_id: str | None, email: str,
                            user_id: str, success_url: str, cancel_url: str) -> dict:
    data: dict = {
        "mode": "subscription",
        "line_items": [{"price": price_id, "quantity": 1}],
        "success_url": success_url,
        "cancel_url": cancel_url,
        # Both, deliberately. `client_reference_id` survives on the session;
        # the subscription metadata is what later invoice webhooks carry, and
        # those are the ones that arrive months from now at renewal time.
        "client_reference_id": user_id,
        "subscription_data": {"metadata": {"user_id": user_id}},
        "allow_promotion_codes": True,
    }
    if customer_id:
        data["customer"] = customer_id
    else:
        data["customer_email"] = email
    return _call("POST", "/checkout/sessions", data)


def create_portal_session(*, customer_id: str, return_url: str) -> dict:
    return _call("POST", "/billing_portal/sessions",
                 {"customer": customer_id, "return_url": return_url})


def get_subscription(subscription_id: str) -> dict:
    return _call("GET", f"/subscriptions/{subscription_id}")


def cancel_subscriptions_for_customer(customer_id: str) -> None:
    """Called right before deleting an account: a departed teacher should not
    keep being billed for access that no longer exists. There is no single
    "cancel everything for this customer" endpoint — list, then cancel each
    (a customer only ever has one subscription in this app, but nothing
    stops Stripe from having more, e.g. a manually created one). Best-effort
    per subscription: one failing to cancel should not be the reason account
    deletion itself fails — the caller logs and moves on.
    """
    # A GET's filters are query params, not a form body — every other _call
    # site here is either a bodyless GET or a POST, so this is the one place
    # that needs to build the querystring itself.
    subs = _call("GET", f"/subscriptions?customer={customer_id}&status=all")
    for sub in subs.get("data", []):
        if sub.get("status") in ("canceled", "incomplete_expired"):
            continue
        _call("DELETE", f"/subscriptions/{sub['id']}")


def verify_webhook(payload: bytes, sig_header: str, secret: str) -> dict:
    """Return the parsed event, or raise. Never trust an unverified body."""
    parts = dict(
        piece.split("=", 1) for piece in (sig_header or "").split(",") if "=" in piece
    )
    timestamp, signature = parts.get("t"), parts.get("v1")
    if not timestamp or not signature:
        raise AppError("bad_signature", "Unsigned webhook.", status=400)
    try:
        age = time.time() - int(timestamp)
    except ValueError:
        raise AppError("bad_signature", "Malformed webhook timestamp.", status=400) from None
    if abs(age) > SIGNATURE_TOLERANCE_S:
        raise AppError("bad_signature", "Stale webhook.", status=400)

    expected = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise AppError("bad_signature", "Bad webhook signature.", status=400)
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        raise AppError("bad_signature", "Unparseable webhook body.", status=400) from None
