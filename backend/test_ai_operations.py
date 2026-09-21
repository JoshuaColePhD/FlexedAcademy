"""No-network regressions for paid-call cancellation, accounting, and citations."""
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from types import SimpleNamespace as N

import pytest

from backend import generation_jobs, generation_store, llm, retrieval, service, teaching
from backend.routes import generate, standards
from backend.worker_context import run_as_user


def test_standard_simplification_accepts_cached_text(monkeypatch):
    monkeypatch.setattr(llm, "_cached_completion", lambda *a, **kw: " I can explain a claim. ")
    assert llm.deconstruct_standard("owner", "1.A", "Explain a claim") == "I can explain a claim."


def test_provenance_uses_the_saved_revision_without_refetch(monkeypatch):
    captured = []
    monkeypatch.setattr(teaching, "record_provenance", lambda *a, **kw: captured.append(kw["revision"]))
    monkeypatch.setattr(service.db, "get_plan", lambda *a: pytest.fail("Provenance must not infer a revision from a later read"))
    service._record_plan_provenance("owner", {"id": "plan", "revision": 7}, N(chunks=[]))
    assert captured == [7]


def test_deconstruct_uses_flattened_source_and_checks_entitlement(monkeypatch):
    captured = []
    monkeypatch.setattr(retrieval, "chunk_for_code", lambda *a, **kw: {"code": "1.A", "description": "Source wording"})
    monkeypatch.setattr(standards, "require_entitlement", lambda owner: captured.append(owner))
    monkeypatch.setattr(standards.generation_queue, "slot", lambda owner: nullcontext())
    monkeypatch.setattr(llm, "deconstruct_standard", lambda owner, code, text: captured.append(text) or "I can explain.")
    result = standards.deconstruct_standard.__wrapped__("1.A", request=None, subject="AP_Lang", state="AL", user_id="owner")
    assert result == {"simplified": "I can explain."}
    assert captured == ["owner", "Source wording"]


def test_tool_completion_drains_final_usage(monkeypatch):
    arguments = json.dumps({"questions": [{"question": "Which text?", "options": ["A", "B"]}]})
    call = N(index=0, function=N(name="ask_clarifying_questions", arguments=arguments))
    items = [N(usage=None, choices=[N(finish_reason="tool_calls", delta=N(content=None, tool_calls=[call]))]),
             N(usage=N(prompt_tokens=900, completion_tokens=90), choices=[])]

    class Stream:
        def __iter__(self):
            return iter(items)

        def close(self):
            pass

    recorded = []
    monkeypatch.setattr(llm, "client", lambda: N(chat=N(completions=N(create=lambda **kw: Stream()))))
    monkeypatch.setattr(llm, "beta_features_for", lambda _: False)
    monkeypatch.setattr(llm, "_chat_tools_for", lambda *a, **kw: [{}])
    monkeypatch.setattr(llm, "output_length_tokens_for", lambda _: 100)
    monkeypatch.setattr(llm, "_record", lambda owner, kind, usage, **kw: recorded.append(usage.prompt_tokens))
    events = list(llm.stream_chat("owner", []))
    assert sum("tool_call" in event for event in events) == 1
    assert recorded == [900]


def test_explicit_stop_closes_producer_before_return(monkeypatch):
    token = generation_jobs.CancellationToken()
    release = threading.Event()
    finished = threading.Event()
    token.add_callback(release.set)

    def upstream():
        try:
            yield "first"
            release.wait(timeout=1)
            yield "after-stop"
        finally:
            finished.set()

    stream = generate._with_keepalives(upstream(), cancellation=token)
    assert next(stream) == "first"
    token.set()
    stream.close()
    assert finished.is_set()


def test_keepalive_thread_retains_owner_identity():
    def source():
        yield service.db.current_user_id.get()

    with service.db.as_user("thread-owner"):
        assert list(generate._with_keepalives(source())) == ["thread-owner"]
    assert service.db.current_user_id.get() is None


def test_pool_worker_identity_is_scoped_and_reset():
    with ThreadPoolExecutor(max_workers=1) as pool:
        assert pool.submit(run_as_user, "pool-owner", service.db.current_user_id.get).result() == "pool-owner"
        assert pool.submit(service.db.current_user_id.get).result() is None


def test_stop_during_save_preserves_committed_result():
    token = generation_jobs.CancellationToken()
    finished = threading.Event()

    def save():
        token.set()
        try:
            yield {"plan_id": "saved-week"}
        finally:
            finished.set()

    assert list(generate._with_keepalives(save(), cancellation=token, honor_cancellation=False)) == [{"plan_id": "saved-week"}]
    assert finished.is_set()


def test_cancel_keeps_lease_until_worker_exits(monkeypatch):
    monkeypatch.setattr(generation_store, "enabled", lambda: False)
    started, finish = threading.Event(), threading.Event()
    released = []

    class Lease:
        acquired = True

        def release(self):
            released.append(True)

    def worker(job):
        job.lease = Lease()
        started.set()
        finish.wait(timeout=2)

    job = generation_jobs.start_or_attach("stop-owner", "stop-lease", worker)
    assert started.wait(timeout=1)
    generation_jobs.cancel_job(job.user_id, job.request_id)
    assert released == []
    assert not job.finished
    finish.set()
    with job.cond:
        job.cond.wait_for(lambda: job.finished, timeout=2)
    assert released == [True]
    assert job.status == "cancelled"


def test_request_fingerprint_rejects_reuse_for_different_content(monkeypatch):
    monkeypatch.setattr(generation_store, "enabled", lambda: False)
    job = generation_jobs.start_or_attach("fingerprint-owner", "req", lambda job: job.complete(result={"done": True}), fingerprint="first")
    with job.cond:
        job.cond.wait_for(lambda: job.finished, timeout=1)
    with pytest.raises(Exception, match="different content"):
        generation_jobs.start_or_attach("fingerprint-owner", "req", lambda job: None, fingerprint="different")
    assert generation_store.fingerprint({"query": "topic", "attempt": 0}) == generation_store.fingerprint({"query": "topic", "attempt": 2})


def test_standards_batch_is_one_scoped_database_query(monkeypatch):
    monkeypatch.setattr(retrieval.settings, "database_url", "test-only")
    monkeypatch.setattr(retrieval, "is_ap_course", lambda _: False)
    monkeypatch.setattr(retrieval, "course_variants", lambda _: ("Math",))
    calls = []

    def rows(sql, params):
        calls.append((sql, params))
        return [{"id": "math-one", "metadata": {"code": "1", "course": "Math", "state": "AL"}}]

    monkeypatch.setattr(retrieval.db, "_rows", rows)
    result = retrieval.chunks_for_codes(["1", "2"], "Math", "AL")
    assert result["1"]["course"] == "Math"
    assert result["2"] is None
    assert len(calls) == 1
    assert "Math" in calls[0][1][2]
