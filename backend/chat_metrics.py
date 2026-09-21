"""Content-free outcome measurements. Reporting must never fail a teacher's work."""
from __future__ import annotations

import logging
import time
import uuid
from functools import wraps

from . import db

log = logging.getLogger(__name__)


def record(user_id, *, kind, channel="typed", outcome, duration_ms, first_response_ms=None,
           stt_ms=None, llm_ms=None, speech_ms=None, client_reported=False):
    if not db.settings.database_url:
        return
    try:
        with db.as_user(user_id):
            db._write("""INSERT INTO chat_metrics
                (id,user_id,kind,channel,outcome,duration_ms,first_response_ms,stt_ms,llm_ms,speech_ms,client_reported)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (uuid.uuid4().hex, user_id, kind, channel, outcome, max(0, int(duration_ms)),
                 first_response_ms, stt_ms, llm_ms, speech_ms, client_reported))
    except Exception:  # noqa: BLE001 - optional telemetry must not break a successful turn
        log.warning("Chat outcome metric could not be saved")


def measured(kind):
    """Successful service return means a persisted artifact, not a tool request."""
    def decorate(fn):
        @wraps(fn)
        def run(user_id, *args, **kwargs):
            started = time.monotonic()
            outcome = "failed"
            try:
                result = fn(user_id, *args, **kwargs)
                outcome = "saved"
                return result
            finally:
                record(user_id, kind=kind, outcome=outcome, duration_ms=(time.monotonic() - started) * 1000)
        return run
    return decorate


def summary(days):
    # get_current_admin authorizes this call. The support-admin DB context is
    # transaction-local; normal users can only write/read their own samples.
    with db.as_support_admin():
        return db._rows("""SELECT kind, channel, outcome, client_reported, count(*) AS count,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY first_response_ms) AS first_response_p50_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY first_response_ms) AS first_response_p95_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY stt_ms) AS stt_p50_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY llm_ms) AS llm_p50_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY speech_ms) AS speech_p50_ms
            FROM chat_metrics WHERE created_at >= now() - (? * interval '1 day')
            GROUP BY kind,channel,outcome,client_reported ORDER BY kind,channel,outcome""", (days,))
