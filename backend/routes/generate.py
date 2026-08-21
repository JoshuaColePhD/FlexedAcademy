"""Lesson-plan generation, including the SSE stream."""
from __future__ import annotations

import json
import logging

import openai
from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import curriculum, db, llm, schoolcal, service
from ..config import settings
from ..deps import get_current_user
from ..entitlement import require_entitlement
from ..errors import AppError
from ..ratelimit import limiter
from ..schema import SchemaError

log = logging.getLogger("aplang.generate")
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
    # The same value GenerateRequest.week_number carries (ChatPage's
    # effectiveWeek — the ?week= override, or else the next unplanned week),
    # sent here too so the conversational model knows it BEFORE generation,
    # not just at the moment of building. See chat_stream below: the empty
    # chat's own greeting already states this week aloud to the teacher.
    week_number: int | None = None


class DecisionsRequest(BaseModel):
    messages: list[ChatMessage]


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
@limiter.limit("20/minute")
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
@limiter.limit("20/minute")
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
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


def _build_chat_system_prompt(user_id: str, chat_id: str | None, week_number: int | None, mode: str, last_user: str = "") -> str:
    cls = _chat_class(user_id, chat_id)
    if cls:
        subject = cls["subject"]
        grade = cls["grade"]
    else:
        s = db.get_settings_row(user_id)
        subject = s.get("subject", "AP Language & Composition")
        grade = s.get("grade", "11")

    school_id = db.class_school(cls, user_id)
    system_prompt = (
        f"You are a master educator and expert curriculum brainstorming assistant for {subject} (Grade {grade}). "
        "You have decades of classroom experience. When giving advice, draw upon pedagogical best practices, "
        "cognitive science, and proven classroom management strategies. Speak with the empathy, wisdom, and practicality "
        "of a veteran teacher coaching a peer. Focus on active learning, student engagement, and realistic, actionable solutions.\n\n"
    )

    if mode == "sub_plan":
        system_prompt += (
            "The teacher is sick today and needs an EMERGENCY 5-MINUTE SUB PLAN. "
            "Do NOT ask questions. Do NOT brainstorm. Immediately output a highly scripted, idiot-proof, hour-by-hour (or minute-by-minute) "
            "substitute teacher packet based strictly on the current week's pacing guide. The plan must be ready to print and hand to a sub.\n\n"
        )
    else:
        system_prompt += "The teacher is preparing to generate or revise a weekly lesson plan.\n\n"

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

# The realtime model and voice, named once. Both the ephemeral-key request and
# the browser's own SDP POST have to agree on the model, so the client reads
# this value back off the session response rather than repeating the literal.
REALTIME_MODEL = "gpt-realtime-2.1"
REALTIME_VOICE = "alloy"


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
    match what the handler reads (req.chat_id / req.week_number / req.mode)
    and what VoiceProvider.unlock() sends.
    """

    # Same three fields, same defaults, same meaning as ChatStreamRequest's —
    # this endpoint hands them to the very same _build_chat_system_prompt, so
    # they must not drift from it.
    chat_id: str | None = None
    week_number: int | None = None
    mode: str = "brainstorm"


@router.post("/voice/session")
def voice_session(req: VoiceSessionRequest, user_id: str = Depends(get_current_user)):
    """Provisions an ephemeral WebRTC token for OpenAI's Realtime API."""
    require_entitlement(user_id)
    import requests
    
    system_prompt = _build_chat_system_prompt(user_id, req.chat_id, req.week_number, req.mode)
    
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
                "model": REALTIME_MODEL,
                "instructions": system_prompt,
                "audio": {
                    "input": {
                        # Without this the session streams the teacher's audio
                        # and never tells us a single word of it. The panel used
                        # to get the transcript from its own Whisper round trip
                        # (encodeWav -> /api/transcribe), and the WebRTC
                        # migration deleted that pipeline without turning on the
                        # replacement, so nothing downstream ever learned what
                        # was said.
                        "transcription": {"model": "whisper-1"},
                        # Realtime only transports audio, detects turns, and
                        # transcribes them. ChatPage sends the completed
                        # transcript through grounded /api/chat_stream.
                        "turn_detection": {"type": "server_vad", "create_response": False},
                    },
                    "output": {"voice": REALTIME_VOICE},
                },
            }
        },
        timeout=10,
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
        "model": REALTIME_MODEL,
        "expires_at": data.get("expires_at"),
    }


@router.post("/chat_stream")
@limiter.limit("30/minute")
def chat_stream(req: ChatStreamRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Stream a standard conversational response, not a JSON schema."""
    def event_stream():
        try:
            plans_for_chat = db.list_plans(user_id, chat_id=req.chat_id, limit=1)["items"] if req.chat_id else []
            has_plan = bool(plans_for_chat)
            has_quiz = has_plan and bool(db.list_quizzes_for_plan(user_id, plans_for_chat[0]["id"]))

            last_user = next(
                (m.content for m in reversed(req.messages) if m.role == "user"), ""
            )
            system_prompt = _build_chat_system_prompt(user_id, req.chat_id, req.week_number, req.mode, last_user)

            if req.mode == "brainstorm":
                system_prompt += (
                    "Act as an expert in education having a natural back-and-forth conversation with a colleague. Brainstorm ideas for their upcoming week, or discuss revisions to an existing week. "
                    "Give advice, feedback, and clear choices directly in your conversational replies. When a teacher names a text, a skill, or an angle, "
                    "react to it specifically as an expert — what's interesting about it, pedagogical best practices, how it might play out across the "
                    "week, or related angles worth considering. Do not just ask what they want to do; OFFER them expert suggestions and choices "
                    "to move into right in your text. Concise is not the same as terse: a genuine expert reaction in a few sentences beats a bare acknowledgment.\n\n"
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
            if req.voice:
                system_prompt += (
                    "\n\nTHIS IS A LIVE SPOKEN CONVERSATION, read aloud by text-to-speech and answered "
                    "by transcribing the teacher's voice — not a written chat. Reply the way a person "
                    "actually talks: ONE short sentence, sometimes two, never more. Never a list, "
                    "never a paragraph, never more than one question in a turn. Get to the point; a "
                    "teacher mid-conversation can always ask you to say more.\n\n"
                    "OPEN EVERY TURN WITH A TWO-OR-THREE-WORD ACKNOWLEDGEMENT, punctuated as its own "
                    "sentence, before anything else: \"Got it.\" \"Okay.\" \"Sure thing.\" \"Let me "
                    "look.\" \"Nice one.\" Vary it; never the same opener twice in a row. This is not "
                    "filler — it is the first thing spoken aloud, and it goes out while the rest of "
                    "your reply is still being written, so the teacher hears you respond in about a "
                    "third of a second instead of waiting in silence for the whole sentence. A gap "
                    "over about seven hundred milliseconds is heard as reluctance rather than as "
                    "thinking, which is why this matters more in speech than it would in writing.\n\n"
                    "WHEN SOMETHING IS UNDERSPECIFIED, call `ask_clarifying_questions` with exactly "
                    "ONE question and 3-4 short options. The options are rendered as buttons the "
                    "teacher can tap, so make each one a concrete, distinct choice of a few words — "
                    "never 'other' or 'something else', and never options that are rephrasings of "
                    "each other. Your spoken text alongside it should be just the question itself; "
                    "do NOT read the options aloud, they are already on screen.\n\n"
                    "DO NOT call `generate_lesson_plan` until you actually have a week's worth of "
                    "plan to build: at minimum you must know WHICH WEEK OR UNIT (already named for you "
                    "above if it was resolved — don't ask about it again unless the teacher says "
                    "otherwise) and WHAT THE WEEK IS ABOUT — an anchor text, a skill, or a specific "
                    "focus. If that's genuinely missing, ask for it instead of building. Building a week "
                    "off a one-line request wastes the teacher's time correcting a plan they never "
                    "described."
                )

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
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.post("/decisions")
@limiter.limit("30/minute")
def decisions(req: DecisionsRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Voice mode's card stack — see llm.extract_decisions for why this isn't
    gated by require_entitlement: it's a visual aid over an ALREADY-gated
    conversation, not a plan generation in its own right."""
    msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    return {"decisions": llm.extract_decisions(user_id, msgs)}


@router.post("/revise_day")
@limiter.limit("20/minute")
def revise_day(req: ReviseDayRequest, request: Request, user_id: str = Depends(get_current_user)):
    """Rewrite one day — or one cell of it — AND rebuild the .docx, so the file
    matches what's on screen."""
    require_entitlement(user_id)
    return service.revise_day(user_id, req.plan_id, req.day_index, req.feedback, req.field)


@router.post("/chats/{chat_id}/messages")
def add_message(chat_id: str, body: dict, user_id: str = Depends(get_current_user)):
    role = body.get("role")
    if role not in ("user", "assistant", "system"):
        raise AppError("bad_role", f"Unknown message role {role!r}.", status=400)
    if not db.get_chat(user_id, chat_id):
        raise AppError("chat_not_found", "No such chat.", status=404)
    return db.add_message(chat_id, role, str(body.get("content") or ""), body.get("plan_id"))
