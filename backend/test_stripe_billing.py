import hashlib
import hmac
import time

import pytest

from backend import stripe_api
from backend.errors import AppError
from backend.routes import billing


def _signature(payload: bytes, secret: str, timestamp: int | None = None) -> str:
    timestamp = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={digest}"


def test_verify_webhook_accepts_any_rotating_v1_signature():
    payload = b'{"id":"evt_123","type":"ping"}'
    timestamp = int(time.time())
    valid = _signature(payload, "new-secret", timestamp).split("v1=", 1)[1]
    header = f"t={timestamp},v1=old-signature,v1={valid}"

    assert stripe_api.verify_webhook(payload, header, "new-secret")["id"] == "evt_123"


def test_verify_webhook_rejects_non_object_json():
    payload = b"[]"
    with pytest.raises(AppError, match="Unparseable webhook body"):
        stripe_api.verify_webhook(payload, _signature(payload, "secret"), "secret")


def test_stripe_non_json_error_becomes_provider_error(monkeypatch):
    class Response:
        content = b"upstream html"
        ok = False
        status_code = 502

        def json(self):
            raise ValueError("not json")

    monkeypatch.setattr(stripe_api.settings, "stripe_secret_key", "sk_test")
    monkeypatch.setattr(stripe_api.requests, "request", lambda *args, **kwargs: Response())

    with pytest.raises(AppError, match="payment provider rejected"):
        stripe_api._call("GET", "/prices/price_test")


def test_checkout_uses_recurring_price_without_a_second_trial(monkeypatch):
    captured = {}

    def fake_call(method, path, data=None):
        captured.update(method=method, path=path, data=data)
        return {"id": "cs_123", "url": "https://checkout.stripe.com/cs_123"}

    monkeypatch.setattr(stripe_api, "_call", fake_call)

    session = stripe_api.create_checkout_session(
        price_id="price_123",
        customer_id=None,
        email="teacher@example.com",
        user_id="user_1",
        success_url="https://example.com/?checkout=success",
        cancel_url="https://example.com/?checkout=cancelled",
        trial_days=0,
    )

    assert session["url"].startswith("https://checkout.stripe.com/")
    assert captured["data"]["mode"] == "subscription"
    assert captured["data"]["line_items"] == [{"price": "price_123", "quantity": 1}]
    assert "trial_period_days" not in captured["data"]["subscription_data"]


def _subscription_event(event_id: str, created: int, status: str = "active") -> dict:
    return {
        "id": event_id,
        "type": "customer.subscription.updated",
        "created": created,
        "data": {"object": {"id": "sub_123", "customer": "cus_123", "status": status}},
    }


def test_webhook_deduplicates_and_ignores_late_subscription_events(monkeypatch):
    events = {
        "evt_new": _subscription_event("evt_new", 200, "active"),
        "evt_old": _subscription_event("evt_old", 100, "canceled"),
    }
    processed = set()
    recorded = []
    latest = {}
    writes = []

    monkeypatch.setattr(
        stripe_api, "verify_webhook", lambda payload, signature, secret: events[payload.decode()]
    )
    monkeypatch.setattr(billing.db, "stripe_webhook_event_processed", lambda event_id: event_id in processed)
    monkeypatch.setattr(
        billing.db,
        "stripe_object_event_is_newer",
        lambda object_id, created: created > latest.get(object_id, -1),
    )

    def record(event_id, event_type, object_id, created):
        processed.add(event_id)
        recorded.append((event_id, event_type, object_id, created))
        if object_id:
            latest[object_id] = max(latest.get(object_id, -1), created or -1)

    monkeypatch.setattr(billing.db, "record_stripe_webhook_event", record)
    monkeypatch.setattr(billing.db, "get_user_by_stripe_customer", lambda customer: {"id": "user_1"})
    monkeypatch.setattr(
        billing.db,
        "set_subscription",
        lambda user_id, **kwargs: writes.append((user_id, kwargs)),
    )

    billing._handle_webhook_event(b"evt_new", "")
    billing._handle_webhook_event(b"evt_new", "")
    billing._handle_webhook_event(b"evt_old", "")

    assert writes == [("user_1", {"customer_id": "cus_123", "status": "active", "period_end": None})]
    assert [row[0] for row in recorded] == ["evt_new", "evt_old"]


def test_checkout_webhook_retries_when_subscription_lookup_fails(monkeypatch):
    event = {
        "id": "evt_checkout",
        "type": "checkout.session.completed",
        "created": 200,
        "data": {
            "object": {
                "id": "cs_123",
                "client_reference_id": "user_1",
                "customer": "cus_123",
                "subscription": "sub_123",
            }
        },
    }
    recorded = []
    writes = []

    monkeypatch.setattr(stripe_api, "verify_webhook", lambda *args: event)
    monkeypatch.setattr(billing.db, "stripe_webhook_event_processed", lambda event_id: False)
    monkeypatch.setattr(billing.db, "stripe_object_event_is_newer", lambda *args: True)
    monkeypatch.setattr(
        stripe_api,
        "get_subscription",
        lambda subscription_id: (_ for _ in ()).throw(
            AppError("billing_unreachable", "temporary", status=502)
        ),
    )
    monkeypatch.setattr(
        billing.db,
        "set_subscription",
        lambda *args, **kwargs: writes.append((args, kwargs)),
    )
    monkeypatch.setattr(
        billing.db,
        "record_stripe_webhook_event",
        lambda *args: recorded.append(args),
    )

    with pytest.raises(AppError, match="temporary"):
        billing._handle_webhook_event(b"payload", "")

    assert not writes
    assert not recorded
