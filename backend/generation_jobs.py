"""Lesson workers with durable request identities and completion recovery.

iOS Safari drops the SSE fetch when the teacher locks the phone or switches
apps. The week still has to finish and save. A job is keyed by
(user_id, request_id): the first POST starts a worker; later POSTs with the
same id attach and replay, including after the phone wakes up.
Postgres retains terminal results across restarts; an unfinished expired run is
reconciled with its deterministic saved-plan ID or requires an explicit retry.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections.abc import Callable, Iterator

from . import chat_metrics, db, generation_store
from .errors import AppError

log = logging.getLogger(__name__)

_JOB_TTL_SECONDS = 30 * 60

_lock = threading.Lock()
_jobs: dict[tuple[str, str], GenerationJob] = {}


class CancellationToken(threading.Event):
    """Explicit Stop closes active provider streams, including a blocked read."""
    def __init__(self):
        super().__init__()
        self._callbacks = set()
        self._callbacks_lock = threading.Lock()

    def add_callback(self, callback):
        with self._callbacks_lock:
            self._callbacks.add(callback)
            cancelled = self.is_set()
        if cancelled:
            callback()

    def remove_callback(self, callback):
        with self._callbacks_lock:
            self._callbacks.discard(callback)

    def set(self):
        super().set()
        with self._callbacks_lock:
            callbacks = tuple(self._callbacks)
        for callback in callbacks:
            try:
                callback()
            except Exception:
                log.debug("provider cancellation cleanup failed", exc_info=True)


class GenerationJob:
    def __init__(self, user_id: str, request_id: str, *, fingerprint: str = "", owner_token: str | None = None):
        self.user_id = user_id
        self.request_id = request_id
        self.events: list[str] = []
        self.cond = threading.Condition()
        self.finished = False
        self.cancelled = CancellationToken()
        self.fingerprint = fingerprint
        self.owner_token = owner_token
        self.plan_id = generation_store.plan_id(user_id, request_id)
        self.remote = False
        self.defer_completion = False
        self.pending_completion = None
        self.status = "running"
        self.result: dict | None = None
        self.error: dict | None = None
        self.created_at = time.monotonic()
        self.lease = None

    def publish(self, sse_text: str) -> None:
        with self.cond:
            self.events.append(sse_text)
            self.cond.notify_all()

    def complete(self, *, result: dict | None = None, error: dict | None = None, cancelled: bool = False) -> None:
        if self.defer_completion:
            self.pending_completion = {"result": result, "error": error, "cancelled": cancelled}
            return
        with self.cond:
            if self.finished:
                return
            if cancelled:
                self.status = "cancelled"
            elif error is not None:
                self.status = "error"
                self.error = error
            else:
                self.status = "done"
                self.result = result
            self.finished = True
            self.cond.notify_all()
        if self.owner_token:
            try:
                generation_store.finish(self.user_id, self.request_id, self.owner_token, self.status, self.result, self.error)
            except Exception:
                # The deterministic plan ID supports reconciliation after a
                # transient ledger outage; never discard a successfully saved week.
                log.exception("could not persist generation completion request=%s", self.request_id)

        chat_metrics.record(self.user_id, kind="plan",
            outcome={"done": "saved", "error": "failed", "cancelled": "cancelled"}[self.status],
            duration_ms=(time.monotonic() - self.created_at) * 1000)

    def refresh(self):
        if not self.remote:
            return
        row = generation_store.load(self.user_id, self.request_id)
        if row:
            self.status = row["status"]
            self.result = row.get("result_json")
            self.error = row.get("error_json")
            self.finished = self.status in {"done", "error", "cancelled"}

    def snapshot(self) -> dict:
        self.refresh()
        with self.cond:
            return {
                "request_id": self.request_id,
                "status": self.status,
                "result": self.result,
                "error": self.error,
            }

    def follow(self) -> Iterator[str]:
        if self.remote:
            while True:
                self.refresh()
                if self.finished:
                    payload = self.result or {"error": self.error or {"code": "generation_cancelled", "message": "Generation stopped."}}
                    yield "data: " + json.dumps({**payload, "request_id": self.request_id}) + "\n\n"
                    return
                yield ": keepalive\n\n"
                # A set cancellation Event returns immediately from wait();
                # polling it here would hammer Postgres until the owner exits.
                with self.cond:
                    self.cond.wait(timeout=2.0)
        idx = 0
        while True:
            with self.cond:
                while idx >= len(self.events) and not self.finished:
                    notified = self.cond.wait(timeout=10.0)
                    if not notified:
                        break
                batch = self.events[idx:]
                idx = len(self.events)
                done = self.finished and idx >= len(self.events)
                keepalive = not batch and not self.finished
            yield from batch
            if done:
                return
            if keepalive:
                yield ": keepalive\n\n"


def start_or_attach(
    user_id: str,
    request_id: str,
    worker: Callable[[GenerationJob], None],
    *, fingerprint: str = "",
) -> GenerationJob:
    """Return the live job for this request, starting a worker if needed.

    A finished success is replayed. A still-running job is attached. An
    error/cancelled job is replaced so Try again can start fresh work.
    """
    _prune()
    key = (user_id, request_id)
    with _lock:
        existing = _jobs.get(key)
        if existing and existing.status in {"running", "done"}:
            if existing.fingerprint != fingerprint:
                raise AppError("request_conflict", "This request ID already belongs to different content.", status=409)
            return existing
        owner_token = uuid.uuid4().hex if generation_store.enabled() else None
        job = GenerationJob(user_id, request_id, fingerprint=fingerprint, owner_token=owner_token)
        if owner_token:
            _row, owned = generation_store.claim(user_id, request_id, fingerprint, owner_token)
            if not owned:
                job.owner_token = None
                job.remote = True
                job.refresh()
                _jobs[key] = job
                return job
        _jobs[key] = job
        threading.Thread(
            target=_run_worker,
            args=(job, worker),
            name=f"generate-{request_id[:8]}",
            daemon=True,
        ).start()
        return job


def _run_worker(job: GenerationJob, worker) -> None:
    stopped = threading.Event()
    job.defer_completion = True

    def renew():
        while not stopped.wait(timeout=15):
            try:
                if generation_store.heartbeat(job.user_id, job.request_id, job.owner_token):
                    job.cancelled.set()
                    return
            except Exception:
                log.exception("generation lease renewal failed request=%s", job.request_id)

    if job.owner_token:
        threading.Thread(target=renew, name="generation-lease", daemon=True).start()
    try:
        with db.as_user(job.user_id):
            worker(job)
    except Exception:
        log.exception("generation worker failed request=%s", job.request_id)
        error = {"code": "generation_failed", "message": "The request could not finish.", "retryable": True}
        job.publish("data: " + json.dumps({"error": error, "request_id": job.request_id}) + "\n\n")
        job.complete(error=error)
    finally:
        stopped.set()
        if job.lease is not None:
            job.lease.release()
            job.lease = None
        job.defer_completion = False
        if job.pending_completion:
            completion = job.pending_completion
            if job.cancelled.is_set() and not completion.get("result"):
                completion = {"cancelled": True}
            job.complete(**completion)
        if not job.finished:
            job.complete(cancelled=job.cancelled.is_set(), error=None if job.cancelled.is_set() else {"code": "generation_interrupted", "message": "The request ended before completion.", "retryable": True})


def get_job(user_id: str, request_id: str) -> GenerationJob | None:
    _prune()
    with _lock:
        job = _jobs.get((user_id, request_id))
        if job is None and generation_store.enabled():
            row = generation_store.load(user_id, request_id)
            if row:
                job = GenerationJob(user_id, request_id, fingerprint=row["fingerprint"])
                job.remote = True
                job.refresh()
                _jobs[(user_id, request_id)] = job
        if job is not None:
            job.refresh()
        return job


def cancel_job(user_id: str, request_id: str) -> bool:
    job = get_job(user_id, request_id)
    if job is None:
        return False
    job.cancelled.set()
    if generation_store.enabled():
        generation_store.request_cancel(user_id, request_id)
    # The worker releases capacity after its upstream work actually terminates.
    # A queued lease can be cancelled immediately because it owns no capacity.
    if job.lease is not None and not getattr(job.lease, "acquired", True):
        job.lease.cancel()
    return True


def _prune() -> None:
    now = time.monotonic()
    with _lock:
        stale = [
            key
            for key, job in _jobs.items()
            if job.finished and (now - job.created_at) > _JOB_TTL_SECONDS
        ]
        for key in stale:
            _jobs.pop(key, None)
