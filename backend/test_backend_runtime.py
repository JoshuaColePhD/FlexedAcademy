"""Behavioral regression coverage for request context, queues, and transactions."""
from __future__ import annotations

import asyncio
import threading
from contextlib import contextmanager, nullcontext
from copy import deepcopy
from pathlib import Path
from typing import Annotated
from unittest.mock import MagicMock

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from backend import db, deps, server, service, teaching
from backend.routes import billing, school_calendars


@pytest.fixture(autouse=True)
def no_real_database(monkeypatch):
    def refuse():
        raise AssertionError("Runtime regressions must not connect to a database")
    monkeypatch.setattr(db, "_ensure_pool", refuse)


def test_real_psycopg_connection_subclass_initializes_vector_only_once(monkeypatch):
    connection = db.DatabaseConnection.__new__(db.DatabaseConnection)
    cursor = MagicMock()
    def tuple_cursor(_connection, *, cursor_factory):
        assert cursor_factory is db.psycopg2.extensions.cursor
        return nullcontext(cursor)
    monkeypatch.setattr(db.DatabaseConnection, "cursor", tuple_cursor)
    registered = []
    monkeypatch.setattr(db, "register_vector", lambda cur: registered.append(cur))
    db._register_vector_once(connection)
    db._register_vector_once(connection)
    assert registered == [cursor]
    assert connection._vector_registered is True


def test_auth_identity_reaches_sync_route_and_isolated_next_request(monkeypatch):
    app = FastAPI()
    monkeypatch.setattr(deps, "verified_user", lambda cookie: {"id": cookie} if cookie else None)

    @app.get("/scope")
    def scope(user_id: Annotated[str, Depends(deps.get_current_user)]):
        return {"user": user_id, "rls": db.current_user_id.get()}

    client = TestClient(app)
    assert client.get("/scope", cookies={"flexed_session": "teacher-a"}).json() == {"user": "teacher-a", "rls": "teacher-a"}
    assert client.get("/scope", cookies={"flexed_session": "teacher-b"}).json() == {"user": "teacher-b", "rls": "teacher-b"}
    assert db.current_user_id.get() is None


def test_middleware_auth_does_not_block_event_loop_and_is_reused(monkeypatch):
    started, release = threading.Event(), threading.Event()
    calls = []

    def verify(cookie):
        calls.append(cookie)
        started.set()
        assert release.wait(2), "the event loop could not release the auth worker"
        return {"id": "teacher-a"}

    monkeypatch.setattr(server, "verified_user", verify)

    async def exercise():
        reached = []

        async def downstream(scope, receive, send):
            request = server.Request(scope)
            assert await deps.get_current_user(request, "ignored") == "teacher-a"
            reached.append(db.current_user_id.get())

        async def receive():
            return {"type": "http.request"}

        async def send(_message):
            pass

        scope = {"type": "http", "method": "POST", "path": "/api/chats", "headers": [(b"cookie", b"flexed_session=test")], "query_string": b""}
        task = asyncio.create_task(server.ReadOnlyDemoMiddleware(downstream)(scope, receive, send))
        for _ in range(100):
            if started.is_set():
                break
            await asyncio.sleep(.01)
        assert started.is_set()
        release.set()
        await task
        assert reached == ["teacher-a"]
        assert db.current_user_id.get() is None

    asyncio.run(exercise())
    assert calls == ["test"]


def test_composed_db_helpers_commit_once_and_rollback_failure(monkeypatch):
    class Cursor:
        rowcount = 1
        def __enter__(self):
            return self
        def __exit__(self, *_):
            pass
        def execute(self, sql, _params=()):
            if sql == "FAIL":
                raise RuntimeError("write failed")
        def fetchone(self):
            return {"id": "row"}

    class Connection:
        closed = False
        _vector_registered = True
        commits = 0
        rollbacks = 0
        def cursor(self):
            return Cursor()
        def commit(self):
            self.commits += 1
        def rollback(self):
            self.rollbacks += 1

    class Pool:
        acquired = 0
        def getconn(self):
            self.acquired += 1
            return connection
        def putconn(self, _conn, **_):
            pass

    connection, pool = Connection(), Pool()
    monkeypatch.setattr(db, "_ensure_pool", lambda: pool)
    monkeypatch.setattr(db, "_slots", threading.Semaphore(1))
    with db.transaction():
        db._write("first")
        db._write_returning("second")
        assert connection.commits == 0
    assert connection.commits == 1
    assert pool.acquired == 1
    with pytest.raises(RuntimeError), db.transaction():
        db._write("first")
        db._write("FAIL")
    assert connection.commits == 1
    assert connection.rollbacks == 1
    assert db._transaction_connection.get() is None


@pytest.mark.parametrize("revision,claim,status,expected", [(2, "old", "building", "requeue"), (1, "new", "building", "ignore"), (1, "old", "queued", "ignore"), (1, "old", "building", "publish")])
def test_document_completion_requires_revision_and_claim(monkeypatch, revision, claim, status, expected):
    writes, queued = [], []
    monkeypatch.setattr(db, "transaction", nullcontext)
    monkeypatch.setattr(db, "_row", lambda sql, _: {"revision": revision} if "FROM plans" in sql else {"claim_token": claim, "plan_revision": 1, "status": status, "attempts": 1})
    monkeypatch.setattr(db, "_write", lambda sql, values: writes.append((sql, values)))
    monkeypatch.setattr(db, "enqueue_document_build", lambda *args: queued.append(args))
    result = db.finish_document_build("p", "u", claim_token="old", plan_revision=1, docx_path="r1.docx")
    assert result is (expected == "publish")
    assert bool(queued) is (expected == "requeue")
    assert bool(writes) is (expected == "publish")


def test_document_worker_never_publishes_obsolete_artifact(monkeypatch):
    state = {"plan_json": {"course": "English"}, "revision": 1, "warnings": []}
    removed, built = [], []
    monkeypatch.setattr(db, "get_plan", lambda *_: deepcopy(state))
    monkeypatch.setattr(service, "with_subject", lambda plan, **_: plan)
    monkeypatch.setattr(service.docx_build, "plan_output_path", lambda *_: Path("/tmp/unused-audit.docx"))
    def build(_plan, path, *_):
        built.append(path)
        state["revision"] = 2
    monkeypatch.setattr(service, "_build_docx_for_template", build)
    monkeypatch.setattr(service, "_persist_docx", lambda _: None)
    monkeypatch.setattr(db, "finish_document_build", lambda *_, **kwargs: kwargs["plan_revision"] == state["revision"])
    monkeypatch.setattr(service.storage, "remove_file", removed.append)
    service._run_document_build_job({"plan_id": "p", "user_id": "u", "plan_revision": 1, "claim_token": "old-claim"})
    assert removed == built
    assert "-r1-old-claim" in built[0].name


@pytest.mark.parametrize("current,obsolete,expected", [
    ("latest-r2-aaaaaaaaaaaa.docx", "older-r1-bbbbbbbbbbbb.docx", True),
    ("latest-r2-aaaaaaaaaaaa.docx", "latest-r2-aaaaaaaaaaaa.docx", False),
    (None, "older-r1-bbbbbbbbbbbb.docx", False),
    ("latest-r2-aaaaaaaaaaaa.docx", "legacy.docx", False),
])
def test_obsolete_document_cleanup_never_removes_current_or_reusable_name(monkeypatch, tmp_path, current, obsolete, expected):
    removed = []
    monkeypatch.setattr(db.settings, "plans_dir", tmp_path)
    monkeypatch.setattr(db, "transaction", nullcontext)
    monkeypatch.setattr(db, "_row", lambda *_: {"docx_path": str(tmp_path / current) if current else None})
    monkeypatch.setattr(db, "_write", lambda *_: None)
    monkeypatch.setattr(db.storage, "remove_file", removed.append)
    db.cleanup_obsolete_document("u", "p", str(tmp_path / obsolete))
    assert removed == ([tmp_path / obsolete] if expected else [])


def test_publish_commits_before_obsolete_cleanup(monkeypatch):
    sequence = []
    @contextmanager
    def transaction():
        yield
        sequence.append("commit")
    monkeypatch.setattr(db, "transaction", transaction)
    monkeypatch.setattr(db, "_row", lambda sql, _: {"revision": 1} if "FROM plans" in sql else {"claim_token": "claim", "plan_revision": 1, "status": "building", "attempts": 1, "previous_docx_path": "old.docx"})
    monkeypatch.setattr(db, "_write", lambda *_: None)
    monkeypatch.setattr(db, "cleanup_obsolete_document", lambda *_: sequence.append("cleanup"))
    assert db.finish_document_build("p", "u", claim_token="claim", plan_revision=1, docx_path="new.docx") is True
    assert sequence == ["commit", "cleanup"]


@pytest.mark.parametrize("fail_commit", [False, True])
def test_plan_delete_cleans_both_known_artifacts_only_after_commit(monkeypatch, tmp_path, fail_commit):
    sequence = []
    @contextmanager
    def transaction():
        yield
        if fail_commit:
            raise RuntimeError("database unavailable")
        sequence.append("commit")
    current, previous = str(tmp_path / "current.docx"), str(tmp_path / "old.docx")
    monkeypatch.setattr(db, "transaction", transaction)
    monkeypatch.setattr(db, "_row", lambda *_: {"docx_path": current, "previous_docx_path": previous})
    monkeypatch.setattr(db, "_write", lambda *_: 1)
    monkeypatch.setattr(db, "_remove_plan_artifacts", lambda paths: sequence.append(paths))
    if fail_commit:
        with pytest.raises(RuntimeError):
            db.delete_plan("u", "p")
        assert sequence == []
    else:
        assert db.delete_plan("u", "p") is True
        assert sequence == ["commit", [current, previous]]


@pytest.mark.parametrize("coverage_fails", [False, True])
def test_restore_rebuilds_class_coverage_before_committing(monkeypatch, coverage_fails):
    sequence = []
    cursor, connection = MagicMock(), MagicMock()
    cursor.__enter__.return_value = cursor
    connection.cursor.return_value = cursor
    content = {"course": "English", "week_of": "Week 1", "days": []}
    version = {"plan_json": content, "retrieved_ids": ["A.1"], "warnings": [], "provenance": {}, "template_id": None, "template": "default", "unit": "Claims", "week_number": 1}
    cursor.fetchone.side_effect = [{"revision": 3}, version]
    @contextmanager
    def transaction():
        try:
            yield connection
        except Exception:
            sequence.append("rollback")
            raise
        sequence.append("commit")
    monkeypatch.setattr(db, "transaction", transaction)
    monkeypatch.setattr(teaching, "require_plan", lambda *_: {"id": "p", "class_id": "class-a", "course": "English", "plan_json": content, "revision": 4})
    monkeypatch.setattr(db, "get_class", lambda *_: {"subject": "ELA", "grade": 11})
    cited = [{"code": "A.1"}]
    def classify(plan, allowed, *, subject_code):
        assert plan == content and allowed == {"A.1"} and subject_code == "ELA"
        return cited
    monkeypatch.setattr(teaching.retrieval, "cited_standards", classify)
    def replace(plan_id, user_id, **fields):
        assert (plan_id, user_id) == ("p", "a")
        assert fields == {"class_id": "class-a", "subject": "ELA", "grade": "11", "entries": cited}
        assert "commit" not in sequence
        sequence.append("coverage")
        if coverage_fails:
            raise RuntimeError("coverage unavailable")
    monkeypatch.setattr(db, "replace_plan_standards", replace)
    def enqueue(plan_id, user_id):
        assert (plan_id, user_id) == ("p", "a")
        assert sequence == ["coverage"]
        sequence.append("document")
    monkeypatch.setattr(db, "enqueue_document_build", enqueue)
    if coverage_fails:
        with pytest.raises(RuntimeError):
            teaching.restore_version("a", "p", 2, 3)
        assert sequence == ["coverage", "rollback"]
    else:
        assert teaching.restore_version("a", "p", 2, 3)["revision"] == 4
        assert sequence == ["coverage", "document", "commit"]


def test_worker_repeats_stale_recovery_after_startup_failure(monkeypatch):
    sweeps = []
    def sweep():
        sweeps.append(True)
        if len(sweeps) == 1:
            raise TimeoutError("startup pool outage")
        raise asyncio.CancelledError()
    monkeypatch.setattr(db, "reset_stale_document_builds", sweep)
    monkeypatch.setattr(server, "_DOCUMENT_BUILD_SWEEP_INTERVAL_S", 0)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(server._document_build_worker_loop())
    assert len(sweeps) == 2


def test_parallel_webhooks_cannot_restore_an_older_subscription(monkeypatch):
    lock = threading.Lock()
    seen, writes, errors = [], [], []
    first_at_write, second_waiting = threading.Event(), threading.Event()
    @contextmanager
    def serialized(_object):
        if threading.current_thread().name == "new-event":
            second_waiting.set()
        with lock:
            yield
    events = {
        b"old": {"id": "old", "created": 100, "type": "customer.subscription.updated", "data": {"object": {"id": "sub", "metadata": {"user_id": "u"}, "status": "active"}}},
        b"new": {"id": "new", "created": 101, "type": "customer.subscription.updated", "data": {"object": {"id": "sub", "metadata": {"user_id": "u"}, "status": "canceled"}}},
    }
    monkeypatch.setattr(billing.stripe_api, "verify_webhook", lambda payload, *_: events[payload])
    monkeypatch.setattr(db, "stripe_webhook_transaction", serialized)
    monkeypatch.setattr(db, "stripe_webhook_event_processed", lambda _: False)
    monkeypatch.setattr(db, "stripe_object_event_is_newer", lambda _, ts: not seen or ts >= max(seen))
    monkeypatch.setattr(db, "stripe_object_event_has_timestamp", lambda *_: False)
    monkeypatch.setattr(db, "record_stripe_webhook_event", lambda _id, _kind, _obj, ts: seen.append(ts))
    def write(_user, **fields):
        if fields["status"] == "active":
            first_at_write.set()
            assert second_waiting.wait(2)
        writes.append(fields["status"])
    monkeypatch.setattr(db, "set_subscription", write)
    def run(payload):
        try:
            billing._handle_webhook_event(payload, "")
        except Exception as exc:  # noqa: BLE001 — propagate thread failures to the assertion
            errors.append(exc)
    old = threading.Thread(target=run, args=(b"old",))
    new = threading.Thread(target=run, args=(b"new",), name="new-event")
    old.start()
    assert first_at_write.wait(2)
    new.start()
    old.join(3)
    new.join(3)
    assert not errors
    assert writes == ["active", "canceled"]
    assert seen == [100, 101]


def test_equal_timestamp_webhook_reconciles_live_subscription(monkeypatch):
    event = {"id": "second", "created": 100, "type": "customer.subscription.updated", "data": {"object": {"id": "sub", "metadata": {"user_id": "u"}, "status": "active"}}}
    writes = []
    monkeypatch.setattr(db, "stripe_webhook_event_processed", lambda _: False)
    monkeypatch.setattr(db, "stripe_object_event_is_newer", lambda *_: True)
    monkeypatch.setattr(db, "stripe_object_event_has_timestamp", lambda *_: True)
    monkeypatch.setattr(billing.stripe_api, "get_subscription", lambda _: {"id": "sub", "metadata": {"user_id": "u"}, "status": "canceled"})
    monkeypatch.setattr(db, "set_subscription", lambda _user, **fields: writes.append(fields))
    monkeypatch.setattr(db, "record_stripe_webhook_event", lambda *_: None)
    billing._apply_webhook_event(event)
    assert writes[0]["status"] == "canceled"


def test_calendar_quota_denial_happens_before_parsing(monkeypatch):
    from backend.errors import AppError
    monkeypatch.setattr(db, "get_school", lambda _: {"id": "a-school"})
    monkeypatch.setattr(school_calendars, "_require_school_access", lambda *_: {"id": "a-school"})
    def refuse(_):
        raise AppError("subscription_required", "Limit reached", status=402)
    monkeypatch.setattr(school_calendars, "require_entitlement", refuse)
    monkeypatch.setattr(school_calendars.calendar_intake, "extract_calendar_text", lambda **_: pytest.fail("intake should not run"))
    with pytest.raises(AppError, match="Limit reached"):
        school_calendars.upload_calendar.__wrapped__(request=None, school_name="A School", source_url=None, file=None, user_id="a")


def test_template_mirror_failure_does_not_create_saved_record(monkeypatch, tmp_path):
    from backend.errors import AppError
    monkeypatch.chdir(tmp_path)
    upload = tmp_path / "upload.docx"
    upload.write_bytes(b"test placeholder")
    monkeypatch.setattr(db, "get_school", lambda _: {"id": "a-school"})
    monkeypatch.setattr(school_calendars, "_require_school_access", lambda *_: {"id": "a-school"})
    monkeypatch.setattr(school_calendars, "require_entitlement", lambda _: None)
    monkeypatch.setattr(school_calendars, "_spool", lambda *_: upload)
    monkeypatch.setattr(school_calendars.template_intake, "validate_upload", lambda *_: ".docx")
    monkeypatch.setattr(school_calendars.template_intake, "require_blank_template", lambda *_: None)
    monkeypatch.setattr(school_calendars.storage, "mirror_file", lambda _: False)
    monkeypatch.setattr(db, "create_school_template", lambda *_, **__: pytest.fail("failed mirror must not create a template"))
    fake_file = type("Upload", (), {"filename": "blank.docx"})()
    with pytest.raises(AppError, match="saved durably"):
        school_calendars.upload_school_template.__wrapped__("a-school", request=None, file=fake_file, source_url=None, blank_template_attested=True, template_scope="personal", user_id="a")
    assert list(tmp_path.rglob("*.docx")) == []
