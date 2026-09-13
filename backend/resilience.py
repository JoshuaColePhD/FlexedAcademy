"""Process-local self-healing: a circuit breaker for the OpenAI dependency.

No new infrastructure, no external service, no persisted history — this is
the cheap half of "detect problems and recover automatically" that doesn't
require Sentry or a dedicated on-call team, matching the rest of this app's
per-process, no-extra-moving-parts approach (see db.py's own connection pool
for the same design instinct).

Without this, every request during an OpenAI outage or rate-limit storm
waits out its own full timeout before failing — the app looks equally slow
and broken to every concurrent teacher for as long as the outage lasts.
With it, the FIRST few failures still wait out their timeout (that's how the
breaker learns something is wrong), but every failure after the threshold
fails immediately instead of queueing behind a timeout that is very likely
to fail too. The breaker re-tests automatically after a cooldown and closes
itself the moment OpenAI is healthy again — nobody has to notice and flip
anything back on.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

log = logging.getLogger("flexedacademy.resilience")


@dataclass
class CircuitBreakerStatus:
    name: str
    state: str  # "closed" | "open" | "half_open"
    consecutive_failures: int
    seconds_since_opened: float | None
    last_error: str | None


class CircuitBreaker:
    """Closed (normal) -> `failure_threshold` consecutive failures -> Open
    (fail fast, no call attempted) -> `reset_after_s` elapsed -> Half-open
    (let exactly one probe call through) -> success closes it, failure
    reopens it and restarts the cooldown.

    Thread-safe: this app runs the generation queue, the document-build
    worker, and ordinary request handlers as concurrent threads, all of
    which may call through the same breaker.
    """

    def __init__(self, name: str, *, failure_threshold: int = 4, reset_after_s: float = 30.0):
        self.name = name
        self._failure_threshold = failure_threshold
        self._reset_after_s = reset_after_s
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._opened_at: float | None = None  # time.monotonic(), for interval math only
        self._probe_in_flight = False
        self._last_error: str | None = None

    def _state_locked(self) -> str:
        if self._opened_at is None:
            return "closed"
        if time.monotonic() - self._opened_at >= self._reset_after_s:
            return "half_open"
        return "open"

    def call(self, fn, *, trips_on: tuple[type[BaseException], ...]):
        """Run fn(). Raises AppError immediately, without calling fn, while
        the breaker is open or while another thread's half-open probe is
        already in flight — letting every waiting caller pile onto a
        dependency that's still probably down helps nobody. Exceptions in
        `trips_on` count as a failure; anything else (a bad request, an
        auth error — a bug, not an outage) passes through without tripping
        the breaker, since opening it would hide a config problem behind an
        unrelated "service unavailable" message instead of surfacing it."""
        from .errors import AppError

        with self._lock:
            state = self._state_locked()
            if state == "open" or (state == "half_open" and self._probe_in_flight):
                raise AppError(
                    "openai_unavailable",
                    "The AI service is temporarily unavailable after repeated errors.",
                    status=503,
                    hint="This usually clears in under a minute — try again shortly.",
                )
            if state == "half_open":
                self._probe_in_flight = True

        try:
            result = fn()
        except trips_on as exc:
            with self._lock:
                self._consecutive_failures += 1
                self._last_error = f"{type(exc).__name__}: {exc}"[:300]
                self._probe_in_flight = False
                if self._opened_at is not None or self._consecutive_failures >= self._failure_threshold:
                    if self._opened_at is None:
                        log.error(
                            "circuit breaker '%s' OPENED after %d consecutive failures (%s)",
                            self.name, self._consecutive_failures, self._last_error,
                        )
                    else:
                        log.warning("circuit breaker '%s' probe failed, reopening (%s)", self.name, self._last_error)
                    self._opened_at = time.monotonic()
            raise
        else:
            with self._lock:
                if self._opened_at is not None:
                    log.info("circuit breaker '%s' RECOVERED", self.name)
                self._consecutive_failures = 0
                self._opened_at = None
                self._probe_in_flight = False
            return result

    def status(self) -> CircuitBreakerStatus:
        with self._lock:
            state = self._state_locked()
            elapsed = None if self._opened_at is None else round(time.monotonic() - self._opened_at, 1)
            return CircuitBreakerStatus(
                name=self.name,
                state=state,
                consecutive_failures=self._consecutive_failures,
                seconds_since_opened=elapsed,
                last_error=self._last_error,
            )
