"""Lesson-plan generation, including the SSE stream."""
from __future__ import annotations

import json
import logging

import openai
from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import curriculum, db, llm, prompts, schoolcal, service
from ..config import settings
from ..deps import get_current_user
from ..entitlement import require_entitlement
from ..errors import AppError
from ..ratelimit import limiter
from ..schema import SchemaError
from ..template_context import weekly_template_context

log = logging.getLogger("flexedacademy.generate")
router = APIRouter(prefix="/api", tags=["generate"])


class GenerateRequest(BaseModel):
    query: str = Field(min_length=1, max_length=settings.max_query_chars)
    chat_id: str | None = None
    # The page's OWN class (ChatPage always has this from its route params),
    # sent explicitly rather than relied on solely from the chat's stored
    # class_id. Older chats (pre-migration-14) can have class_id NULL, and
    # _chat_class then returns None — without this field there was no other
    # way to know which class the request was actually about, and finalize
    # used to guess (see its own history). Validated against the caller's own
    # classes below before use, same as any other class_id from a client.
    class_id: str | None = None
    # Set only when the teacher picked a week explicitly (the new-plan week
    # picker). Left unset, week_system_prompt's own fallback ("If it names a
    # topic instead, pick the week the unit map assigns to it") is a MODEL
    # GUESS with nothing forcing it to agree with itself between requests —
    # confirmed against live data, where two unscoped prompts in the same
    # class landed on Week 12 and then Week 05. Resolving the week here, once,
    # and naming it explicitly in the query text is what makes `week_of`
    # deterministic instead of a coin flip.
    week_number: int | None = None


def _with_week(query: str, week_number: int | None, school_id: str) -> str:
    if week_number is None:
        return query
    week = next((w for w in schoolcal.school_weeks(school_id) if w["week"] == week_number), None)
    if not week:
        return query
    return f"Build this for {schoolcal.label_for(week)}. {query}"


def _request_class(user_id: str, req_class_id: str | None, chat_id: str | None) -> dict | None:
    """The class this generation is actually about.

    Prefers the request's own explicit class_id (the page the teacher is
    standing on) over the chat's stored one — get_class both looks it up AND
    checks it belongs to this user, so a class_id from another account is
    silently ignored rather than trusted. Falls back to _chat_class only when
    the caller didn't send one (older frontend builds, or a stream reopened
    without it)."""
    if req_class_id:
        cls = db.get_class(user_id, req_class_id)
        if cls:
            return cls
    return _chat_class(user_id, chat_id)


def _chat_class(user_id: str, chat_id: str | None) -> dict | None:
    """The chat's own class, if it and the chat both exist.

    Shared by /generate, /generate_stream and /chat_stream — all three
    resolve school (and chat_stream also resolves subject/grade) from
    whichever class the CHAT actually belongs to, not
    get_settings_row(user_id)'s "most recently touched settings row for this
    account". That old fallback is a legacy (user_id, subject) table
    predating `classes`: for a teacher with more than one prep, it returns
    whichever class was last touched anywhere in the app, not necessarily
    the one THIS chat is under — confirmed live as AP Lang's subject, grade
    and pacing guide leaking into an ENG 101 conversation whenever AP Lang's
    settings had been saved more recently.

    Returns None (not get_settings_row) for a legacy chat with no chat_id,
    no class_id, or a since-deleted class — every caller here already has
    its own fallback for that case (db.class_school falls back to the
    account default; the callers below fall back to get_settings_row)."""
    if not chat_id:
        return None
    chat = db.get_chat(user_id, chat_id)
    if not chat or not chat.get("class_id"):
        return None
    return db.get_class(user_id, chat["class_id"])

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatStreamRequest(BaseModel):
    messages: list[ChatMessage]
    mode: str = "brainstorm" # can be 'interview', 'standards', etc.
    # Set by VoiceModePanel's caller. Same endpoint, same tools — only the
    # system prompt changes (see chat_stream below): a live, spoken back-
    # and-forth reads nothing like a written chat, and the model has no
    # other way to know which one it's in.
    voice: bool = False
    # useChatStream has sent this in the request body all along — it's what
    # lets a reopened chat resume the right conversation elsewhere in the
    # app. This endpoint just never declared the field, so it was parsed and
    # silently dropped. Now used to resolve the chat's own class below,
    # instead of the account's most-recently-touched settings row.
    chat_id: str | None = None
    # The page's own class (ChatPage's classId route param), same reasoning
    # as GenerateRequest.class_id: a chat's STORED class_id can be NULL (an
    # older chat, or one created before scoping landed), and without this
    # field _build_chat_system_prompt had no way to know which class the
    # teacher is actually standing on — it fell back to
    # get_settings_row(user_id)'s "most recently touched settings row for
    # this account", which leaked one class's subject/grade into another
    # class's conversation. Validated against the caller's own classes
    # before use, same as GenerateRequest.class_id.
    class_id: str | None = None
    # The same value GenerateRequest.week_number carries (ChatPage's
    # effectiveWeek — the ?week= override, or else the next unplanned week),
    # sent here too so the conversational model knows it BEFORE generation,
    # not just at the moment of building. See chat_stream below: the empty
    # chat's own greeting already states this week aloud to the teacher.
    week_number: int | None = None


class DecisionsRequest(BaseModel):
    messages: list[ChatMessage]


class SuggestionRequest(BaseModel):
    class_id: str | None = None
    week_number: int = Field(ge=1, le=52)
    week_label: str = Field(min_length=1, max_length=80)


class ReviseDayRequest(BaseModel):
    plan_id: str = Field(min_length=1, max_length=64)
    day_index: int = Field(ge=0, le=4)
    feedback: str = Field(min_length=1, max_length=4000)
    # Additive and backward compatible: absent means "regenerate the whole day",
    # which is what every existing caller sends. Present means in-cell tweaking
    # — one key rewritten, siblings untouched. Membership is checked in
    # service.revise_day rather than by a Literal here, so the allowed set has
    # exactly one definition (schema.REVISABLE_FIELDS) and the rejection arrives
    # as the app's own {code,message,hint} envelope rather than a 422.
    field: str | None = None


class SetDayFieldRequest(BaseModel):
    """The picker's request: an exact, teacher-chosen value for one cell —
    see service.set_day_field's own docstring for why this is a separate,
    LLM-free path rather than another ReviseDayRequest.field case."""

    plan_id: str = Field(min_length=1, max_length=64)
    day_index: int = Field(ge=0, le=4)
    field: str
    value: str = Field(min_length=1, max_length=2000)


class ReviseDaysRequest(BaseModel):
    """The batch counterpart to ReviseDayRequest: one instruction, one field,
    applied across several days at once. `field` is required here — batching
    only makes sense for a scoped cell tweak, never a whole-day rewrite."""

    plan_id: str = Field(min_length=1, max_length=64)
    day_indices: list[int] = Field(min_length=1, max_length=5)
    feedback: str = Field(min_length=1, max_length=4000)
    field: str


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


def _openai_error_event(e: Exception) -> dict:
    """Map an OpenAI SDK exception to the app's {code, message, hint} shape.

    Before this, a timeout, a dropped connection, and a genuine server crash
    all surfaced as the same "internal_error" — indistinguishable to the
    frontend, so it could never tell the teacher whether retrying was even
    worth it. `retryable` lets the client decide that instead of guessing.
    """
    if isinstance(e, openai.APITimeoutError):
        return {
            "code": "upstream_timeout",
            "message": "The model took too long to respond.",
            "hint": "This is usually transient — try again.",
            "retryable": True,
        }
    if isinstance(e, openai.RateLimitError):
        return {
            "code": "rate_limited",
            "message": "Too many requests right now.",
            "hint": "Wait a few seconds and try again.",
            "retryable": True,
        }
    if isinstance(e, openai.APIConnectionError):
        return {
            "code": "upstream_connection_error",
            "message": "Could not reach the model provider.",
            "hint": "Check your connection and try again.",
            "retryable": True,
        }
    if isinstance(e, openai.APIStatusError):
        return {
            "code": "upstream_error",
            "message": "The model provider returned an error.",
            "hint": "Try again in a moment.",
            "retryable": True,
        }
    log.exception("stream crashed")
    return {
        "code": "internal_error",
        "message": "The server crashed while generating.",
        "retryable": False,
    }



@router.post("/generate")
@limiter.limit("100/minute")
def generate(req: GenerateRequest, request: Request, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    require_entitlement(user_id)
    # Resolved once, from the chat this generation belongs to (see
    # _chat_class) — used for the week label below AND threaded through to
    # service.generate so llm.generate_plan names the same school, not
    # whatever get_user_school(user_id) would answer on its own.
    cls = _request_class(user_id, req.class_id, req.chat_id)
    school_id = db.class_school(cls, user_id)
    query = _with_week(req.query, req.week_number, school_id)
    return service.generate(
        user_id,
        query,
        chat_id=req.chat_id,
        bg_tasks=bg_tasks,
        # Same lookup, reused rather than resolve_class(user_id)'s "whichever
        # class was touched most recently" fallback inside finalize — this
        # plan belongs to the chat's OWN class when one exists.
        class_id=cls["id"] if cls else None,
        school_id=school_id,
        cls=cls,
    )


@router.post("/generate_stream")
@limiter.limit("100/minute")
def generate_stream(req: GenerateRequest, request: Request, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    """Stream tokens, then emit the finished plan.

    Every terminal event carries an `error` object with the same {code, message,
    hint} shape as the REST errors, so the client has one path for both.
    """
    # Before the stream opens, so a blocked request is an ordinary 402 with the
    # normal error envelope rather than an SSE frame the reader has to special-
    # case. useLessonStream already reads a non-200 body through apiErrorFromBody.
    require_entitlement(user_id)
    cls = _request_class(user_id, req.class_id, req.chat_id)
    school_id = db.class_school(cls, user_id)
    query = _with_week(req.query, req.week_number, school_id)

    def event_stream():
        chunks: list[str] = []
        try:
            # Emitted BEFORE service.prepare, which is the slowest thing in
            # this whole request that isn't the model itself — an LLM
            # expand_query call plus ~30 pgvector reads. It all used to happen
            # ahead of the first yield, so the response headers were sent and
            # then nothing followed for seconds: no bytes, nothing for the
            # client to show, no way to tell a slow retrieval from a hung
            # request. This costs one frame and makes the wait legible.
            #
            # Additive: useLessonStream.js only reads the keys it knows
            # (grounding/chunk/done/error) and ignores anything else, so an
            # older client is unaffected by a new frame type.
            yield _sse({"status": "retrieving"})
            result = service.prepare(user_id, query, cls=cls)
            yield _sse(
                {
                    "grounding": {
                        "codes": sorted(result.codes),
                        "thin": result.thin,
                        "count": len(result.chunks),
                        "floor": result.floor,
                    }
                }
            )
            for delta in llm.stream_plan(user_id, query, result, school_id=school_id, class_id=cls["id"] if cls else None):
                chunks.append(delta)
                yield _sse({"chunk": delta})

            from ..schema import loads_lenient

            row = service.finalize(
                user_id=user_id,
                plan_raw=loads_lenient("".join(chunks)),
                query=query,
                result=result,
                chat_id=req.chat_id,
                bg_tasks=bg_tasks,
                class_id=cls["id"] if cls else None,
                cls=cls,
                week_number=req.week_number,
                school_id=school_id,
                subject=cls["subject"] if cls else None,
                grade=cls["grade"] if cls else None,
            )
            yield _sse(
                {
                    "done": True,
                    "plan_id": row["id"],
                    "plan": row["plan_json"],
                    "warnings": row["warnings"],
                    "week_label": row["week_label"],
                    "unit": row["unit"],
                }
            )
        except (AppError, SchemaError) as e:
            log.warning("stream failed code=%s", e.code)
            yield _sse({"error": e.payload().get("error", e.payload())})
        except Exception as e:  # noqa: BLE001 - last resort, still must reach the client
            yield _sse({"error": _openai_error_event(e)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        background=bg_tasks,
        # X-Accel-Buffering: nginx (and several PaaS routers, Render's
        # included) buffer a proxied response by default, which re-introduces
        # exactly the batching that excluding this route from gzip
        # (ConditionalGZipMiddleware) exists to avoid — just one hop further
        # out, where it is invisible from here.
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _build_chat_system_prompt(
    user_id: str, chat_id: str | None, week_number: int | None, mode: str, last_user: str = "", class_id: str | None = None
) -> str:
    cls = _request_class(user_id, class_id, chat_id)
    if cls:
        subject = cls["subject"]
        grade = cls["grade"]
    else:
        s = db.get_settings_row(user_id)
        subject = s.get("subject", "AP Language & Composition")
        grade = s.get("grade", "11")

    school_id = db.class_school(cls, user_id)
    response_length = llm.output_length_for(user_id)
    response_length_guidance = {
        "short": (
            "Keep every conversational reply SHORT — a few sentences at most. Name the "
            "throughline of an idea, don't write the week out day-by-day; the day-by-day "
            "content belongs in the generated plan itself (generate_lesson_plan), not typed "
            "out in chat first. If you need more from the teacher, ask ONE focused question "
            "rather than a paragraph of them."
        ),
        "long": (
            "Give a thorough but focused conversational reply when useful — enough context "
            "to make the recommendation actionable, without writing the full week day-by-day "
            "before generate_lesson_plan is called. If you need more from the teacher, ask "
            "ONE focused question rather than a paragraph of them."
        ),
    }.get(
        response_length,
        "Keep conversational replies concise but complete — usually a few focused sentences "
        "with enough context to be actionable. The day-by-day content belongs in the generated "
        "plan itself (generate_lesson_plan), not typed out in chat first. If you need more from "
        "the teacher, ask ONE focused question rather than a paragraph of them.",
    )
    system_prompt = (
        f"You are a master educator and expert curriculum brainstorming assistant for {subject} (Grade {grade}). "
        "You have decades of classroom experience. When giving advice, draw upon pedagogical best practices, "
        "cognitive science, and proven classroom management strategies. Speak with the empathy, wisdom, and practicality "
        "of a veteran teacher coaching a peer. Focus on active learning, student engagement, and realistic, actionable solutions.\n\n"
        # Nothing below constrained length, so a message proposing a plan
        # would write the whole week out in prose — a paragraph plus a full
        # Monday-through-Friday breakdown — before generate_lesson_plan had
        # even been called. That's not a preview, it's a rough draft the
        # teacher reads once here and then reads again for real once the
        # plan actually builds. Chat is for the pitch, not the plan.
        + response_length_guidance + " "
        # Any length setting should still sound like a colleague rather than a
        # system log: keep the answer warm, practical, and interested in what
        # the teacher is trying to accomplish.
        + "Whatever the selected length, sound like a colleague talking — warm, practical, and "
        "interested in what the teacher's going for, not a system logging a transaction.\n\n"
    )

    if mode == "sub_plan":
        system_prompt += (
            "The teacher is sick today and needs an EMERGENCY 5-MINUTE SUB PLAN. "
            "Do NOT ask questions. Do NOT brainstorm. Immediately output a highly scripted, idiot-proof, hour-by-hour (or minute-by-minute) "
            "substitute teacher packet based strictly on the current week's pacing guide. The plan must be ready to print and hand to a sub.\n\n"
        )
    else:
        system_prompt += "The teacher is preparing to generate or revise a weekly lesson plan.\n\n"

    system_prompt += (
        "\n\nFIXED WEEKLY PLAN STRUCTURE: The selected school's weekly lesson-plan format is already "
        "configured in the app. " + weekly_template_context(school_id) + " "
        "For a normal new plan, use the template-defined weekdays automatically; use the school calendar to mark "
        "holidays or no-school days. Never ask the teacher how many days the plan should run, whether it "
        "is a one-, two-, three-, four-, or five-day week, or what duration to use. Clarifying questions should instead "
        "narrow the anchor text or topic, skill, throughline, or student task."
    )

    week_row = None
    if week_number is not None:
        week_row = next(
            (w for w in schoolcal.school_weeks(school_id) if w["week"] == week_number), None
        )

    if week_row:
        system_prompt += f"\n\nTHE TEACHER IS CURRENTLY WORKING ON {schoolcal.label_for(week_row)}"
        unit_row = curriculum.unit_for_calendar_week(user_id, subject, week_row)
        if unit_row:
            system_prompt += f", which their own pacing guide names as {unit_row['unit']}"
        system_prompt += (
            ". Treat the week"
            + (" and unit" if unit_row else "")
            + " as already settled — don't ask which one this is unless the "
            "teacher's own message clearly means a different week."
        )

    map_context = llm.map_context_for(user_id, subject, last_user, class_id=cls["id"] if cls else None) if last_user else ""
    if map_context:
        system_prompt += (
            "\n\nTHE TEACHER'S OWN CURRICULUM MAP / PACING GUIDE — relevant excerpts below. "
            "Use it to ground this conversation in their actual sequencing, unit, and any texts "
            "or milestones it names. It carries no standard codes of its own; when the plan is "
            "built, standards still come only from retrieval, not from this document.\n\n"
            + map_context
        )

    custom_instructions = llm.custom_instructions_for(user_id)
    if custom_instructions:
        system_prompt += (
            "\n\nTEACHER'S GLOBAL CUSTOM INSTRUCTIONS — style/format preferences only:\n\n"
            + custom_instructions
        )

    class_custom_instructions = (cls or {}).get("custom_instructions")
    if class_custom_instructions:
        system_prompt += (
            "\n\nTEACHER'S CUSTOM INSTRUCTIONS FOR THIS CLASS — on top of, not instead of, "
            "the account-wide instructions above:\n\n" + class_custom_instructions
        )

    if mode == "interview":
        system_prompt += (
        "Your job is to INTERVIEW the teacher to figure out what they want to teach. "
        "Ask inquisitive, guiding questions one at a time. Be conversational, exactly like Claude does when asked to interview a user. "
        "When you have enough information to build the 5-day week, call the `generate_lesson_plan` tool."
        )
    elif mode == "standards":
        system_prompt += (
            "Your job is to help the teacher find the perfect academic standards for their upcoming week. "
            "Suggest broad topics and narrow down what standards they should focus on. "
        )

    # The request already carries the full conversational message list below.
    # Re-reading and embedding the same history into the system prompt added a
    # database round trip and duplicated prompt tokens on every turn. Keeping
    # history in the messages array also gives the provider a stable system
    # prefix, which is friendlier to prompt-prefix caching.
    return system_prompt

class VoiceSessionRequest(BaseModel):
    """The body of POST /api/voice/session.

    This class did not exist. The handler below has always annotated its
    parameter with this name (the WebRTC migration, commit eb498c8, added the
    route and never added the model), and the failure mode is worth recording
    because it is not the one you would expect: an undefined annotation does
    NOT raise at import. `from __future__ import annotations` makes it the
    string "VoiceSessionRequest", FastAPI's lenient type resolution swallows
    the NameError and leaves it unresolved, and an unresolved parameter is not
    treated as a request body — it is treated as a required QUERY parameter.

    So the route registered fine, the app booted fine, and every possible
    request to it returned:

        422 {"detail":[{"type":"missing","loc":["query","req"], ...}]}

    Verified with TestClient before writing this. Field names and defaults
    match what VoiceProvider.startSession() sends.
    """

    # Kept for API-contract stability with the client (VoiceProvider.jsx
    # sends all four on every session start) and because a future feature
    # may want per-session context again — but the handler below no longer
    # READS any of them. It used to hand them to _build_chat_system_prompt
    # and pass the result as the Realtime session's `instructions`, which
    # was pure session-open latency for a value the realtime model can
    # never act on (turn_detection sets create_response=False, so this
    # session only transports/transcribes; see voice_session's own
    # comment).
    chat_id: str | None = None
    class_id: str | None = None
    week_number: int | None = None
    mode: str = "brainstorm"


@router.post("/voice/session")
@limiter.limit("10/minute")
def voice_session(req: VoiceSessionRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Provisions an ephemeral WebRTC token for OpenAI's Realtime API.

    Rate-limited like every other cost-relevant route here — this one had
    been missed, and unlike a chat_stream call, each one of these is a real
    outbound request to OpenAI before a teacher has said a word.
    """
    require_entitlement(user_id)
    import requests

    # POST /v1/realtime/sessions was the pre-GA (2024 beta) endpoint and no
    # longer exists — it answered every call with
    #   {"error":{"message":"Invalid URL (POST /v1/realtime/sessions)"}}
    # which this handler then wrapped in a 500. Ephemeral keys now come from
    # /v1/realtime/client_secrets, and the session config moved inside a
    # "session" object with the voice under audio.output.
    resp = requests.post(
        "https://api.openai.com/v1/realtime/client_secrets",
        headers={
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "session": {
                "type": "realtime",
                "model": settings.realtime_model,
                # No `instructions` here on purpose. This used to be a full
                # _build_chat_system_prompt() call — a class lookup, a
                # calendar walk, a custom-instructions read, a unit
                # resolution — spent on session-open latency for a value the
                # realtime model can never act on: turn_detection below sets
                # create_response=False, so this session only transports
                # audio, detects turns, and transcribes; it never generates a
                # reply. Every `response.create` the client sends later
                # supplies its own instructions (voiceSpeechQueue.js's
                # "read this aloud verbatim"), which is the only text this
                # session's model ever reads.
                "audio": {
                    "input": {
                        # Without this the session streams the teacher's audio
                        # and never tells us a single word of it. The panel used
                        # to get the transcript from its own Whisper round trip
                        # (encodeWav -> /api/transcribe), and the WebRTC
                        # migration deleted that pipeline without turning on the
                        # replacement, so nothing downstream ever learned what
                        # was said.
                        #
                        # `language` pins the transcription the way llm.transcribe
                        # (the Composer-dictation path) already does — without it,
                        # Whisper is free to guess a language from a snippet of
                        # room noise or silence, which is exactly the kind of
                        # hallucinated transcript that used to get filtered by
                        # transcribe()'s own no_speech_prob check. The Realtime
                        # API's completed-transcription event carries no
                        # per-segment no_speech_prob to repeat that check here, so
                        # pinning the language is the guard actually available on
                        # this path.
                        "transcription": {"model": "whisper-1", "language": "en"},
                        # Realtime only transports audio, detects turns, and
                        # transcribes them. ChatPage sends the completed
                        # transcript through grounded /api/chat_stream.
                        #
                        # silence_duration_ms lowered from the (undocumented but
                        # measured ~500ms) default toward 350ms, and the other
                        # two made explicit rather than left to whatever the
                        # default happens to be — this sits directly in the
                        # end-to-end latency budget on every single turn, and it
                        # runs on every hands-free release too (there is no
                        # server-side "end this turn now" signal from push-to-
                        # talk other than this same silence timer).
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": 0.5,
                            "prefix_padding_ms": 300,
                            "silence_duration_ms": 350,
                            "create_response": False,
                        },
                    },
                    "output": {"voice": settings.realtime_voice},
                },
            }
        },
        timeout=settings.realtime_session_timeout_s,
    )

    if resp.status_code != 200:
        raise AppError("realtime_failure", f"Failed to provision realtime session: {resp.text}", status=500)

    data = resp.json()
    # A stable shape of OUR OWN, not OpenAI's envelope passed through.
    #
    # Two reasons. The envelope already moved once underneath this code — the
    # old endpoint nested the key at client_secret.value and this one returns
    # it at the top level as `value` — and the client was reading the old path,
    # so a straight pass-through would have handed VoiceProvider `undefined`
    # even once the URL was right. And `model` has to be IDENTICAL in the
    # token request above and in the browser's SDP POST; it was hardcoded
    # separately in both files, which is a silent-failure waiting to happen on
    # the next model bump. Sending it back means there is one source of truth.
    token = data.get("value") or (data.get("client_secret") or {}).get("value")
    if not token:
        raise AppError(
            "realtime_failure",
            "Realtime session was provisioned without a client secret.",
            status=500,
        )
    return {
        "token": token,
        "model": settings.realtime_model,
        "expires_at": data.get("expires_at"),
    }


class VoiceUsageRequest(BaseModel):
    """Client-reported usage off a session's response.done events.

    Everywhere else in this app, db.record_usage runs on the SAME machine
    that made the OpenAI call, so there's nothing to trust — the number IS
    what was spent. A voice session is different: the browser talks to
    OpenAI directly over WebRTC, so this backend never sees the response
    objects those calls produce, and the token counts below are only as
    honest as the client reporting them. Sanity-capped, not verified — a
    teacher's own browser under-reporting its own usage cap isn't a threat
    model this app defends against anywhere else either, but an endpoint
    that writes to the usage table without SOME ceiling is worth avoiding
    regardless.
    """

    input_tokens: int = Field(ge=0, le=200_000)
    output_tokens: int = Field(ge=0, le=200_000)


@router.post("/voice/usage")
@limiter.limit("60/minute")
def voice_usage(req: VoiceUsageRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Records what a just-ended voice session cost, so it counts against
    the same rolling entitlement cap chat_stream and every generation call
    already feed (db.tokens_used_since sums across every `kind`) — before
    this, the audio-transport half of a voice session was invisible to the
    app's own cost accounting entirely."""
    db.record_usage(user_id, "realtime_voice", req.input_tokens, req.output_tokens)
    return {"ok": True}


@router.post("/chat_stream")
@limiter.limit("100/minute")
def chat_stream(req: ChatStreamRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Stream a standard conversational response, not a JSON schema."""
    # Before the stream opens, so a blocked request is an ordinary 402 with the
    # normal error envelope rather than an SSE frame the reader has to special-
    # case — same reasoning and placement as generate_stream's own call above.
    # This route is the one door that used to slip past the gate entirely: the
    # client only pre-checks mayGenerate for a chat with no plan yet
    # (ChatPage.jsx's own comment on that check), so a REVISION to an existing
    # plan — which still spends real tokens, same as building one — reached
    # this endpoint with no entitlement check anywhere in it, trial_expired or
    # over-cap and all. entitlement.py's own module docstring already claimed
    # chat_stream was covered; it wasn't, until now.
    require_entitlement(user_id)

    def event_stream():
        try:
            plans_for_chat = db.list_plans(user_id, chat_id=req.chat_id, limit=1)["items"] if req.chat_id else []
            has_plan = bool(plans_for_chat)
            has_quiz = has_plan and bool(db.list_quizzes_for_plan(user_id, plans_for_chat[0]["id"]))

            last_user = next(
                (m.content for m in reversed(req.messages) if m.role == "user"), ""
            )
            system_prompt = _build_chat_system_prompt(
                user_id, req.chat_id, req.week_number, req.mode, last_user, class_id=req.class_id
            )

            # How many ask_clarifying_questions rounds have happened since the
            # last real commitment (a build/revision confirmation) — not a
            # lifetime total, so an earlier plan build followed by a later
            # quiz-config round doesn't get conflated with this. Real chat
            # data showed this needed a hard backstop: 7 of 36 chats hit a
            # second round or later before a plan was ever built, one hit 5
            # rounds straight — the model has the full prior history to
            # notice that itself (nothing here truncates `req.messages`),
            # it's just never told to weigh it.
            #
            # A plain conversational nudge between two formal rounds (e.g.
            # "could you answer with a specific text/topic?") must NOT reset
            # this count — live-testing this exact fix found the model doing
            # exactly that (round, nudge, round, round — 3 formal rounds with
            # only a plain-text reply between two of them), and a naive
            # "stop at the first non-matching assistant message" walk undercounts
            # it: that in-between nudge isn't a round, but it also isn't a
            # commitment, so scanning has to skip over it rather than
            # stopping there. Only a real build/revision confirmation ends
            # the count — everything else between rounds still counts
            # against the same unbuilt stretch.
            #
            # Detected by the literal lead-in text the prompt below asks the
            # model to use ("A couple of quick questions..." — every one of
            # the real rounds in the data used exactly this phrasing) and the
            # literal build/revision confirmations from ChatPage.jsx ("...is
            # built...", "Done — ..."); no tool-call marker exists in the
            # persisted message row to check instead, so a reworded intro or
            # confirmation would silently drift this count.
            prior_clarify_rounds = 0
            for m in reversed(req.messages):
                if m.role != "assistant":
                    continue
                text = m.content.strip().lower()
                if text.startswith("a couple of quick questions"):
                    prior_clarify_rounds += 1
                    continue
                if " is built" in text or " is updated" in text or text.startswith(("done —", "done -")):
                    break  # a real commitment — the unbuilt stretch ends here
                # Anything else (a plain nudge, a brainstorm reply) is still
                # part of the same unbuilt stretch — keep scanning past it.
            if prior_clarify_rounds >= 2:
                system_prompt += (
                    f"\n\nThis conversation has already had {prior_clarify_rounds} rounds of "
                    "clarifying questions in a row with nothing built yet. Do NOT call "
                    "ask_clarifying_questions again this turn — call generate_lesson_plan (or "
                    "generate_quiz, whichever applies) now, making a reasonable choice for anything "
                    "still unspecified and saying what you assumed, rather than asking a third time.\n\n"
                )

            # Mutually exclusive, not stacked — see prompts.voice_prompt's own
            # docstring for why appending both used to directly contradict
            # each other on every spoken turn.
            if req.mode == "brainstorm" and not req.voice:
                system_prompt += (
                    "Act as an expert in education having a natural back-and-forth conversation with a colleague. Brainstorm ideas for their upcoming week, or discuss revisions to an existing week. "
                    "Give advice, feedback, and clear choices directly in your conversational replies. When a teacher names a text, a skill, or an angle, "
                    "react to it specifically as an expert — what's interesting about it, pedagogical best practices, how it might play out across the "
                    "week, or related angles worth considering. Do not just ask what they want to do; OFFER them expert suggestions and choices "
                    "to move into right in your text. Concise is not the same as terse: a genuine expert reaction in a few sentences beats a bare acknowledgment.\n\n"
                    "Sound like a colleague who's actually thinking about THIS class, not a generic assistant reciting "
                    "best practices at whoever's listening. Pick up specific details the teacher already gave you — their "
                    "students, the text, a choice from earlier in the conversation — by name, instead of restating their "
                    "request back at them before answering it. A little genuine reaction is welcome ('that's a hard one to "
                    "sequence', 'I like that pairing with the unit') where it's true, not tacked on. Warmth here means "
                    "specific and present, not effusive: skip empty enthusiasm and exclamation points ('Great question!', "
                    "'Love it!') that read as performative rather than actually engaged.\n\n"
                    "When you have enough information and the user is ready to build or revise the plan, call the `generate_lesson_plan` tool. "
                    "If their most recent message is genuinely too vague to act on — a new request like \"I want to "
                    "make a lesson\" with no text, topic, or skill named, a brainstorming reply that doesn't narrow "
                    "anything down, or a revision ask like \"can you change Thursday?\" with no hint of how — call "
                    "`ask_clarifying_questions` INSTEAD, with 2-4 short questions and a few clickable options each. "
                    "However, prefer offering conversational advice and inline suggestions before reaching for the multiple choice buttons, using them only when you truly need structured choices to narrow down a broad topic.\n\n"
                    "When you DO call `ask_clarifying_questions`, your accompanying text should be ONE short "
                    "line — \"A couple of quick questions to get this right:\" or similar — and nothing more. "
                    "Do NOT restate, list, or preview the questions or their options in that text: they render "
                    "immediately below as their own tappable card, one question at a time, and a written "
                    "recap of all of them at once just duplicates that and pushes it off screen.\n\n"
                    "This isn't limited to the first message of a request: reach for it again later in the same "
                    "conversation if a later turn is just as vague, but never re-ask about something the teacher "
                    "already told you or already picked from a previous round — build on what they gave you.\n\n"
                    "Hold the line on having an actual plan before you build one: `generate_lesson_plan` needs "
                    "WHICH WEEK OR UNIT and WHAT THE WEEK IS ABOUT (an anchor text, a skill, or a specific "
                    "focus). If the week/unit was already named for you above, treat that half as settled — "
                    "the plan itself is always the complete structure from the selected school "
                    "template, so never ask how many days it should run. "
                    "don't ask about it again unless the teacher's own message clearly points at a different "
                    "week. WHAT THE WEEK IS ABOUT is a separate question that is almost never answered for "
                    "you; missing that, ask rather than build — a week generated from a one-line request "
                    "costs the teacher more time correcting it than answering one question would have.\n\n"
                    "Having both of those facts means you COULD build, which is not always the same as SHOULD "
                    "build yet. Read the register of the message: a DIRECTIVE turn (\"plan a week on X\", "
                    "\"let's build it around Y\", or a reply that's clearly just answering what you asked) means "
                    "build immediately — that teacher wants the plan, not more conversation, and making them ask "
                    "twice is its own kind of friction. An EXPLORATORY turn (musing about an idea, thinking out "
                    "loud, asking what you think of an angle) means the topic exists but the teacher hasn't "
                    "actually asked you to build yet — engage with the idea, and if it's developed enough to "
                    "build, OFFER to (\"Want me to put that together?\") rather than building unasked. Once "
                    "you've offered, treat their very next message as the answer to that offer: anything that "
                    "isn't a clear redirect counts as yes.\n\n"
                    "When you do call `generate_lesson_plan`, say something first that names what you're "
                    "actually building — the text, the skill, the throughline you two landed on — not a generic "
                    "\"Sure, building now.\" That line is what the teacher sees while the document is being "
                    "written, and a generic one reads as though the specific conversation you just had didn't "
                    "register.\n\n"
                    + (
                        "A plan already exists for this conversation. If the teacher explicitly asks for a "
                        "quiz, test, or assessment as a downloadable file: when their request ALREADY names "
                        "which question type(s) they want (multiple choice, true/false, short answer, "
                        "matching) AND roughly how many questions, call `generate_quiz` with those values "
                        "directly. Otherwise call `ask_clarifying_questions` INSTEAD — two short questions, "
                        "each with a few tappable options, e.g. 'What kind of questions?' (Multiple choice / "
                        "True or false / Short answer / Matching / A mix) and 'About how many?' (5 / 10 / 15 "
                        "/ 20). Only ask about whichever of the two the teacher didn't already specify — if "
                        "they said '10 multiple choice questions' that's already both answered, build "
                        "immediately. Never call `generate_quiz` unasked, and never alongside "
                        "`generate_lesson_plan` in the same turn.\n\n"
                        + (
                            "A quiz already exists for this conversation. If the teacher's message is asking "
                            "to change, fix, or improve the quiz you already built ('make it harder', 'add "
                            "two more questions', 'fix question 3', 'make these easier') — call "
                            "`generate_quiz` again with `revises_current: true` so it updates the existing "
                            "quiz instead of building a separate one. Only set it false (or call without it) "
                            "when the teacher explicitly asks for an ADDITIONAL, distinct quiz — a different "
                            "question type, or a second quiz alongside the first."
                            if has_quiz
                            else ""
                        )
                        if has_plan
                        else "No plan exists yet for this conversation, so `generate_quiz` cannot be called — "
                        "if the teacher asks for a quiz before there is a week to test, tell them to build "
                        "the week first."
                    )
                )

            # Voice mode's own turn-taking, not just a shorter version of the
            # written prompt above. A written reply gets skimmed; a spoken
            # one has to be LISTENED to in real time, so length is not a
            # style preference here, it's what makes the mic able to hear
            # the teacher again before they've given up and talked over it.
            # Same reasoning for one question at a time: ask_clarifying_
            # questions' 2-4-questions-with-several-options-each shape is
            # built for tappable cards (LessonQuestions) — read aloud as a
            # single paragraph, it's not answerable in one breath.
            #
            # elif, not a second `if` — see the `and not req.voice` guard
            # above. The two prompts each say the opposite thing about
            # length and question count, so a voice turn must get only this
            # one.
            elif req.voice:
                system_prompt += prompts.voice_prompt()

            messages = [{"role": "system", "content": system_prompt}]
            messages.extend([{"role": msg.role, "content": msg.content} for msg in req.messages])

            for event in llm.stream_chat(user_id, messages, voice=req.voice):
                yield _sse(event)

            yield _sse({"done": True})
        except (AppError, SchemaError) as e:
            log.warning("chat stream failed code=%s", e.code)
            yield _sse({"error": e.payload().get("error", e.payload())})
        except Exception as e:  # noqa: BLE001 - last resort, still must reach the client
            yield _sse({"error": _openai_error_event(e)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        # See the identical header block on /generate_stream above.
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/decisions")
@limiter.limit("100/minute")
def decisions(req: DecisionsRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Voice mode's card stack — see llm.extract_decisions for why this isn't
    gated by require_entitlement: it's a visual aid over an ALREADY-gated
    conversation, not a plan generation in its own right."""
    msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    return {"decisions": llm.extract_decisions(user_id, msgs)}


@router.post("/suggestion")
@limiter.limit("100/minute")
def suggestion(req: SuggestionRequest, request: Request, user_id: str = Depends(get_current_user)):
    """The composer's empty-state Tab suggestion, upgraded from
    contextualSuggestions.js's generic template with what the teacher's own
    pacing guide actually says this week covers. Not gated by
    require_entitlement — same reasoning as /decisions: a visual aid over
    already-gated planning, not a generation in its own right. Callers keep
    their own generic suggestion on any null/error response, so a missing
    pacing guide or a cold cache never blocks the composer."""
    cls = db.resolve_class(user_id, req.class_id)
    subject = (cls or {}).get("subject")
    if not subject:
        return {"prompt": None, "reason": None}
    school_id = db.class_school(cls, user_id)
    weeks = schoolcal.school_weeks(school_id)
    week = next((w for w in weeks if w["week"] == req.week_number), {"week": req.week_number, "start": None, "end": None})
    hit = curriculum.unit_for_calendar_week(user_id, subject, week)
    result = llm.generate_week_suggestion(
        user_id,
        week_label=req.week_label,
        unit=(hit or {}).get("unit"),
        class_name=(cls or {}).get("name"),
        custom_instructions=llm.custom_instructions_for(user_id),
        class_custom_instructions=(cls or {}).get("custom_instructions"),
    )
    return {"prompt": (result or {}).get("prompt"), "reason": (result or {}).get("reason")}


@router.post("/revise_day")
@limiter.limit("100/minute")
def revise_day(req: ReviseDayRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Rewrite one day — or one cell of it — AND rebuild the .docx, so the file
    matches what's on screen."""
    require_entitlement(user_id)
    return service.revise_day(user_id, req.plan_id, req.day_index, req.feedback, req.field)


@router.post("/set_day_field")
@limiter.limit("100/minute")
def set_day_field(req: SetDayFieldRequest, request: Request, user_id: str = Depends(get_current_user)):
    """The standard-picker's endpoint: set one cell to an exact value with no
    model call, then rebuild the .docx. See service.set_day_field."""
    require_entitlement(user_id)
    return service.set_day_field(user_id, req.plan_id, req.day_index, req.field, req.value)


@router.post("/revise_days")
@limiter.limit("100/minute")
def revise_days(req: ReviseDaysRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Rewrite one field across several days from a single instruction, then
    rebuild the .docx once."""
    require_entitlement(user_id)
    return service.revise_days(user_id, req.plan_id, req.day_indices, req.feedback, req.field)


@router.post("/chats/{chat_id}/messages")
def add_message(chat_id: str, body: dict, user_id: str = Depends(get_current_user)):
    role = body.get("role")
    if role not in ("user", "assistant", "system"):
        raise AppError("bad_role", f"Unknown message role {role!r}.", status=400)
    if not db.get_chat(user_id, chat_id):
        raise AppError("chat_not_found", "No such chat.", status=404)
    client_id = body.get("client_id")
    if client_id is not None and not isinstance(client_id, str):
        raise AppError("bad_client_id", "client_id must be a string.", status=400)
    source = body.get("source")
    if source is not None and source not in ("voice",):
        raise AppError("bad_source", f"Unknown message source {source!r}.", status=400)
    return db.add_message(
        chat_id,
        role,
        str(body.get("content") or ""),
        body.get("plan_id"),
        client_id=client_id,
        source=source,
    )
