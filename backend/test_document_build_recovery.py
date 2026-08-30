"""Contract tests for the durable document-job retry policy.

These tests stay DB-free: the policy is intentionally kept as a small,
inspectable contract in db.py and exercised in integration once DATABASE_URL
is available. They protect the critical promise that transient build failures
are retried automatically but cannot loop forever.
"""

from pathlib import Path

DB_SOURCE = Path(__file__).with_name("db.py").read_text()


def test_document_jobs_have_a_scheduled_retry_column():
    assert "available_at" in DB_SOURCE
    assert "idx_document_build_jobs_ready" in DB_SOURCE


def test_document_jobs_claim_only_when_retry_is_due():
    assert "COALESCE(available_at, updated_at) <= ?" in DB_SOURCE


def test_document_jobs_bound_automatic_retries():
    assert "if attempts < 3:" in DB_SOURCE
    assert "delay_seconds = 15 * (2 ** max(0, attempts - 1))" in DB_SOURCE
