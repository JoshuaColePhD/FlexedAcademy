"""Opt-in integration database: explicit localhost URL and an isolated schema."""
import os
import socket
import uuid

import psycopg2
import pytest
from psycopg2 import sql
from psycopg2.extensions import make_dsn, parse_dsn

from backend import db


@pytest.fixture(autouse=True)
def no_external_network(monkeypatch):
    """Backend checks may use localhost fixtures, never saved cloud credentials."""
    # libpq resolves hosts in C, bypassing Python's socket.getaddrinfo. Blank
    # the loaded .env URL too; the explicit local_pg_database fixture replaces
    # this only after validating an independently supplied localhost DSN.
    monkeypatch.setattr(db.settings, "database_url", "")
    resolve = socket.getaddrinfo

    def local_only(host, *args, **kwargs):
        hostname = host.decode() if isinstance(host, bytes) else host
        if hostname not in {None, "", "localhost", "127.0.0.1", "::1", "0.0.0.0"}:
            raise RuntimeError("External network is disabled in backend tests; mock the service or use localhost.")
        return resolve(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", local_only)


@pytest.fixture
def local_pg_database(monkeypatch):
    # Never fall back to DATABASE_URL or .env: those can name a live account.
    url = os.environ.get("FLEXED_TEST_DATABASE_URL") or os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set FLEXED_TEST_DATABASE_URL to a disposable localhost Postgres database")
    options = parse_dsn(url)
    if options.get("host", "") not in {"127.0.0.1", "localhost", "::1"}:
        pytest.fail("Integration databases must be explicitly hosted on localhost")
    options.setdefault("sslmode", "disable")
    schema = "flexed_test_" + uuid.uuid4().hex
    admin = psycopg2.connect(url, connect_timeout=3)
    admin.autocommit = True
    with admin.cursor() as cur:
        cur.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    options["options"] = "-c search_path=" + schema + ",public"
    db.close()
    monkeypatch.setattr(db.settings, "database_url", make_dsn(**options))
    monkeypatch.setattr(db.settings, "db_pool_size", 4)
    try:
        yield {"schema": schema, "database": db}
    finally:
        db.close()
        with admin.cursor() as cur:
            cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
        admin.close()
