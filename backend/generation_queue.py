"""Small in-process queue for model-generating work.

The weekly token entitlement is the durable spend ceiling.  This queue is the
short-term backpressure layer: a teacher can submit a burst of requests, but
only a bounded number run at once and each teacher's requests run in order.

This intentionally lives in the app process rather than adding another broker.
Render currently runs one web process for this service.  If the service is
scaled horizontally later, the same policy should move to a shared queue (or a
database-backed job table) so each process does not have its own capacity view.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from threading import Condition
from time import monotonic
from typing import Self

from .config import settings
from .errors import AppError


@dataclass
class _Ticket:
    user_id: str
    enqueued_at: float
    acquired: bool = False
    cancelled: bool = False


class GenerationLease:
    """A queued request's claim on one generation slot."""

    def __init__(self, queue: GenerationQueue, ticket: _Ticket):
        self._queue = queue
        self._ticket = ticket
        self._released = False

    @property
    def acquired(self) -> bool:
        return self._ticket.acquired

    @property
    def cancelled(self) -> bool:
        return self._ticket.cancelled

    @property
    def position(self) -> int:
        return self._queue.position(self._ticket)

    def wait(self, timeout: float | None = None) -> bool:
        """Wait until this ticket owns a slot.

        A finite timeout is useful for SSE streams: the caller can emit a
        heartbeat while it remains queued, preventing an otherwise healthy
        connection from looking idle to a proxy.
        """
        try:
            return self._queue.wait(self._ticket, timeout=timeout)
        except BaseException:
            # A client can disconnect while a sync SSE iterator is asleep in
            # the queue. Remove its ticket immediately so it cannot consume a
            # future slot after the browser has gone away.
            self.cancel()
            raise

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._queue.release(self._ticket)

    def cancel(self) -> None:
        self._queue.cancel(self._ticket)

    def __enter__(self) -> Self:
        try:
            self.wait()
        except Exception:
            self.cancel()
            raise
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.release()


class GenerationQueue:
    def __init__(
        self,
        *,
        max_concurrent: int,
        max_per_user: int,
        max_queue: int,
        max_queue_per_user: int,
        min_start_interval: float,
    ):
        self.max_concurrent = max(1, int(max_concurrent))
        self.max_per_user = max(1, int(max_per_user))
        self.max_queue = max(1, int(max_queue))
        self.max_queue_per_user = max(1, int(max_queue_per_user))
        self.min_start_interval = max(0.0, float(min_start_interval))
        self._condition = Condition()
        self._waiters: deque[_Ticket] = deque()
        self._active = 0
        self._active_by_user: dict[str, int] = {}
        self._last_started: dict[str, float] = {}
        self._last_started_user: str | None = None

    def enqueue(self, user_id: str) -> GenerationLease:
        with self._condition:
            queued_total = len(self._waiters)
            queued_for_user = sum(ticket.user_id == user_id for ticket in self._waiters)
            if queued_total >= self.max_queue:
                raise AppError(
                    "generation_queue_full",
                    "The generation queue is temporarily full.",
                    status=503,
                    hint="Your request was not started. Please try again in a moment.",
                    extra={"retryable": True, "retry_after_seconds": 5},
                )
            if queued_for_user >= self.max_queue_per_user:
                raise AppError(
                    "generation_queue_busy",
                    "You already have several requests queued.",
                    status=429,
                    hint="Let the current requests finish, then try again.",
                    extra={"retryable": True, "retry_after_seconds": 3},
                )
            ticket = _Ticket(user_id=user_id, enqueued_at=monotonic())
            self._waiters.append(ticket)
            self._condition.notify_all()
            return GenerationLease(self, ticket)

    def slot(self, user_id: str) -> GenerationLease:
        """Compatibility-friendly context-manager entry point."""
        return self.enqueue(user_id)

    def position(self, ticket: _Ticket) -> int:
        with self._condition:
            if ticket.acquired:
                return 0
            try:
                return list(self._waiters).index(ticket) + 1
            except ValueError:
                return 0

    def _next_eligible(self, now: float) -> _Ticket | None:
        if self._active >= self.max_concurrent:
            return None
        eligible: list[_Ticket] = []
        for ticket in self._waiters:
            if ticket.cancelled:
                continue
            if self._active_by_user.get(ticket.user_id, 0) >= self.max_per_user:
                continue
            last = self._last_started.get(ticket.user_id)
            if last is not None and now < last + self.min_start_interval:
                continue
            eligible.append(ticket)
        if not eligible:
            return None
        # Round-robin between users when possible. A teacher's own requests
        # stay ordered, but a six-request burst cannot starve the next teacher
        # who is waiting behind it.
        if self._last_started_user is not None:
            for ticket in eligible:
                if ticket.user_id != self._last_started_user:
                    return ticket
        return eligible[0]

    def _next_wakeup(self, now: float) -> float | None:
        wake_at: float | None = None
        for ticket in self._waiters:
            if ticket.cancelled or self._active_by_user.get(ticket.user_id, 0) >= self.max_per_user:
                continue
            last = self._last_started.get(ticket.user_id)
            if last is None:
                continue
            candidate = last + self.min_start_interval
            if candidate > now and (wake_at is None or candidate < wake_at):
                wake_at = candidate
        return wake_at

    def wait(self, ticket: _Ticket, *, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else monotonic() + max(0.0, timeout)
        with self._condition:
            while not ticket.acquired:
                if ticket.cancelled:
                    return False
                now = monotonic()
                eligible = self._next_eligible(now)
                if eligible is ticket:
                    self._waiters.remove(ticket)
                    self._active += 1
                    self._active_by_user[ticket.user_id] = self._active_by_user.get(ticket.user_id, 0) + 1
                    self._last_started[ticket.user_id] = now
                    self._last_started_user = ticket.user_id
                    ticket.acquired = True
                    return True

                remaining = None if deadline is None else deadline - now
                if remaining is not None and remaining <= 0:
                    return False
                wake_at = self._next_wakeup(now)
                if wake_at is not None:
                    interval = wake_at - now
                    remaining = interval if remaining is None else min(remaining, interval)
                self._condition.wait(timeout=remaining)
        return ticket.acquired

    def release(self, ticket: _Ticket) -> None:
        with self._condition:
            if not ticket.acquired:
                ticket.cancelled = True
                try:
                    self._waiters.remove(ticket)
                except ValueError:
                    pass
                self._condition.notify_all()
                return
            ticket.acquired = False
            self._active = max(0, self._active - 1)
            active_for_user = self._active_by_user.get(ticket.user_id, 0) - 1
            if active_for_user > 0:
                self._active_by_user[ticket.user_id] = active_for_user
            else:
                self._active_by_user.pop(ticket.user_id, None)
            self._condition.notify_all()

    def cancel(self, ticket: _Ticket) -> None:
        with self._condition:
            if ticket.acquired:
                ticket.acquired = False
                self._active = max(0, self._active - 1)
                active_for_user = self._active_by_user.get(ticket.user_id, 0) - 1
                if active_for_user > 0:
                    self._active_by_user[ticket.user_id] = active_for_user
                else:
                    self._active_by_user.pop(ticket.user_id, None)
                ticket.cancelled = True
                self._condition.notify_all()
                return
            ticket.cancelled = True
            try:
                self._waiters.remove(ticket)
            except ValueError:
                pass
            self._condition.notify_all()


generation_queue = GenerationQueue(
    max_concurrent=settings.generation_max_concurrent,
    max_per_user=settings.generation_max_per_user,
    max_queue=settings.generation_max_queue,
    max_queue_per_user=settings.generation_max_queue_per_user,
    min_start_interval=settings.generation_min_start_interval_seconds,
)
