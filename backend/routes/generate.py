"""Lesson-plan generation, including the SSE stream."""
from __future__ import annotations

import json
import logging

import openai
from fastapi import APIRouter, BackgroundTasks, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import db, llm, schoolcal, service
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


def _with_week(query: str, week_number: int | None) -> str:
    if week_number is None:
        return query
    week = next((w for w in schoolcal.school_weeks() if w["week"] == week_number), None)
    if not week:
        return query
    return f"Build this for {schoolcal.label_for(week)}. {query}"

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatStreamRequest(BaseModel):
    messages: list[ChatMessage]
    mode: str = "brainstorm" # can be 'interview', 'standards', etc.


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
    query = _with_week(req.query, req.week_number)
    return service.generate(user_id, query, chat_id=req.chat_id, bg_tasks=bg_tasks)


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
    query = _with_week(req.query, req.week_number)

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
            for delta in llm.stream_plan(user_id, query, result):
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
            s = db.get_settings_row(user_id)
            subject = s.get("subject", "AP Language & Composition")
            grade = s.get("grade", "11")

            system_prompt = (
                f"You are an expert curriculum brainstorming assistant for {subject} (Grade {grade}). "
                "The teacher is preparing to generate or revise a weekly lesson plan. "
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
                    "already told you or already picked from a previous round — build on what they gave you."
                )
            
            messages = [{"role": "system", "content": system_prompt}]
            messages.extend([{"role": msg.role, "content": msg.content} for msg in req.messages])
            
            for event in llm.stream_chat(user_id, messages):
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
