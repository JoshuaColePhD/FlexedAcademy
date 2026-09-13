"""A pasted secret with stray whitespace must not silently break the app.

STRIPE_SECRET_KEY shipped with a trailing newline in the Render dashboard
once and broke every Stripe call for hours with an opaque header error
rather than a clear "bad credential" one. This is a regression test for the
fix, not just for Stripe: it exercises every dashboard-pasted field the
config strips.
"""
from __future__ import annotations

from backend.config import Settings


def test_trailing_newline_on_stripe_key_is_stripped(monkeypatch):
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_live_abc123\n")
    settings = Settings(_env_file=None)
    assert settings.stripe_secret_key == "sk_live_abc123"


def test_leading_and_trailing_whitespace_stripped_on_pasted_fields(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", " sk-abc \n")
    monkeypatch.setenv("OWNER_EMAIL", "josh@example.com \n")
    monkeypatch.setenv("DATABASE_URL", "\npostgres://example\n")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "  client-id  ")
    settings = Settings(_env_file=None)
    assert settings.openai_api_key == "sk-abc"
    assert settings.owner_email == "josh@example.com"
    assert settings.database_url == "postgres://example"
    assert settings.google_client_id == "client-id"


def test_unset_optional_google_client_id_stays_none(monkeypatch):
    monkeypatch.delenv("GOOGLE_CLIENT_ID", raising=False)
    settings = Settings(_env_file=None)
    assert settings.google_client_id is None
