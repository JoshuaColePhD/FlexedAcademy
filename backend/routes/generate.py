"""Lesson-plan generation, including the SSE stream."""
from __future__ import annotations

import json
import logging

import openai
from fastapi import APIRouter, BackgroundTasks, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import curriculum, db, llm, schoolcal, service
from ..config import settings
from ..deps import get_current_user
from ..entitlement import require_entitlement
from ..errors import AppError
from ..schema import SchemaError

log = logging.getLogger("aplang.generate")
router = APIRouter(prefix="/api", tags=["generate"])


class GenerateRequest(BaseModel):
    query: str = Field(min_length=1, max_length=settings.max_query_chars)
    chat_id: str | None = None
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
def generate(req: GenerateRequest, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    require_entitlement(user_id)
    # Resolved once, from the chat this generation belongs to (see
    # _chat_class) — used for the week label below AND threaded through to
    # service.generate so llm.generate_plan names the same school, not
    # whatever get_user_school(user_id) would answer on its own.
    cls = _chat_class(user_id, req.chat_id)
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
    )


@router.post("/generate_stream")
def generate_stream(req: GenerateRequest, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    """Stream tokens, then emit the finished plan.

    Every terminal event carries an `error` object with the same {code, message,
    hint} shape as the REST errors, so the client has one path for both.
    """
    # Before the stream opens, so a blocked request is an ordinary 402 with the
    # normal error envelope rather than an SSE frame the reader has to special-
    # case. useLessonStream already reads a non-200 body through apiErrorFromBody.
    require_entitlement(user_id)
    cls = _chat_class(user_id, req.chat_id)
    school_id = db.class_school(cls, user_id)
    query = _with_week(req.query, req.week_number, school_id)

    def event_stream():
        chunks: list[str] = []
        try:
            result = service.prepare(user_id, query)
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
            for delta in llm.stream_plan(user_id, query, result, school_id=school_id):
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


@router.post("/chat_stream")
def chat_stream(req: ChatStreamRequest, user_id: str = Depends(get_current_user)):
    """Stream a standard conversational response, not a JSON schema."""
    require_entitlement(user_id)

    def event_stream():
        try:
            # We construct a system prompt based on the user's settings and chosen mode.
            #
            # Prefer the class this chat actually belongs to over
            # get_settings_row(user_id) — see _chat_class's own docstring.
            cls = _chat_class(user_id, req.chat_id)

            if cls:
                subject = cls["subject"]
                grade = cls["grade"]
            else:
                s = db.get_settings_row(user_id)
                subject = s.get("subject", "AP Language & Composition")
                grade = s.get("grade", "11")

            # class_school, not get_user_school directly — a class pinned to
            # a different school than the account default (migration 25)
            # gets its OWN calendar named here, not the account's. Was
            # "independent of cls" until school stopped being account-only.
            school_id = db.class_school(cls, user_id)

            system_prompt = (
                f"You are an expert curriculum brainstorming assistant for {subject} (Grade {grade}). "
                "The teacher is preparing to generate or revise a weekly lesson plan. "
            )

            # ChatPage already resolves effectiveWeek client-side and even says it
            # aloud in the empty chat's own greeting ("I'll build Week 03…") — but
            # never sent it here, so this conversational model had no idea, and
            # could ask the teacher which week it was for right after the UI had
            # just told them. Resolved the same way generate_stream's _with_week
            # does: looked up in schoolcal.school_weeks(), never guessed, and
            # silently skipped if the number doesn't match a real week.
            week_row = None
            if req.week_number is not None:
                week_row = next(
                    (w for w in schoolcal.school_weeks(school_id) if w["week"] == req.week_number), None
                )

            if week_row:
                system_prompt += f"\n\nTHE TEACHER IS CURRENTLY WORKING ON {schoolcal.label_for(week_row)}"
                # Cross-referenced against the teacher's OWN uploaded pacing guide —
                # not units.unit_for_week()'s hardcoded AP-Lang-only 9-unit map,
                # which falls back to a bare "Week N" for every other subject and
                # is meant for labeling an already-built plan, not for telling this
                # model what's coming up in a subject it has no map for.
                unit_row = curriculum.unit_for_calendar_week(user_id, subject, week_row)
                if unit_row:
                    system_prompt += f", which their own pacing guide names as {unit_row['unit']}"
                system_prompt += (
                    ". Treat the week"
                    + (" and unit" if unit_row else "")
                    + " as already settled — don't ask which one this is unless the "
                    "teacher's own message clearly means a different week."
                )

            # The pacing guide a teacher uploads in settings was only ever read
            # by the plan-WRITING calls (llm.generate_plan / stream_plan) — this
            # conversational model had no path to it at all, so a teacher who
            # said "I attached my pacing guide" got "I don't have access to your
            # settings or any attachments", true of the code but wrong about the
            # product: the document exists and the plan writer already uses it.
            # Queried on the latest user turn, same as plan generation queries on
            # a single string rather than the whole transcript.
            last_user = next(
                (m.content for m in reversed(req.messages) if m.role == "user"), ""
            )
            map_context = llm.map_context_for(user_id, subject, last_user) if last_user else ""
            if map_context:
                system_prompt += (
                    "\n\nTHE TEACHER'S OWN CURRICULUM MAP / PACING GUIDE — relevant excerpts below. "
                    "Use it to ground this conversation in their actual sequencing, unit, and any texts "
                    "or milestones it names. It carries no standard codes of its own; when the plan is "
                    "built, standards still come only from retrieval, not from this document.\n\n"
                    + map_context
                )

            # Same field llm.py's plan-writing prompts read (settings page,
            # like Claude's own custom instructions) — appended once here,
            # mode-agnostically, since none of the three modes below have any
            # retrieval-grounding language for it to need to sit after.
            custom_instructions = llm.custom_instructions_for(user_id)
            if custom_instructions:
                system_prompt += (
                    "\n\nTEACHER'S GLOBAL CUSTOM INSTRUCTIONS — style/format preferences only:\n\n"
                    + custom_instructions
                )

            if req.mode == "interview":
                system_prompt += (
                "Your job is to INTERVIEW the teacher to figure out what they want to teach. "
                "Ask inquisitive, guiding questions one at a time. Be conversational, exactly like Claude does when asked to interview a user. "
                "When you have enough information to build the 5-day week, call the `generate_lesson_plan` tool."
                )
            elif req.mode == "standards":
                system_prompt += (
                    "Your job is to help the teacher find the perfect academic standards for their upcoming week. "
                    "Suggest broad topics and narrow down what standards they should focus on. "
                    "When they are ready to build the plan, call the `generate_lesson_plan` tool."
                )
            else:
                system_prompt += (
                    "Have a natural back-and-forth conversation to brainstorm ideas for their upcoming week, or discuss revisions to an existing week. "
                    "Keep your responses concise and helpful. "
                    "When you have enough information and the user is ready to build or revise the plan, call the `generate_lesson_plan` tool. "
                    "If their most recent message is genuinely too vague to act on — a new request like \"I want to "
                    "make a lesson\" with no text, topic, or skill named, a brainstorming reply that doesn't narrow "
                    "anything down, or a revision ask like \"can you change Thursday?\" with no hint of how — call "
                    "`ask_clarifying_questions` INSTEAD, with 2-4 short questions and a few clickable options each. "
                    "This isn't limited to the first message of a request: reach for it again later in the same "
                    "conversation if a later turn is just as vague, but never re-ask about something the teacher "
                    "already told you or already picked from a previous round — build on what they gave you.\n\n"
                    "Hold the line on having an actual plan before you build one: `generate_lesson_plan` needs "
                    "WHICH WEEK OR UNIT and WHAT THE WEEK IS ABOUT (an anchor text, a skill, or a specific "
                    "focus). If the week/unit was already named for you above, treat that half as settled — "
                    "don't ask about it again unless the teacher's own message clearly points at a different "
                    "week. WHAT THE WEEK IS ABOUT is a separate question that is almost never answered for "
                    "you; missing that, ask rather than build — a week generated from a one-line request "
                    "costs the teacher more time correcting it than answering one question would have."
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
def decisions(req: DecisionsRequest, user_id: str = Depends(get_current_user)):
    """Voice mode's card stack — see llm.extract_decisions for why this isn't
    gated by require_entitlement: it's a visual aid over an ALREADY-gated
    conversation, not a plan generation in its own right."""
    msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    return {"decisions": llm.extract_decisions(user_id, msgs)}


@router.post("/revise_day")
def revise_day(req: ReviseDayRequest, user_id: str = Depends(get_current_user)):
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
