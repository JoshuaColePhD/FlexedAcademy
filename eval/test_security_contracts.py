#!/usr/bin/env python3
"""Who may read what, and who may become whom.

Four properties, each of which was broken in the live app on 2026-08-19 and none
of which anything was checking. They are in the eval harness rather than in a
comment because every one of them fails silently: no exception, no log line,
nothing a teacher could report.

  1. signup must never take over an account that has no local password.
     Google sign-in creates accounts with password_hash = NULL, and signup read
     that as "an unclaimed placeholder seat" — set a password on it and issued a
     session. Confirmed as a working takeover of a real account whose email was
     the only thing the attacker needed to know.

  2. a plan must not be readable until its owner shares it, and must stop being
     readable the moment they unshare it. GET /api/plans/public/{id} takes no
     auth and resolved any plan by id: measured at HTTP 200 with a full plan
     body and no cookie at all.

  3. the SPA catch-all must not serve files from outside the build directory.
     It served the project's own .env — SESSION_SECRET included, which is the
     ability to forge a session cookie for any account in the product.

  4. changing or resetting a password must invalidate other sessions. Neither
     touched session_version, which is the only thing session validity depends
     on, so the one action a teacher takes when she thinks someone is in her
     account locked nobody out.

Talks to whatever DATABASE_URL points at — the app has no test double for the
database. It confines its writes to throwaway @example.com accounts, and always
restores the sharing state of the plan it borrows, but do not point it at
anything you would mind it writing to. Hence needs_corpus=True in run_all.py's
SUITES, so --fast skips it.

    ./venv/bin/python eval/test_security_contracts.py
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend import db  # noqa: E402
from backend.deps import get_current_user  # noqa: E402
from backend.server import app  # noqa: E402

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"   (got {got!r}, want {want!r})"))
    if not ok:
        FAILURES.append(label)


def anon() -> TestClient:
    """A client with no cookies — a stranger holding a link."""
    return TestClient(app, raise_server_exceptions=False)


def as_user(user_id: str) -> TestClient:
    app.dependency_overrides[get_current_user] = lambda: user_id
    return TestClient(app, raise_server_exceptions=False)


def clear_override() -> None:
    app.dependency_overrides.pop(get_current_user, None)


def throwaway() -> str:
    email = f"sec-test-{uuid.uuid4().hex[:10]}@example.com"
    db._write("DELETE FROM users WHERE email = ?", (email,))
    return email


def drop(email: str) -> None:
    db._write("DELETE FROM users WHERE email = ?", (email,))


# ── 1. account takeover ─────────────────────────────────────────────────────


def test_signup_cannot_claim_a_passwordless_account() -> None:
    print("\nsignup vs a Google account (password_hash IS NULL)")
    email = throwaway()
    try:
        victim = db.create_user(email, "Victim Teacher", password_hash=None)
        r = anon().post(
            "/api/auth/signup",
            json={"name": "Attacker", "email": email, "password": "attacker-password"},
        )
        check("refused with 409", r.status_code, 409)
        after = db.get_user_by_email(email)
        check("no password was set on the account", after["password_hash"], None)
        check("the owner's name was not overwritten", after["name"], "Victim Teacher")
        check("still the same account row", after["id"], victim["id"])
    finally:
        drop(email)


def test_signup_still_works_for_a_new_email() -> None:
    print("\nsignup for a genuinely new email (the fix must not close the front door)")
    email = throwaway()
    try:
        c = anon()
        r = c.post(
            "/api/auth/signup",
            json={"name": "New Teacher", "email": email, "password": "a-good-password"},
        )
        check("created", r.status_code, 200)
        check("session works", c.get("/api/auth/me").status_code, 200)
    finally:
        drop(email)


def test_signup_on_an_existing_password_account_conflicts() -> None:
    print("\nsignup for an email that already has a password")
    email = throwaway()
    try:
        db.create_user(email, "Existing", password_hash="not-a-real-hash")
        r = anon().post(
            "/api/auth/signup",
            json={"name": "Someone", "email": email, "password": "another-password"},
        )
        check("refused with 409", r.status_code, 409)
    finally:
        drop(email)


# ── 4. password changes revoke other sessions ───────────────────────────────


def test_change_password_revokes_other_sessions() -> None:
    print("\nchange-password bumps session_version")
    email = throwaway()
    try:
        c = anon()
        c.post("/api/auth/signup", json={"name": "T", "email": email, "password": "first-password"})
        before = db.get_user_by_email(email)["session_version"]
        r = c.post(
            "/api/auth/change-password",
            json={"current_password": "first-password", "new_password": "second-password"},
        )
        after = db.get_user_by_email(email)["session_version"]
        check("accepted", r.status_code, 200)
        check("session_version advanced", after > before, True)
    finally:
        drop(email)


# ── 2. plan sharing is opt-in and revocable ─────────────────────────────────


def _borrow_plan():
    row = db._row("SELECT id, user_id FROM plans LIMIT 1")
    return (row["id"], row["user_id"]) if row else (None, None)


def test_plan_sharing_round_trip() -> None:
    print("\nplan sharing: opt-in, readable once shared, dead once revoked")
    plan_id, owner = _borrow_plan()
    if not plan_id:
        print("  SKIP  no plans in the database")
        return
    try:
        check("unshared plan is not readable", anon().get(f"/api/plans/public/{plan_id}").status_code, 404)

        owner_client = as_user(owner)
        pub = owner_client.post(f"/api/plans/{plan_id}/public_link", json={"public": True})
        check("owner can publish", pub.status_code, 200)

        shared = anon().get(f"/api/plans/public/{plan_id}")
        check("published plan is readable", shared.status_code, 200)
        if shared.status_code == 200:
            # The field whitelist matters as much as the gate: no owner id, no
            # docx path, nothing that identifies the account.
            check(
                "only plan fields are exposed",
                sorted(shared.json()),
                ["course", "id", "plan_json", "unit", "week_label"],
            )

        rev = owner_client.post(f"/api/plans/{plan_id}/public_link", json={"public": False})
        check("owner can revoke", rev.status_code, 200)
        check("revoked plan is dead", anon().get(f"/api/plans/public/{plan_id}").status_code, 404)
    finally:
        clear_override()
        db._write("UPDATE plans SET is_public = FALSE, shared_at = NULL WHERE id = ?", (plan_id,))


def test_fork_requires_a_shared_plan() -> None:
    print("\nforking an unshared plan (same unscoped lookup as the read)")
    plan_id, owner = _borrow_plan()
    if not plan_id:
        print("  SKIP  no plans in the database")
        return
    try:
        r = as_user(owner).post(f"/api/plans/{plan_id}/fork", json={})
        check("refused", r.status_code, 404)
    finally:
        clear_override()


def test_cannot_publish_another_teachers_plan() -> None:
    print("\npublishing someone else's plan")
    plan_id, owner = _borrow_plan()
    if not plan_id:
        print("  SKIP  no plans in the database")
        return
    other = db._row("SELECT id FROM users WHERE id <> ? LIMIT 1", (owner,))
    if not other:
        print("  SKIP  need a second account")
        return
    try:
        r = as_user(other["id"]).post(f"/api/plans/{plan_id}/public_link", json={"public": True})
        check("refused", r.status_code, 404)
        check("plan did not become public", bool(db._row("SELECT 1 FROM plans WHERE id = ? AND is_public", (plan_id,))), False)
    finally:
        clear_override()
        db._write("UPDATE plans SET is_public = FALSE, shared_at = NULL WHERE id = ?", (plan_id,))


# ── 3. static file containment ──────────────────────────────────────────────


def test_spa_catchall_stays_inside_the_build_directory() -> None:
    print("\nSPA catch-all path traversal")
    c = anon()
    for path in (
        "/%2e%2e/%2e%2e/.env",
        "/..%2f..%2f.env",
        "/%2e%2e%2f%2e%2e%2f.env",
        "/%2e%2e/%2e%2e/backend/config.py",
        "/%2e%2e/%2e%2e/requirements.lock.txt",
    ):
        body = c.get(path).text
        leaked = any(m in body for m in ("SESSION_SECRET=", "OPENAI_API_KEY=", "DATABASE_URL="))
        check(f"no secrets via {path}", leaked, False)


# ── grade values, from the same session ─────────────────────────────────────


def test_grade_is_stored_as_a_value_not_a_label() -> None:
    print("\ngrade normalisation")
    # A label here does not fail loudly: service._resolve_subject_grade catches
    # int() and falls back to 11, so a 12th-grade class silently retrieved
    # 11th-grade standards under real-looking codes.
    for raw, want in (("11th", "11"), ("12th", "12"), ("9th", "9"), ("11", "11"), ("K", "K"), (None, None)):
        check(f"normalize_grade({raw!r})", db.normalize_grade(raw), want)
    rows = db._rows("SELECT id, grade FROM classes WHERE grade ~ '[A-Za-z]' AND grade <> 'K'")
    check("no label-form grades left in the database", rows, [])


def main() -> int:
    test_signup_cannot_claim_a_passwordless_account()
    test_signup_still_works_for_a_new_email()
    test_signup_on_an_existing_password_account_conflicts()
    test_change_password_revokes_other_sessions()
    test_plan_sharing_round_trip()
    test_fork_requires_a_shared_plan()
    test_cannot_publish_another_teachers_plan()
    test_spa_catchall_stays_inside_the_build_directory()
    test_grade_is_stored_as_a_value_not_a_label()

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — accounts, plans and files are reachable only by whoever should reach them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
