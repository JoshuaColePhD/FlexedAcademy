"""Per-request memoization of DB rows that generate.py/service.py/llm.py
each currently re-fetch independently.

Constructed once per /generate_stream call (see routes/generate.py's
generate_stream), threaded explicitly through _run_plan_job -> service.prepare
-> service.finalize -> llm.stream_plan, and discarded when the request ends.

Deliberately NOT a module-level cache or an lru_cache-backed function: this
must never leak between concurrent requests or threads, and must never
survive a class edit between two requests. Every method here does exactly
one thing beyond the plain db.* call it wraps: remember the answer for the
life of THIS instance.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from . import db


@dataclass
class RequestContext:
    user_id: str
    class_id: str | None = None
    # The chat/request's own class, when the caller already fetched it (see
    # routes/generate.py's _request_class) — seeded in rather than re-fetched.
    cls: dict | None = None

    _school_id: str | None = field(default=None, init=False, repr=False)
    _school_id_resolved: bool = field(default=False, init=False, repr=False)
    _settings_rows: dict = field(default_factory=dict, init=False, repr=False)
    _user: dict | None = field(default=None, init=False, repr=False)
    _user_resolved: bool = field(default=False, init=False, repr=False)

    def school_id(self) -> str:
        """Which calendar this request's class follows (db.class_school),
        memoized for the life of this context."""
        if not self._school_id_resolved:
            self._school_id = db.class_school(self.cls, self.user_id)
            self._school_id_resolved = True
        return self._school_id  # type: ignore[return-value]

    def settings_row(self, subject: str | None = None) -> dict:
        """db.get_settings_row(user_id, subject), memoized per subject key —
        a request can legitimately ask for more than one subject's row (the
        class's own subject, and the account default with subject=None), so
        this caches each key it's asked for rather than just the first."""
        if subject not in self._settings_rows:
            self._settings_rows[subject] = db.get_settings_row(self.user_id, subject=subject)
        return self._settings_rows[subject]

    def user_row(self) -> dict | None:
        """db.get_user_by_id(user_id), memoized."""
        if not self._user_resolved:
            self._user = db.get_user_by_id(self.user_id)
            self._user_resolved = True
        return self._user
