"""Durable request identities and completion recovery; model work is never auto-replayed.

The migration is owned by db.py. Every operation binds the owning teacher to RLS.
A restart can replay a terminal result, or reconcile a saved deterministic plan ID.
An interrupted call without a saved result requires an explicit retry.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime

from . import db
from .config import settings
from .errors import AppError

LEASE_SECONDS = 120


def enabled() -> bool:
    return bool(settings.database_url)


def fingerprint(payload: dict) -> str:
    content = {key: value for key, value in payload.items() if key not in {"attempt", "request_id"}}
    return hashlib.sha256(json.dumps(content, sort_keys=True, default=str).encode()).hexdigest()


def plan_id(user_id: str, request_id: str) -> str:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"flexed:generation:{user_id}:{request_id}").hex


def _read(user_id: str, request_id: str) -> dict | None:
    with db.as_user(user_id):
        return db._row("SELECT * FROM generation_runs WHERE user_id = ? AND request_id = ?", (user_id, request_id))


def load(user_id: str, request_id: str) -> dict | None:
    row = _read(user_id, request_id)
    if not row or row["status"] not in {"queued", "running"}:
        return row
    expires = row.get("lease_expires_at")
    if isinstance(expires, str):
        expires = datetime.fromisoformat(expires)
    if expires is not None and expires > datetime.now(UTC):
        return row
    # The save may have committed just before the old process died. Resolve by
    # deterministic ID instead of generating a second week or guessing by title.
    with db.as_user(user_id):
        saved = db.get_plan(user_id, plan_id(user_id, request_id))
        result = None
        if saved:
            result = {"done": True, "plan_id": saved["id"], "plan": saved["plan_json"],
                      "warnings": saved.get("warnings", []), "week_label": saved["week_label"], "unit": saved.get("unit")}
        error = None if result else {"code": "generation_interrupted", "message": "The server restarted before this request finished.", "retryable": True}
        db._write(
            "UPDATE generation_runs SET status = ?, result_json = ?::jsonb, error_json = ?::jsonb, updated_at = now() "
            "WHERE user_id = ? AND request_id = ? AND status IN ('queued','running') AND lease_expires_at <= now()",
            ("done" if result else "error", json.dumps(result), json.dumps(error), user_id, request_id),
        )
    return _read(user_id, request_id)


def claim(user_id: str, request_id: str, request_fingerprint: str, owner_token: str) -> tuple[dict, bool]:
    """Atomically attach or own this request. Reuse with different input is a 409."""
    load(user_id, request_id)
    with db.as_user(user_id), db.borrow() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO generation_runs (user_id, request_id, fingerprint, status, owner_token, lease_expires_at) "
            "VALUES (%s,%s,%s,'running',%s,now() + interval '120 seconds') ON CONFLICT DO NOTHING RETURNING *",
            (user_id, request_id, request_fingerprint, owner_token),
        )
        row = cur.fetchone()
        owned = row is not None
        if row is None:
            cur.execute("SELECT * FROM generation_runs WHERE user_id=%s AND request_id=%s FOR UPDATE", (user_id, request_id))
            row = cur.fetchone()
            if row["fingerprint"] != request_fingerprint:
                raise AppError("request_conflict", "This request ID already belongs to different content. Start a new request.", status=409)
            if row["status"] in {"error", "cancelled"}:
                cur.execute(
                    "UPDATE generation_runs SET status='running', owner_token=%s, result_json=NULL, error_json=NULL, "
                    "cancellation_requested=false, lease_expires_at=now() + interval '120 seconds', updated_at=now() "
                    "WHERE user_id=%s AND request_id=%s RETURNING *", (owner_token, user_id, request_id),
                )
                row = cur.fetchone()
                owned = True
        conn.commit()
        return dict(row), owned


def heartbeat(user_id: str, request_id: str, owner_token: str) -> bool:
    with db.as_user(user_id):
        row = db._write_returning(
            "UPDATE generation_runs SET lease_expires_at=now() + interval '120 seconds', updated_at=now() "
            "WHERE user_id=? AND request_id=? AND owner_token=? AND status='running' RETURNING cancellation_requested",
            (user_id, request_id, owner_token),
        )
    return row is None or bool(row["cancellation_requested"])


def finish(user_id: str, request_id: str, owner_token: str, status: str, result: dict | None, error: dict | None) -> None:
    with db.as_user(user_id):
        db._write(
            "UPDATE generation_runs SET status=?, result_json=?::jsonb, error_json=?::jsonb, updated_at=now(), lease_expires_at=NULL "
            "WHERE user_id=? AND request_id=? AND owner_token=? AND status='running'",
            (status, json.dumps(result), json.dumps(error), user_id, request_id, owner_token),
        )


def request_cancel(user_id: str, request_id: str) -> None:
    with db.as_user(user_id):
        db._write("UPDATE generation_runs SET cancellation_requested=true WHERE user_id=? AND request_id=? AND status='running'", (user_id, request_id))
