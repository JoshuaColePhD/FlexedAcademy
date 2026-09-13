"""Regression tests for the generation setup phase: no duplicate class-row
fetches, and independent DB lookups run concurrently rather than stacking.

The bug this guards against: generate_plan/stream_plan (and rewrite_day/
rewrite_day_field) each called db.get_class up to three times per invocation
-- once directly for period_minutes, again inside _prompt_subject_grade, and
again inside class_custom_instructions_for -- for the SAME user_id/class_id,
on every single lesson-plan generation and revision. Fixed by fetching the
class row once and threading it through; verified here by counting calls to
a stubbed db.get_class rather than trusting the code to still do the right
thing after a future edit.
"""
from __future__ import annotations

import json

from backend import llm
from backend.retrieval import RetrievalResult


def test_prompt_subject_grade_skips_lookup_when_cls_given(monkeypatch):
    calls = []
    monkeypatch.setattr(llm.db, "get_class", lambda *a, **kw: calls.append(1) or {"subject": "Math", "grade": "9"})

    subject, grade = llm._prompt_subject_grade("u1", "c1", cls={"subject": "ELA", "grade": "10"})

    assert (subject, grade) == ("ELA", "10")
    assert calls == [], "a pre-fetched cls must not trigger another db.get_class call"


def test_class_period_minutes_skips_lookup_when_cls_given(monkeypatch):
    calls = []
    monkeypatch.setattr(llm.db, "get_class", lambda *a, **kw: calls.append(1) or {"period_minutes": 50})

    minutes = llm._class_period_minutes("u1", "c1", cls={"period_minutes": 42})

    assert minutes == 42
    assert calls == []


def test_class_custom_instructions_skips_lookup_when_cls_given(monkeypatch):
    calls = []
    monkeypatch.setattr(llm.db, "get_class", lambda *a, **kw: calls.append(1) or {"custom_instructions": "wrong"})

    text = llm.class_custom_instructions_for("u1", "c1", cls={"custom_instructions": "right"})

    assert text == "right"
    assert calls == []


def _stub_fake_completion_stream(monkeypatch, *, subject="ELA", grade="9"):
    """Stubs everything downstream of the setup phase so stream_plan/
    generate_plan run for real but never touch the network."""
    monkeypatch.setattr(llm, "day_names_for_school", lambda *a, **kw: ["Monday"])
    monkeypatch.setattr(llm, "map_context_for", lambda *a, **kw: "")
    monkeypatch.setattr(llm, "custom_instructions_for", lambda *a, **kw: None)
    monkeypatch.setattr(llm.db, "get_settings_row", lambda *a, **kw: {"subject": subject, "grade": grade})
    monkeypatch.setattr(llm.db, "get_user_by_id", lambda *a, **kw: {"output_length": "medium"})


def test_stream_plan_fetches_the_class_row_exactly_once(monkeypatch):
    calls = []
    monkeypatch.setattr(llm.db, "get_class", lambda *a, **kw: calls.append(1) or {"subject": "ELA", "grade": "9", "period_minutes": 45})
    _stub_fake_completion_stream(monkeypatch)

    class _FakeStream:
        def __iter__(self):
            return iter(())

        def close(self):
            pass

    class _FakeCompletions:
        def create(self, **kwargs):
            return _FakeStream()

    class _FakeClient:
        chat = type("Chat", (), {"completions": _FakeCompletions()})()

    monkeypatch.setattr(llm, "client", lambda: _FakeClient())

    list(llm.stream_plan("u1", "Build week 1", RetrievalResult(), school_id="s1", class_id="c1"))

    assert calls == [1], f"expected exactly one db.get_class call, got {len(calls)}"


def test_generate_plan_fetches_the_class_row_exactly_once(monkeypatch):
    calls = []
    monkeypatch.setattr(llm.db, "get_class", lambda *a, **kw: calls.append(1) or {"subject": "ELA", "grade": "9", "period_minutes": 45})
    _stub_fake_completion_stream(monkeypatch)
    monkeypatch.setattr(
        llm,
        "_cached_completion",
        lambda *a, **kw: json.dumps({"days": []}),
    )

    llm.generate_plan("u1", "Build week 1", RetrievalResult(), school_id="s1", class_id="c1")

    assert calls == [1], f"expected exactly one db.get_class call, got {len(calls)}"


def test_stream_plan_with_no_class_never_calls_get_class(monkeypatch):
    calls = []
    monkeypatch.setattr(llm.db, "get_class", lambda *a, **kw: calls.append(1))
    _stub_fake_completion_stream(monkeypatch)

    class _FakeStream:
        def __iter__(self):
            return iter(())

        def close(self):
            pass

    class _FakeCompletions:
        def create(self, **kwargs):
            return _FakeStream()

    class _FakeClient:
        chat = type("Chat", (), {"completions": _FakeCompletions()})()

    monkeypatch.setattr(llm, "client", lambda: _FakeClient())

    list(llm.stream_plan("u1", "Build week 1", RetrievalResult(), school_id="s1", class_id=None))

    assert calls == []
