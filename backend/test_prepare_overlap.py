"""Regression tests for the Part A latency work (see the approved plan):

  * RequestContext memoizes db lookups instead of re-fetching them.
  * llm helpers skip a redundant db.get_class when handed the class row.
  * service.prepare() overlaps the base embedding, expand_query, and
    map_context_for instead of running them sequentially.
  * llm.stream_plan degrades map_context to "" on a future that raised, and
    on one that hadn't finished within its near-zero timeout — in neither
    case does the failure propagate and break generation.
"""
from __future__ import annotations

import time
from concurrent.futures import Future, ThreadPoolExecutor

from backend import llm, service
from backend import request_context as rc
from backend.retrieval import RetrievalResult


def test_request_context_memoizes_school_settings_and_user(monkeypatch):
    calls = {"school": 0, "settings": 0, "user": 0}

    def fake_class_school(cls, user_id):
        calls["school"] += 1
        return "school-1"

    def fake_settings_row(user_id, subject=None):
        calls["settings"] += 1
        return {"subject": subject}

    def fake_get_user_by_id(user_id):
        calls["user"] += 1
        return {"id": user_id}

    monkeypatch.setattr(rc.db, "class_school", fake_class_school)
    monkeypatch.setattr(rc.db, "get_settings_row", fake_settings_row)
    monkeypatch.setattr(rc.db, "get_user_by_id", fake_get_user_by_id)

    ctx = rc.RequestContext(user_id="teacher-1", class_id="class-1", cls={"id": "class-1"})

    # Called twice each; the underlying db.* call must fire only once per key.
    assert ctx.school_id() == "school-1"
    assert ctx.school_id() == "school-1"
    assert ctx.settings_row("AP_Lang")["subject"] == "AP_Lang"
    assert ctx.settings_row("AP_Lang")["subject"] == "AP_Lang"
    assert ctx.user_row()["id"] == "teacher-1"
    assert ctx.user_row()["id"] == "teacher-1"

    assert calls == {"school": 1, "settings": 1, "user": 1}

    # A different subject key is a genuinely different row — still memoized
    # per-key, not a blanket "only ever fetch once."
    assert ctx.settings_row("ELA")["subject"] == "ELA"
    assert calls["settings"] == 2


def test_llm_helpers_skip_db_get_class_when_cls_given(monkeypatch):
    def fail(*_a, **_kw):
        raise AssertionError("db.get_class should not be called when cls is already known")

    monkeypatch.setattr(llm.db, "get_class", fail)

    cls = {"subject": "AP_Lang", "grade": "11", "period_minutes": 50, "custom_instructions": "Be concise."}

    assert llm._prompt_subject_grade("teacher-1", "class-1", cls=cls) == ("AP_Lang", "11")
    assert llm._class_period_minutes("teacher-1", "class-1", cls=cls) == 50
    assert llm.class_custom_instructions_for("teacher-1", "class-1", cls=cls) == "Be concise."


def test_prepare_overlaps_base_embedding_expand_query_and_map_context(monkeypatch):
    """Each of the three independent calls sleeps 0.2s. Sequential execution
    (today's behavior before this change) would take >=0.6s; overlapped
    execution should take close to max(0.2s) rather than their sum."""
    delay = 0.2

    def slow_embed_query(text, *, user_id=None):
        time.sleep(delay)
        return [0.0] * 384

    def slow_expand_query(user_id, query):
        time.sleep(delay)
        return []

    def slow_map_context_for(user_id, subject, query, class_id=None, query_vector_future=None):
        time.sleep(delay)
        return ""

    def fake_retrieve_grounded(*args, **kwargs):
        base_future = kwargs.get("base_query_vector_future")
        if base_future is not None:
            base_future.result()  # must not raise
        return RetrievalResult(chunks=[{"id": "x", "metadata": {"code": "X.1"}, "distance": 0.1}])

    monkeypatch.setattr(service.embeddings, "embed_query", slow_embed_query)
    monkeypatch.setattr(service.llm, "expand_query", slow_expand_query)
    monkeypatch.setattr(service.llm, "map_context_for", slow_map_context_for)
    monkeypatch.setattr(service.retrieval, "retrieve_grounded", fake_retrieve_grounded)
    monkeypatch.setattr(service.retrieval, "out_of_scope_grades", lambda *a, **kw: [])
    monkeypatch.setattr(service, "_selected_template_id", lambda *a, **kw: None)
    monkeypatch.setattr(service, "has_template_field", lambda *a, **kw: False)

    cls = {"id": "class-1", "subject": "AP_Lang", "grade": "11", "school": "florence-high-school"}

    started = time.monotonic()
    result, map_context_future = service.prepare(
        "teacher-1",
        "Week 3 rhetorical analysis",
        cls=cls,
        return_map_context_future=True,
    )
    elapsed = time.monotonic() - started

    assert not result.empty
    # Overlapped: well under the 0.6s three sequential 0.2s calls would take.
    assert elapsed < 0.45, f"prepare() took {elapsed:.3f}s — calls do not appear to overlap"
    # map_context_for's own future is still resolvable (it was launched, not
    # dropped) even though prepare() doesn't block on it itself.
    assert map_context_future.result(timeout=1.0) == ""


def test_stream_plan_degrades_to_empty_map_context_on_future_exception(monkeypatch):
    _stub_stream_plan_dependencies(monkeypatch)

    future: Future[str] = Future()
    future.set_exception(RuntimeError("map context blew up"))

    captured = _run_stream_plan_and_capture(monkeypatch, map_context_future=future)
    assert captured["map_context"] == ""


def test_stream_plan_degrades_to_empty_map_context_on_timeout(monkeypatch):
    _stub_stream_plan_dependencies(monkeypatch)

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending_future = pool.submit(time.sleep, 5)  # still running well past 0.1s
        captured = _run_stream_plan_and_capture(monkeypatch, map_context_future=pending_future)
        assert captured["map_context"] == ""
        pending_future.cancel()


def _stub_stream_plan_dependencies(monkeypatch):
    class _FakeStream:
        def __iter__(self):
            return iter([])

        def close(self):
            pass

    class _FakeCompletions:
        def create(self, **kwargs):
            return _FakeStream()

    class _FakeChat:
        completions = _FakeCompletions()

    class _FakeClient:
        chat = _FakeChat()

    monkeypatch.setattr(llm, "client", lambda: _FakeClient())
    monkeypatch.setattr(llm, "day_names_for_school", lambda *a, **kw: ["Monday"])
    monkeypatch.setattr(llm.db, "get_user_by_id", lambda user_id: None)
    monkeypatch.setattr(llm.db, "get_settings_row", lambda user_id, subject=None: {"subject": "AP_Lang", "grade": "11"})


def _run_stream_plan_and_capture(monkeypatch, *, map_context_future) -> dict:
    captured: dict = {}

    def fake_week_system_prompt(*args, **kwargs):
        captured["map_context"] = kwargs.get("map_context")
        return "SYSTEM PROMPT"

    monkeypatch.setattr(llm, "week_system_prompt", fake_week_system_prompt)

    list(
        llm.stream_plan(
            "teacher-1",
            "Build week 3",
            RetrievalResult(),
            school_id="florence-high-school",
            class_id=None,
            map_context_future=map_context_future,
        )
    )
    return captured
