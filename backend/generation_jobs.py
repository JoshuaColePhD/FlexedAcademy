"""In-process lesson-generation jobs that outlive the browser connection.

iOS Safari drops the SSE fetch when the teacher locks the phone or switches
apps. The week still has to finish and save. A job is keyed by
(user_id, request_id): the first POST starts a worker; later POSTs with the
same id attach and replay, including after the phone wakes up.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator

_JOB_TTL_SECONDS = 30 * 60

_lock = threading.Lock()
_jobs: dict[tuple[str, str], GenerationJob] = {}


class GenerationJob:
    def __init__(self, user_id: str, request_id: str):
        self.user_id = user_id
        self.request_id = request_id
        self.events: list[str] = []
        self.cond = threading.Condition()
        self.finished = False
        self.cancelled = threading.Event()
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

    def snapshot(self) -> dict:
        with self.cond:
            return {
                "request_id": self.request_id,
                "status": self.status,
                "result": self.result,
                "error": self.error,
            }

    def follow(self) -> Iterator[str]:
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
            return existing
        job = GenerationJob(user_id, request_id)
        _jobs[key] = job
        threading.Thread(
            target=worker,
            args=(job,),
            name=f"generate-{request_id[:8]}",
            daemon=True,
        ).start()
        return job


def get_job(user_id: str, request_id: str) -> GenerationJob | None:
    _prune()
    with _lock:
        job = _jobs.get((user_id, request_id))
        if job is None or job.user_id != user_id:
            return None
        return job


def cancel_job(user_id: str, request_id: str) -> bool:
    job = get_job(user_id, request_id)
    if job is None:
        return False
    job.cancelled.set()
    lease = job.lease
    job.lease = None
    if lease is not None:
        # Free the one-at-a-time slot so Stop then Try again is not stuck
        # behind prepare() still running on the cancelled worker.
        lease.release()
    job.complete(cancelled=True)
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
