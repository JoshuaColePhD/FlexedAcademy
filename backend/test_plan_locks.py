"""Per-plan write serialization and the concurrent-edit conflict it detects.

The bug this guards against: every plan-mutating path reads plan_json,
computes a new value -- sometimes across a many-second LLM call -- and
overwrites the row unconditionally. Nothing previously stopped a fast write
(the standard picker, a manual cell edit, undo) from landing in the middle
of a slow AI revision's read-...-write window on the same plan and being
silently discarded when the slow write finally commits.
"""
from __future__ import annotations

import threading
import time

import pytest

from backend.errors import AppError
from backend.plan_locks import plan_write_lock


def test_same_plan_id_serializes_two_writers():
    order = []
    barrier_entered = threading.Event()

    def writer_a():
        with plan_write_lock("p1"):
            barrier_entered.set()
            time.sleep(0.05)
            order.append("a")

    def writer_b():
        barrier_entered.wait(timeout=1)
        with plan_write_lock("p1"):
            order.append("b")

    ta = threading.Thread(target=writer_a)
    tb = threading.Thread(target=writer_b)
    ta.start()
    tb.start()
    ta.join(timeout=2)
    tb.join(timeout=2)
    assert order == ["a", "b"], "writer_b must not enter the lock until writer_a releases it"


def test_different_plan_ids_do_not_block_each_other():
    results = {}

    def hold(plan_id, seconds):
        start = time.perf_counter()
        with plan_write_lock(plan_id):
            time.sleep(seconds)
        results[plan_id] = time.perf_counter() - start

    t1 = threading.Thread(target=hold, args=("p1", 0.1))
    t2 = threading.Thread(target=hold, args=("p2", 0.1))
    started = time.perf_counter()
    t1.start()
    t2.start()
    t1.join(timeout=2)
    t2.join(timeout=2)
    total = time.perf_counter() - started
    # If p1 and p2 shared a lock this would take ~0.2s serialized; unrelated
    # plans running concurrently should finish in about one hold, not two.
    assert total < 0.18, f"unrelated plan_ids should not serialize each other, took {total:.3f}s"


def test_lock_registry_does_not_grow_after_use():
    from backend import plan_locks

    with plan_write_lock("temp-plan"):
        pass
    assert "temp-plan" not in plan_locks._locks
    assert "temp-plan" not in plan_locks._refcounts


def test_reload_unchanged_or_conflict_passes_when_content_matches(monkeypatch):
    from backend import service

    monkeypatch.setattr(service.db, "get_plan", lambda user_id, plan_id: {"id": plan_id, "plan_json": {"days": []}})
    current = service._reload_unchanged_or_conflict("u1", "p1", {"days": []})
    assert current["plan_json"] == {"days": []}


def test_reload_unchanged_or_conflict_raises_when_content_changed(monkeypatch):
    from backend import service

    monkeypatch.setattr(
        service.db, "get_plan",
        lambda user_id, plan_id: {"id": plan_id, "plan_json": {"days": [{"name": "Monday", "during": "changed"}]}},
    )
    with pytest.raises(AppError) as exc_info:
        service._reload_unchanged_or_conflict("u1", "p1", {"days": [{"name": "Monday", "during": "original"}]})
    assert exc_info.value.code == "plan_changed_concurrently"
    assert exc_info.value.status == 409


def test_reload_unchanged_or_conflict_404s_if_plan_deleted_meanwhile(monkeypatch):
    from backend import service

    monkeypatch.setattr(service.db, "get_plan", lambda user_id, plan_id: None)
    with pytest.raises(AppError) as exc_info:
        service._reload_unchanged_or_conflict("u1", "p1", {"days": []})
    assert exc_info.value.code == "plan_not_found"


# ---------------------------------------------------------------------------
# Integration: persist_revised_plan (the longest stale-read window of any
# write path, since it spans a full LLM streaming call) actually detects a
# concurrent change instead of silently overwriting it.
# ---------------------------------------------------------------------------


def _stub_persist_revised_plan_deps(monkeypatch):
    from backend import retrieval, schema, service

    monkeypatch.setattr(service, "_school_for_class", lambda cls, user_id: "school1")
    monkeypatch.setattr(service, "_selected_template_id", lambda *a, **kw: "tmpl1")
    monkeypatch.setattr(service, "has_template_field", lambda *a, **kw: False)
    monkeypatch.setattr(service, "day_names_for_school", lambda *a, **kw: ["Monday"])
    monkeypatch.setattr(schema, "validate_plan", lambda plan_raw, **kw: (plan_raw, []))
    monkeypatch.setattr(service, "identity_for", lambda user_id, cls: {"teacher": "T", "course": "C", "period": "1"})
    monkeypatch.setattr(schema, "with_identity", lambda plan, **kw: plan)
    monkeypatch.setattr(retrieval, "audit_grounding", lambda *a, **kw: [])
    monkeypatch.setattr(retrieval, "cited_standards", lambda *a, **kw: [])


def test_persist_revised_plan_saves_when_nothing_changed_concurrently(monkeypatch):
    from backend import service

    _stub_persist_revised_plan_deps(monkeypatch)
    base_plan = {"week_of": "Week 1", "course": "ELA", "days": []}
    row = {"id": "p1", "week_label": "Week 1", "course": "ELA", "plan_json": base_plan, "retrieved_ids": []}

    written = {}
    monkeypatch.setattr(service.db, "get_plan", lambda user_id, plan_id: {"plan_json": base_plan})
    monkeypatch.setattr(service.db, "update_plan", lambda user_id, plan_id, **fields: written.update(fields))
    monkeypatch.setattr(service.db, "enqueue_document_build", lambda plan_id, user_id: None)
    monkeypatch.setattr(service.db, "replace_plan_standards", lambda *a, **kw: None)

    service.persist_revised_plan(
        user_id="u1", row=row, plan_raw={"week_of": "Week 1", "course": "ELA", "days": []},
        result=service.RetrievalResult(), cls=None,
    )
    assert written["plan_json"] == {"week_of": "Week 1", "course": "ELA", "days": []}


def test_persist_revised_plan_rejects_a_write_that_raced_a_concurrent_edit(monkeypatch):
    """The scenario this whole change exists for: a teacher's quick edit (or
    another AI revision) commits while a slow full-week revision's LLM call
    is still in flight. The slow write must not silently clobber it."""
    from backend import service

    _stub_persist_revised_plan_deps(monkeypatch)
    base_plan = {"week_of": "Week 1", "course": "ELA", "days": []}
    row = {"id": "p1", "week_label": "Week 1", "course": "ELA", "plan_json": base_plan, "retrieved_ids": []}

    # By the time this job finishes its LLM call, someone else's edit landed.
    changed_plan = {"week_of": "Week 1", "course": "ELA", "days": [{"name": "Monday", "during": "a teacher's edit"}]}
    monkeypatch.setattr(service.db, "get_plan", lambda user_id, plan_id: {"plan_json": changed_plan})

    write_attempted = []
    monkeypatch.setattr(service.db, "update_plan", lambda user_id, plan_id, **fields: write_attempted.append(fields))

    with pytest.raises(AppError) as exc_info:
        service.persist_revised_plan(
            user_id="u1", row=row, plan_raw={"week_of": "Week 1", "course": "ELA", "days": []},
            result=service.RetrievalResult(), cls=None,
        )
    assert exc_info.value.code == "plan_changed_concurrently"
    assert write_attempted == [], "the concurrent edit must not be overwritten"
