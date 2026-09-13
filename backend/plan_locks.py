"""Per-plan mutual exclusion for writes to a lesson plan's stored content.

The gap this closes: every plan-mutating path (an AI revision, the standard
picker's set_day_field, a manual cell edit, undo) reads plans.plan_json,
computes a new value -- sometimes across a many-second LLM call -- and then
overwrites the row unconditionally (`UPDATE plans SET plan_json = ? WHERE id
= ? AND user_id = ?`, no version/timestamp check). generation_queue already
stops the SAME user from running two AI revisions on ANY plan at once, but
nothing stops a fast, unqueued write (set_day_field, edit_day_field, undo)
from landing in the middle of a slow queued revision's read-...-write
window on the SAME plan, or two different users revising a plan shared
between them. Whichever write commits last silently wins and the other is
gone -- no error, no merge, no trace.

Fixing this properly (a version/updated_at column, compare-and-swap on
write) needs a schema migration. This is the fix that needs none: serialize
every write to a given plan_id through one lock, and have the slow,
LLM-call paths re-read the row fresh and compare against the snapshot their
prompt was built from, immediately before writing, while holding that lock
-- so a genuine conflict is DETECTED and surfaced as a clear "reload and
retry" error instead of silently discarded.

Reference-counted rather than a bare dict of locks so entries for plans
nobody is actively writing to don't accumulate for the life of the process
-- the same instinct as db.py's own bounded connection pool, just applied
to a different resource.
"""
from __future__ import annotations

import threading
from collections import defaultdict
from collections.abc import Iterator
from contextlib import contextmanager

_registry_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}
_refcounts: dict[str, int] = defaultdict(int)


@contextmanager
def plan_write_lock(plan_id: str) -> Iterator[None]:
    """Held only around the actual read-compare-write of one plan's content,
    never around an LLM call -- an unrelated plan's revision must never wait
    on this plan's model response."""
    with _registry_guard:
        lock = _locks.setdefault(plan_id, threading.Lock())
        _refcounts[plan_id] += 1
    try:
        with lock:
            yield
    finally:
        with _registry_guard:
            _refcounts[plan_id] -= 1
            if _refcounts[plan_id] <= 0:
                _refcounts.pop(plan_id, None)
                _locks.pop(plan_id, None)
