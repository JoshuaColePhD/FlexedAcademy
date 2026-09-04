"""Onboarding progress and funnel telemetry.

Two endpoints, both deliberately unable to hurt a teacher mid-setup. Progress
is bookkeeping the client fires and forgets; events are a batched, allowlisted
log. Neither is on the path of any answer the teacher actually gives — those
still go to /api/classes, /api/auth/me and the school-calendar routes as
before, so a failure here costs a funnel row and nothing else.

The gating signal is NOT here. App.jsx's ClassRoutes guard reads
users.onboarding_seen_at, which db.set_onboarding_progress stamps for both
terminal states — see its docstring and migration 74 for why keeping one
boolean-shaped gate is what stops a redirect loop from being reintroduced.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from .. import db, mail
from ..config import settings
from ..deps import get_current_user
from ..errors import AppError
from ..ratelimit import limiter

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/onboarding", tags=["onboarding"])

# Mirrors STEP_ORDER in frontend/src/lib/onboardingPlan.js. Duplicated across
# the language boundary on purpose — the alternative is trusting the client to
# name its own steps, and this is the value that lands in a column the admin
# funnel groups by. Keep the two in step; the frontend module is the authority
# on ORDER, this is the authority on what may be STORED.
STEPS = frozenset({
    "avatar",
    "course",
    "school",
    "calendar",
    "format",
    "preview",
    "materials",
})

# Mirrors ONBOARDING_EVENTS in the same module.
EVENT_NAMES = frozenset({
    "flow_started",
    "step_viewed",
    "step_completed",
    "step_skipped",
    "step_back",
    "step_error",
    "template_analyzed",
    "preview_shown",
    "preview_failed",
    "flow_skipped",
    "flow_completed",
    "state_unsupported_interest",
})

# The ONLY prop keys that may be stored, and this list is the privacy boundary
# rather than a convenience. Everything here is an enum, an id, an integer or a
# boolean. Specifically and permanently absent:
#
#   * filenames — template.filename is a real district document name;
#     section_count carries the same diagnostic signal without it
#   * school id — already on users.school and joinable server-side, so putting
#     it in an event body is gratuitous duplication of an identifier
#   * any free text, including error MESSAGES (step_error carries the AppError
#     code only, which is a closed set)
#
# This is a K-12 product. Setup telemetry must not be ABLE to contain a student
# name, a lesson, or a district filename — so unknown keys are dropped here
# rather than stored and cleaned up later.
PROP_KEYS = frozenset({
    "index",
    "plan_len",
    "resumed",
    "ms_on_step",
    "attempts",
    "from",
    "code",
    "analysis_status",
    "section_count",
    "error_count",
    "warning_count",
    "source",
    "mode",
    "builder_readiness",
    "ms_to_render",
    "standard_count",
    "reason",
    "total_ms",
    "steps_skipped",
    "state",
    "plan",
})

MAX_EVENTS_PER_REQUEST = 20
# A string prop is only ever an enum or a two-letter state code; this cap is
# belt-and-braces against a client that gets creative with `source`.
MAX_PROP_STR = 64
MAX_PROP_LIST = 16


class ProgressBody(BaseModel):
    step: str | None = Field(default=None, max_length=40)
    state: str | None = Field(default=None, max_length=20)


@router.post("/progress")
@limiter.limit("120/hour")
def set_progress(
    body: ProgressBody,
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Record the step reached, or a terminal state.

    Rate limited generously rather than tightly: a teacher stepping back and
    forth through a seven-step flow legitimately fires this a few dozen times,
    and the failure mode of a limit that's too tight is a lost funnel row, not
    a protected server.
    """
    if body.step is not None and body.step not in STEPS:
        raise AppError("unknown_step", "That isn't a setup step.", status=400)
    if body.state is not None and body.state not in db.ONBOARDING_STATES:
        raise AppError("unknown_state", "That isn't a setup state.", status=400)
    if body.step is None and body.state is None:
        raise AppError("nothing_to_record", "Send a step or a state.", status=400)

    user = db.set_onboarding_progress(user_id, step=body.step, state=body.state)
    if not user:
        raise AppError("not_found", "No such user.", status=404)
    return {
        "onboarding_state": user.get("onboarding_state"),
        "onboarding_step": user.get("onboarding_step"),
        "onboarding_seen_at": user.get("onboarding_seen_at"),
    }


class StateRequestBody(BaseModel):
    """A two-letter postal code, checked against the closed list rather than
    trusted: this value ends up in an email subject line."""
    state: str = Field(min_length=2, max_length=2)


# Mirrors US_STATES in frontend/src/lib/states.js. Only the codes, because the
# label is presentational and the request only needs to say WHICH state.
US_STATE_CODES = frozenset({
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
    "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
    "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY",
})


@router.post("/state-request")
@limiter.limit("10/hour")
def request_state(
    body: StateRequestBody,
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """A teacher outside Alabama asking for their state's standards.

    Two records, deliberately, because they answer different questions. The
    event is the queryable one — "how many teachers in which states", which is
    what decides the ingest order — and it is the durable half. The email is
    the prompt to go look, and it is best-effort: mail.send returning False
    must not turn a teacher's request into an error toast, because from their
    side the request WAS recorded.

    Recorded per request rather than deduplicated. A teacher who asks twice is
    a signal, not a mistake, and COUNT(DISTINCT user_id) is one word away for
    whoever reads the funnel.
    """
    code = body.state.strip().upper()
    if code not in US_STATE_CODES:
        raise AppError("unknown_state", "That isn't a state we recognise.", status=400)

    db.record_onboarding_events(user_id, [{
        "name": "state_unsupported_interest",
        "step": "school",
        "props": {"state": code},
    }])

    user = db.get_user_by_id(user_id)
    try:
        mail.send(
            to=settings.support_email,
            subject=f"FlexEd: standards requested for {code}",
            html=(
                f"<p><strong>{code}</strong> standards requested.</p>"
                f"<p>{(user or {}).get('name') or 'A teacher'} "
                f"&lt;{(user or {}).get('email') or 'unknown'}&gt;</p>"
                "<p>Counts by state are in the onboarding funnel "
                "(GET /api/admin/onboarding-funnel reads the snapshot; "
                "onboarding_events holds one row per request).</p>"
            ),
            reply_to=(user or {}).get("email"),
        )
    except Exception:  # see the docstring: a failed email must not fail the request
        log.exception("state request email failed for %s", code)

    return {"requested": code}


class EventBody(BaseModel):
    name: str = Field(max_length=48)
    step: str | None = Field(default=None, max_length=40)
    props: dict | None = None


class EventsBody(BaseModel):
    events: list[EventBody] = Field(default_factory=list, max_length=MAX_EVENTS_PER_REQUEST)


def _clean_props(props: dict | None) -> dict:
    """Drop anything not on the allowlist, and coerce what remains to a scalar.

    Silent dropping is the right behaviour here, not a 400: this is called from
    a sendBeacon on pagehide, where nobody is around to see an error and the
    only outcomes are "store the safe subset" or "lose the event". Rejecting the
    whole batch because one key was unrecognised would lose the drop-off signal
    at exactly the moment it matters most.
    """
    if not props:
        return {}
    cleaned: dict = {}
    for key, value in props.items():
        if key not in PROP_KEYS:
            continue
        # bool is a subclass of int, so this covers `resumed` too.
        if isinstance(value, int):
            cleaned[key] = value
        elif isinstance(value, str):
            cleaned[key] = value[:MAX_PROP_STR]
        elif isinstance(value, list):
            # steps_skipped / plan — lists of step keys, nothing else.
            cleaned[key] = [
                str(item)[:MAX_PROP_STR] for item in value[:MAX_PROP_LIST] if isinstance(item, str)
            ]
    return cleaned


@router.post("/events")
@limiter.limit("240/hour")
def record_events(
    body: EventsBody,
    request: Request,
    user_id: str = Depends(get_current_user),
):
    """Append funnel events, dropping anything not on the allowlist.

    Returns a count rather than the rows, and never raises for a bad event —
    see _clean_props. An unknown event NAME is dropped too, for the same
    reason: a client and server that disagree about the vocabulary should cost
    telemetry, not a teacher's setup.
    """
    accepted = [
        {"name": event.name, "step": event.step, "props": _clean_props(event.props)}
        for event in body.events
        if event.name in EVENT_NAMES and (event.step is None or event.step in STEPS)
    ]
    dropped = len(body.events) - len(accepted)
    if dropped:
        # Worth a log line: a persistent nonzero here means the frontend
        # vocabulary has drifted from EVENT_NAMES above.
        log.info("onboarding events dropped: %d of %d", dropped, len(body.events))
    written = db.record_onboarding_events(user_id, accepted)
    return {"recorded": written, "dropped": dropped}
